"""SIH 26171 — agent server.

Connects to a local Ollama instance (OpenAI-compatible API) for VLM inference.
The VLM receives a sanitized screenshot + DOM snapshot and returns a structured
action for the browser extension to execute.

Usage:
    # 1. Start Ollama with a vision model
    ollama pull llava:7b
    ollama serve

    # 2. Start this server
    uvicorn app:app --host 127.0.0.1 --port 8000 --reload

    # 3. Optionally override the model via env:
    #    VLM_MODEL=qwen2.5vl:7b  (or llava:7b, etc.)
"""

import json
import os
import re
import logging
import time
from typing import Annotated, Literal, Optional, Union

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from openai import OpenAI
from prompts import SYSTEM_PROMPT, build_user_content, build_rethink_content, select_system_prompt
import io

try:
    from PIL import Image as PILImage
    _HAS_PIL = True
except Exception:  # noqa: BLE001
    _HAS_PIL = False

logger = logging.getLogger("sih26171")

PROTOCOL_VERSION = 1

# ---------------------------------------------------------------------------
# VLM client — points at Ollama's OpenAI-compatible endpoint
# ---------------------------------------------------------------------------
VLM_MODEL = os.getenv("VLM_MODEL", "qwen2.5vl:3b")
OLLAMA_BASE = os.getenv("OPENAI_BASE_URL", "http://127.0.0.1:11434/v1")

vlm_client = OpenAI(
    base_url=OLLAMA_BASE,
    api_key="ollama",  # Ollama doesn't need a real key
    timeout=120.0,
    max_retries=0,
)


def check_vlm_alive() -> bool:
    """Return True if the VLM backend responds to a lightweight request."""
    try:
        import json
        import urllib.request
        req = urllib.request.Request(f"{OLLAMA_BASE}/models", method="GET")
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            return resp.status == 200
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Action protocol — mirrors extension/core/protocol.ts (frozen at v1)
# ---------------------------------------------------------------------------

class ClickAction(BaseModel):
    type: Literal["click"]
    target: int


class TypeAction(BaseModel):
    type: Literal["type"]
    target: int
    text: str


class PressAction(BaseModel):
    type: Literal["press"]
    key: str


class ScrollAction(BaseModel):
    type: Literal["scroll"]
    direction: Literal["up", "down"]
    amount: Optional[int] = 600


class NavigateAction(BaseModel):
    type: Literal["navigate"]
    url: str


class WaitAction(BaseModel):
    type: Literal["wait"]
    ms: int


class ExtractAction(BaseModel):
    type: Literal["extract"]
    text: str


class DoneAction(BaseModel):
    type: Literal["done"]
    answer: Optional[str] = None


Action = Annotated[
    Union[
        ClickAction,
        TypeAction,
        PressAction,
        ScrollAction,
        NavigateAction,
        WaitAction,
        ExtractAction,
        DoneAction,
    ],
    Field(discriminator="type"),
]


class DomElement(BaseModel):
    id: int
    tag: str
    role: str
    text: str
    label: str
    bbox: tuple[float, float, float, float]
    value: Optional[str] = None


class HistoryStep(BaseModel):
    action: Action
    result: str


class VerifiedTarget(BaseModel):
    id: int
    desc: str


# ---------------------------------------------------------------------------
# Screenshot size control — the VLM prompt floor for image tokens is ~1024
# (~1.3k prompt tokens regardless of resolution), but a smaller JPEG ships
# fewer bytes over HTTP and costs a little less in early vision layers. Cap the
# longest side to IMAGE_MAX_SIDE while preserving aspect ratio. Disabled when
# 0. Requires Pillow; silently skipped otherwise.
# ---------------------------------------------------------------------------

IMAGE_MAX_SIDE = int(os.getenv("IMAGE_MAX_SIDE", "800"))

def resize_screenshot(b64: str) -> str:
    if not _HAS_PIL or IMAGE_MAX_SIDE <= 0 or not b64:
        return b64
    try:
        raw = __import__("base64").b64decode(b64)
        im = PILImage.open(io.BytesIO(raw)).convert("RGB")
        w, h = im.size
        longest = max(w, h)
        if longest <= IMAGE_MAX_SIDE:
            return b64
        scale = IMAGE_MAX_SIDE / longest
        im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), PILImage.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=80)
        return __import__("base64").b64encode(buf.getvalue()).decode("ascii")
    except Exception as e:  # noqa: BLE001
        logger.warning("resize_screenshot failed: %s", e)
        return b64


class ActRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    task: str
    history: list[HistoryStep] = []
    screenshot_b64: str
    dom: list[DomElement] = []
    # Optional model override (e.g. "qwen2.5vl:3b"). Falls back to VLM_MODEL.
    model: Optional[str] = None
    # Verified lessons learned on this site in previous runs.
    lessons: list[str] = []
    # Within-run memory: actions already tried that failed or repeated without
    # progress. Injected into the prompt so the model never re-fires them.
    warnings: list[str] = []
    # Deterministic executor findings (auto-descended inputs, verified targets).
    # Injected as "use verbatim" so the VLM targets the known-good element.
    # Alias matches the TS protocol's camelCase field on the wire.
    verified_targets: list[VerifiedTarget] = Field(default_factory=list, alias="verifiedTargets")


class ActResponse(BaseModel):
    thought: str
    action: Action
    done: bool
    # Adaptive loop: the model's stated sub-goal for this step (kept in history
    # so the agent stays on track) and whether this step was blocked (triggers
    # the recovery/rethink path instead of the loop running out of steps).
    subgoal: Optional[str] = None
    blocked: Optional[bool] = False


# /rethink is today's version of our "ask what to do next + if it doesn't work,
# plan how to proceed" — it forces the VLM to produce a DIFFERENT action after a
# stuck/blocked signal, so the agent keeps trying with a new plan instead of
# stopping. Modernized naming: Rethink (alternative strategy) endpoint.
RETHINK_SYSTEM_PROMPT = (
    "You are the fallback planner for a browser automation agent that is stuck. "
    "Return ONE JSON object of the same shape as /act: "
    '{"thought": "...", "action": <one action>, "done": false, "subgoal": "...", "blocked": true/false}. '
    'You MUST choose a DIFFERENT action than anything in the provided history. '
    "Prefer changing strategy (new URL, new element, search instead of direct URL) "
    "over repeating a failing action. Never use markdown or prose outside the JSON."
)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="SIH 26171 Agent Server", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_vlm_ok: bool | None = None  # cached health, refreshed on /health


# ---------------------------------------------------------------------------
# Test site (ground-truth PII pages for benchmarking + agent demo tasks)
# ---------------------------------------------------------------------------

_TEST_SITE_DIR = Path(__file__).resolve().parent.parent / "test-site"
if _TEST_SITE_DIR.is_dir():
    app.mount(
        "/test-site",
        StaticFiles(directory=str(_TEST_SITE_DIR), html=True),
        name="test-site",
    )


@app.get("/health")
def health():
    global _vlm_ok
    _vlm_ok = check_vlm_alive()
    return {
        "status": "ok",
        "protocol_version": PROTOCOL_VERSION,
        "vlm_connected": _vlm_ok,
        "vlm_model": VLM_MODEL,
        "vlm_endpoint": OLLAMA_BASE,
        "prompt_ready": bool(SYSTEM_PROMPT),
    }


# ---------------------------------------------------------------------------
# VLM call + JSON parsing
# ---------------------------------------------------------------------------

def call_vlm(user_content: list[dict], model: str | None = None, system_prompt: str | None = None) -> str:
    """Send a chat completion request to the VLM and return the raw text."""
    model = model or VLM_MODEL
    sp = system_prompt or select_system_prompt()
    # moondream's Ollama instruct template IGNORES the system role — fold the
    # system prompt into a leading user text part so the tuned model actually
    # sees the JSON action contract. qwen keeps the native system message.
    if model.split(":")[0].startswith("moondream"):
        messages: list[dict] = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": sp},
                    *user_content,
                ],
            },
        ]
    else:
        messages = [
            {"role": "system", "content": sp},
            {"role": "user", "content": user_content},
        ]
    resp = vlm_client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0,
        max_tokens=int(os.getenv("VLM_MAX_TOKENS", "128")),
        extra_body={
            # Keep the model resident between steps (cold loads cost 20–60s).
            "keep_alive": "-1",
        },
    )
    return resp.choices[0].message.content or ""


def parse_action_json(raw: str) -> dict | None:
    """Extract a JSON object from the VLM response, tolerating markdown fences."""
    # Strip markdown code fences if present
    cleaned = raw.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        obj = json.loads(cleaned)
        if "action" in obj:
            return obj
    except json.JSONDecodeError:
        pass

    # Try to find a JSON object in the text
    match = re.search(r"\{[\s\S]*\"action\"[\s\S]*\}", raw)
    if match:
        try:
            obj = json.loads(match.group())
            if "action" in obj:
                return obj
        except json.JSONDecodeError:
            pass

    return None


def normalize_action(action_data: dict | None) -> dict | None:
    """Unwrap occasionally nested action objects from weak VLM outputs."""
    if not isinstance(action_data, dict):
        return None
    if isinstance(action_data.get("type"), dict):
        action_data = action_data["type"]
    if not isinstance(action_data.get("type"), str):
        return None
    return action_data


def resolve_target(raw, dom: list[dict]) -> int | None:
    """Coerce a VLM 'target' into a real element id.

    Accepts plain ints, "[7]", "7", and loose word matches against the DOM
    snapshot. Returns None when the target can't be mapped to any element.
    """
    if isinstance(raw, int):
        return raw
    if not isinstance(raw, str):
        return None
    s = raw.strip().strip("[]").strip("'\"`").strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    needle = s.lower()
    best: int | None = None
    best_rank = 99
    for el in dom:
        hay = " ".join(
            str(el.get(k, "") or "").lower()
            for k in ("label", "text", "role", "tag")
        )
        if needle not in hay:
            continue
        rank = _match_rank(el)
        if rank < best_rank:
            best_rank = rank
            best = el["id"]
    return best


def _match_rank(el: dict) -> int:
    """Rank how likely an element is the intended text target."""
    tag = str(el.get("tag", "")).lower()
    role = str(el.get("role", "")).lower()
    if tag in ("input", "textarea", "select") or role in ("textbox", "combobox", "searchbox"):
        return 0
    if tag in ("button", "a") or role in ("button", "link"):
        return 1
    return 2


def build_response_from_raw(raw: str, dom: list[dict]) -> ActResponse:
    """Parse + validate a raw VLM response into an ActResponse (or raise).

    Raises ValueError so callers (non-streamed retry loop, stream endpoint)
    can decide whether to retry or return a fallback.
    """
    parsed = parse_action_json(raw)
    if parsed is None:
        raise ValueError("response was not valid JSON")

    action_data = normalize_action(parsed.get("action"))
    if action_data is None:
        raise ValueError("'action' is missing or has no string 'type'")

    valid_types = {"click", "type", "press", "scroll", "navigate", "wait", "extract", "done"}
    action_type = action_data["type"]
    if action_type not in valid_types:
        raise ValueError(f"invalid action type '{action_type}'")

    # Coerce click/type targets onto the DOM registry
    if action_type in ("click", "type") and "target" in action_data:
        resolved = resolve_target(action_data["target"], dom)
        if resolved is None:
            raise ValueError(
                f"target {action_data['target']!r} does not match any DOM element id"
            )
        action_data["target"] = resolved

    return ActResponse.model_validate({
        "thought": parsed.get("thought", ""),
        "action": action_data,
        "done": parsed.get("done", False),
        "subgoal": parsed.get("subgoal"),
        "blocked": parsed.get("blocked", False),
    })


def build_fix_hint(err: str) -> str:
    return (
        f"Your previous response was rejected: {err}\n"
        'Fix it now. "target" MUST be a plain integer id (like "target": 7) taken '
        "directly from the numbered [N] DOM list. It is NEVER a word, NEVER the "
        'task text, NEVER wrapped in brackets. To type the user\'s phrase into a '
        'field, first click that field\'s numeric id, then "type" with the same '
        'numeric id and the phrase in the "text" field. Output ONLY the JSON object.'
    )


# ---------------------------------------------------------------------------
# Rethink veto — hard guarantee that /rethink never hands back the same action
# the agent already tried. Small VLMs routinely ignore prompt warnings, so this
# is enforced structurally, not just by asking nicely.
# ---------------------------------------------------------------------------

def action_signature(action) -> str:
    """Canonical signature for an action so exact repeats are comparable."""
    if isinstance(action, BaseModel):
        action = action.model_dump()
    if not isinstance(action, dict):
        action = {}
    return json.dumps(action, sort_keys=True, ensure_ascii=False)


def clicked_target_ids(history: list[dict]) -> set[int]:
    """Every element id the agent has already clicked/typed into."""
    ids: set[int] = set()
    for h in history:
        a = h.get("action")
        if not isinstance(a, dict):
            continue
        if a.get("type") in ("click", "type") and isinstance(a.get("target"), int):
            ids.add(a["target"])
    return ids


def build_veto_hint() -> str:
    return (
        "Your previous output was REJECTED: it exactly repeated an action that was ALREADY tried and did not work. "
        'Choose a DIFFERENT "target" integer id, a DIFFERENT action type, or a navigation. '
        '"wait" is also rejected. Output ONLY the JSON object.'
    )


def untried_click_fallback(dom: list[dict], clicked_ids: set[int]) -> ActResponse:
    """Deterministic escape hatch when the model insists on repeating a failing
    action: click the first labelled button/link that was never clicked yet."""
    for el in dom:
        try:
            eid = int(el.get("id", -1))
        except (TypeError, ValueError):
            continue
        if eid in clicked_ids or eid < 0:
            continue
        tag = str(el.get("tag", "")).lower()
        role = str(el.get("role", "")).lower()
        label = str(el.get("label", "") or "").strip()
        if tag in ("button", "a") and label:
            return ActResponse(
                thought=(
                    f"Model kept repeating a failing action despite a do-not-repeat warning; "
                    f"an untried labelled element was auto-picked (id {eid}: {label})."
                ),
                action=ClickAction(type="click", target=eid),
                done=False,
                blocked=True,
            )
    for el in dom:
        try:
            eid = int(el.get("id", -1))
        except (TypeError, ValueError):
            continue
        if eid in clicked_ids or eid < 0:
            continue
        return ActResponse(
            thought="No labelled untried element remains — clicking the first untried element.",
            action=ClickAction(type="click", target=eid),
            done=False,
            blocked=True,
        )
    return ActResponse(
        thought="Every DOM element has already been tried.",
        action=PressAction(type="press", key="escape"),
        done=False,
        blocked=True,
    )


def sse(event: str, data) -> str:
    """Serialize a single Server-Sent-Events frame."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# ---------------------------------------------------------------------------
# POST /act/stream  (SSE) — same contract as /act, but streams tokens so the
# side panel can show the model "thinking" live.
# ---------------------------------------------------------------------------

def _stream_act(user_content: list[dict], model: str, dom_dicts: list[dict], system_prompt: str, forbid_repeat: set[str] | None = None, clicked_ids: set[int] | None = None):
    """Generator for the SSE stream: relay VLM token deltas as "thought" events,
    then the final action. Shared by /act/stream and /rethink/stream.
    If forbid_repeat is given, an action that exactly repeats something already
    tried is replaced by a deterministic untried-element click (rethink veto)."""
    chunks: list[str] = []
    t0 = time.perf_counter()
    try:
        stream = vlm_client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            temperature=0,
            max_tokens=int(os.getenv("VLM_MAX_TOKENS", "128")),
            stream=True,
            extra_body={"keep_alive": "-1"},
        )
        for chunk in stream:
            delta = (chunk.choices[0].delta.content or "") if chunk.choices else ""
            if delta:
                chunks.append(delta)
                yield sse("thought", {"delta": delta})

        raw = "".join(chunks)
        logger.info("VLM stream: %.2fs (%d chars)", time.perf_counter() - t0, len(raw))
        resp = build_response_from_raw(raw, dom_dicts)
        if forbid_repeat and action_signature(resp.action) in forbid_repeat:
            logger.warning("stream vetoed repeated action '%s' during rethink", resp.action.type)
            resp = untried_click_fallback(dom_dicts, clicked_ids or set())
        logger.info(
            "stream resolved: action=%s target=%s blocked=%s",
            resp.action.type,
            getattr(resp.action, "target", "-"),
            resp.blocked,
        )
        yield sse("action", resp.model_dump())
    except Exception as e:  # noqa: BLE001
        logger.error("VLM stream failed: %s", e)
        fallback = ActResponse(
            thought=f"stream error: {e}",
            action=WaitAction(type="wait", ms=2000),
            done=False,
        )
        yield sse("error", {"message": str(e)})
        yield sse("action", fallback.model_dump())


@app.post("/act/stream")
def act_stream(req: ActRequest):
    task = req.task
    dom_dicts = [el.model_dump() for el in req.dom]
    history_dicts = [h.model_dump() for h in req.history]
    model = req.model or VLM_MODEL
    screenshot_b64 = resize_screenshot(req.screenshot_b64)

    user_content = build_user_content(
        task=task,
        screenshot_b64=screenshot_b64,
        dom=dom_dicts,
        history=history_dicts,
        lessons=req.lessons,
        warnings=req.warnings,
        verified_targets=[vt.model_dump() for vt in req.verified_targets],
    )

    return StreamingResponse(
        _stream_act(user_content, model, dom_dicts, select_system_prompt()),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/rethink/stream")
def rethink_stream(req: ActRequest):
    """SSE variant of /rethink — forced alternative plan with live thinking."""
    dom_dicts = [el.model_dump() for el in req.dom]
    history_dicts = [h.model_dump() for h in req.history]
    model = req.model or VLM_MODEL
    screenshot_b64 = resize_screenshot(req.screenshot_b64)

    forbid_repeat = {
        action_signature(h.get("action"))
        for h in history_dicts
        if isinstance(h.get("action"), dict)
    }

    user_content = build_rethink_content(
        task=req.task,
        screenshot_b64=screenshot_b64,
        dom=dom_dicts,
        history=history_dicts,
        warnings=req.warnings,
        verified_targets=[vt.model_dump() for vt in req.verified_targets],
    )

    return StreamingResponse(
        _stream_act(
            user_content,
            model,
            dom_dicts,
            RETHINK_SYSTEM_PROMPT,
            forbid_repeat=forbid_repeat,
            clicked_ids=clicked_target_ids(history_dicts),
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# GET /models
# ---------------------------------------------------------------------------

@app.get("/models")
def list_models() -> dict:
    """List the Ollama models the VLM backend currently has available."""
    try:
        ids = sorted(m.id for m in vlm_client.models.list().data)
        return {"models": ids, "default": VLM_MODEL}
    except Exception as e:  # noqa: BLE001
        return {"models": [], "default": VLM_MODEL, "error": str(e)}


# ---------------------------------------------------------------------------
# POST /act
# ---------------------------------------------------------------------------

@app.get("/warm")
def warm(model: str | None = None) -> dict:
    """Force-load a VLM so the first real step doesn't pay a cold-start."""
    started = time.perf_counter()
    try:
        call_vlm([{"type": "text", "text": "ok"}], model=model)
        return {"status": "ok", "vlm_model": model or VLM_MODEL, "loaded_in_s": round(time.perf_counter() - started, 1)}
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "error": str(e)}

def _call_and_parse(user_content: list[dict], model: str | None, dom_dicts: list[dict]) -> ActResponse:
    """Call the VLM and build an ActResponse, retrying once with a fix hint on
    parse/validation failure. Used by both /act and /rethink."""
    for attempt in range(2):
        try:
            t_vlm = time.perf_counter()
            raw = call_vlm(user_content, model=model)
            logger.info(
                "VLM call: %.2fs (attempt %d): %s",
                time.perf_counter() - t_vlm,
                attempt + 1,
                raw[:300],
            )
            resp = build_response_from_raw(raw, dom_dicts)
            return resp
        except Exception as e:  # noqa: BLE001
            logger.error("VLM call failed: %s", e)
            if attempt == 0:
                user_content.append({"type": "text", "text": build_fix_hint(str(e))})
                continue
            return ActResponse(
                thought=f"VLM error after 2 attempts: {e}",
                action=WaitAction(type="wait", ms=2000),
                done=False,
            )
    return ActResponse(
        thought="VLM returned no parseable action.",
        action=WaitAction(type="wait", ms=1000),
        done=False,
    )


@app.post("/act", response_model=ActResponse)
async def act(req: ActRequest) -> ActResponse:
    t_act = time.perf_counter()
    task = req.task
    dom_dicts = [el.model_dump() for el in req.dom]
    history_dicts = [h.model_dump() for h in req.history]
    screenshot_b64 = resize_screenshot(req.screenshot_b64)

    user_content = build_user_content(
        task=task,
        screenshot_b64=screenshot_b64,
        dom=dom_dicts,
        history=history_dicts,
        lessons=req.lessons,
        warnings=req.warnings,
        verified_targets=[vt.model_dump() for vt in req.verified_targets],
    )

    resp = _call_and_parse(user_content, req.model, dom_dicts)
    logger.info(
        "act resolved: action=%s target=%s blocked=%s (total %.2fs)",
        resp.action.type,
        getattr(resp.action, "target", "-"),
        resp.blocked,
        time.perf_counter() - t_act,
    )
    return resp


@app.post("/rethink", response_model=ActResponse)
def rethink(req: ActRequest) -> ActResponse:
    """Force an alternative plan when the agent is stuck or blocked.

    The extension calls this after detecting repeated identical actions or a
    blocked step. Instead of the loop exhausting its step budget, the model is
    asked to pick a genuinely different action so the agent recovers and keeps
    working toward the task. Any action already in history is VETOED structurally
    — a small VLM will ignore a warning, so we hard-reject repeats and, if the
    model insists twice, auto-pick an untried labelled element.
    """
    dom_dicts = [el.model_dump() for el in req.dom]
    history_dicts = [h.model_dump() for h in req.history]
    screenshot_b64 = resize_screenshot(req.screenshot_b64)

    forbidden = {
        action_signature(h.get("action"))
        for h in history_dicts
        if isinstance(h.get("action"), dict)
    }
    clicked_ids = clicked_target_ids(history_dicts)

    user_content = build_rethink_content(
        task=req.task,
        screenshot_b64=screenshot_b64,
        dom=dom_dicts,
        history=history_dicts,
        warnings=req.warnings,
        verified_targets=[vt.model_dump() for vt in req.verified_targets],
    )

    resp = _call_and_parse(user_content, req.model, dom_dicts)
    if action_signature(resp.action) in forbidden:
        user_content.append({"type": "text", "text": build_veto_hint()})
        resp2 = _call_and_parse(user_content, req.model, dom_dicts)
        if action_signature(resp2.action) not in forbidden:
            resp = resp2
        else:
            logger.warning("rethink vetoed twice; using deterministic untried-element fallback")
            resp = untried_click_fallback(dom_dicts, clicked_ids)

    # /rethink must never hand back "done" just to escape the loop; the task
    # isn't complete just because we changed strategy.
    if resp.done:
        resp = ActResponse(
            thought="Rethink called but task not actually complete — continuing.",
            action=WaitAction(type="wait", ms=800),
            done=False,
            blocked=True,
        )
    logger.info("rethink resolved: action=%s target=%s", resp.action.type, getattr(resp.action, "target", "-"))
    return resp

