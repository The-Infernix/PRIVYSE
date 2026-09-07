"""VLM prompt templates — build plan §1d.

Kept separate from app.py so prompt iteration never touches serving logic.
"""

SYSTEM_PROMPT = """You are the decision layer of an autonomous browser agent. You receive ONE screenshot of a web page plus a compact DOM snapshot, and you return ONE JSON object describing the single next action that moves the task TOWARD ITS GOAL. You never write prose, never explain, never use markdown.

OUTPUT FORMAT (return exactly this shape, nothing else):
{"thought": "<short reason>", "action": <one action object>, "done": false, "subgoal": "<short what you are trying to achieve right now>", "blocked": <true/false>}

- "subgoal": the immediate sub-goal this step advances (e.g. "open search results"). Use it to keep yourself on track across steps.
- "blocked": true ONLY when this step could not happen because of an obstacle (login wall, permission dialog, paywall, page error, missing element) AND you need to change approach rather than repeat. Otherwise false.
- "done": true ONLY when the overall task is fully complete.

LENGTH BUDGET (CRITICAL): "thought" max 8 words, "subgoal" max 5 words. The ENTIRE reply stays under 45 tokens. Never add prose after the JSON.

ACTION OBJECTS (use the fields the type needs; omit the rest):
{"type": "click",    "target": 5}
{"type": "type",     "target": 5, "text": "zombie reddy 2 trailer"}
{"type": "press",    "key": "enter"}
{"type": "scroll",   "direction": "down", "amount": 600}
{"type": "navigate", "url": "https://example.com"}
{"type": "wait",     "ms": 800}
{"type": "extract",  "text": "the error message"}
{"type": "done",     "answer": "optional final answer"}

THE NUMBERED TAGS: the DOM snapshot lists elements like:
  [7] <input> role=textbox text="Search" label="search"
The "7" is the element's id and is drawn as a numbered tag "[7]" on the screenshot. ALWAYS use the plain integer (7), never the string "[7]" and never the word "search".

TARGET RULE: "target" is ALWAYS a plain integer copied from the [N] tag. It is NEVER a word, NEVER the task text, NEVER in brackets.

SEARCHING: to search for something, do it in three steps:
  1. click the search box (its numeric id)
  2. type into that same numeric id with the phrase in "text"
  3. press enter
Never put the search phrase in "target".

BLOCKER RECOVERY — CRITICAL BEHAVIOUR:
You are a resilient agent, not a rigid script. When a step is blocked, DO NOT repeat the same action. Instead adapt:
- If you tried to open a specific URL but are blocked by a login wall, switch approach: navigate to the site's search/home page and search for the content instead.
- If a target element is missing, scroll, wait briefly, or navigate to an equivalent page.
- If a dialog/permission prompt blocks, scroll past it, navigate elsewhere, or wait, rather than looping.
- Change subgoal, change the element, change the URL — never fire the identical failing action twice.

Redaction legend: [EMAIL_N], [PHONE_N], [AADHAAR_N], [PAN_N], [CARD_N], [NAME_N], [ADDRESS_N] are placeholders for redacted personal data — reason about their position, never ask the user to reveal them. [SECRET] fields are passwords — never interact past them.

Rules:
1. Prefer clicking/typing a visible target over scrolling.
2. done=true only when the task is complete.
3. If nothing useful is visible, scroll down.
4. When blocked, produce a DIFFERENT action than the one that just failed.
"""

# Compact variant — same behaviour, ~60% fewer tokens. Prefill time on the local
# CPU-bound 7b scales with prompt tokens, so a shorter system prompt buys
# seconds per step. Select via SYSTEM_PROMPT_MODE=compact (default full).
SYSTEM_PROMPT_COMPACT = """Browser agent decision layer. Return EXACTLY one JSON object, nothing else:
{"thought": "<short reason>", "action": <one action>, "done": false, "subgoal": "<short aim>", "blocked": <bool>}
LENGTH BUDGET (CRITICAL): "thought" max 8 words, "subgoal" max 5 words. The ENTIRE reply stays under 45 tokens. Never add prose after the JSON.
A "subgoal" states what this step advances; "blocked": true only when an obstacle (login wall, permission dialog, missing element, page error) forces a strategy change; "done": true only when the whole task is complete.

Actions (use only the fields a type needs):
{click,target} {"type":"click","target":5}
{type,target,text} {"type":"type","target":5,"text":"hello"}
{key} {"type":"press","key":"enter"}
{direction,amount} {"type":"scroll","direction":"down","amount":600}
{url} {"type":"navigate","url":"https://... "}
{ms} {"type":"wait","ms":800}
{text} {"type":"extract","text":"the error message"}
{answer} {"type":"done","answer":"optional final answer"}

DOM snapshot lists elements as "[7] <input> text=\"...\" label=\"...\"" and the same "7" is drawn on the screenshot. TARGET RULE: "target" is ALWAYS the plain integer id from the [N] list — never a word, never the task text, never "[7]".

To type, first click the field's numeric id, then type into that same id. To search: click the search box, type the phrase, press enter.

Redaction legend: [EMAIL_N], [PHONE_N], [AADHAAR_N], [PAN_N], [CARD_N], [NAME_N], [ADDRESS_N] = redacted personal data — reason about their position, never ask the user to reveal them. [SECRET] = password — never interact past it.

If a step is blocked or an action fails, DO NOT repeat it: change strategy (new element, scroll, or navigate). Prefer clicking/typing a visible target over scrolling. done=true only when the task is actually complete."""

def select_system_prompt() -> str:
    """Choose the system prompt: SYSTEM_PROMPT_MODE=compact for the shorter one."""
    import os
    return SYSTEM_PROMPT_COMPACT if os.getenv("SYSTEM_PROMPT_MODE", "full") == "compact" else SYSTEM_PROMPT


def build_user_content(
    task: str,
    screenshot_b64: str,
    dom: list[dict],
    history: list[dict],
    lessons: list[str] | None = None,
    warnings: list[str] | None = None,
    verified_targets: list[dict] | None = None,
) -> list[dict]:
    """Build the user message content array for the VLM.

    Returns a list of content parts (text + image) for the OpenAI-compatible API.
    """
    parts: list[dict] = []

    # Image
    parts.append({
        "type": "image_url",
        "image_url": {"url": f"data:image/jpeg;base64,{screenshot_b64}"},
    })

    # Text context
    lines = [f"Task: {task}"]

    # Persisted warnings — actions already tried that did NOT work. This is the
    # agent's within-run memory: without it the model re-fires the same action.
    if warnings:
        lines.append("\n⚠ DO-NOT-REPEAT list (you already tried these and they did NOT work):")
        for w in warnings[-8:]:
            lines.append(f"  • {w}")
        lines.append("NEVER repeat the exact actions above. Pick a different target, different element, or different strategy.")

    # Deterministic executor findings — the agent already verified these
    # element ids actually work. The VLM must use the id VERBATIM, never
    # re-guess a wrapper element. (Borrowed from clicky-windows.)
    if verified_targets:
        lines.append("\nDETECTED ELEMENTS (verified by the executor — use VERBATIM, do NOT re-guess):")
        for vt in verified_targets[:8]:
            lines.append(f"  target #{vt.get('id')} = {vt.get('desc', '')}  → if you act on this element, use exactly this integer id.")

    # Learned lessons from previous runs on this site (verified only).
    if lessons:
        lines.append("\nLearned lessons from prior runs (these are CORRECT):")
        for lesson in lessons[:8]:
            lines.append(f"  • {lesson}")

    if history:
        lines.append("\nPrevious steps:")
        for i, h in enumerate(history[-6:], 1):
            action_str = h.get("action", {})
            result = h.get("result", "")
            subgoal = h.get("subgoal")
            blocked = h.get("blocked")
            suffix = ""
            if subgoal:
                suffix += f" (subgoal: {subgoal})"
            if blocked:
                suffix += " [BLOCKED — adapt!]"
            lines.append(f"  {i}. {action_str} → {result}{suffix}")

    if dom:
        lines.append(f"\nDOM elements ({len(dom)} total):")
        for el in dom[:40]:  # cap to keep prompt small and fast
            val = f' value="{el.get("value", "")}"' if el.get("value") else ""
            lines.append(
                f'  [{el["id"]}] <{el["tag"]}> role={el["role"]}'
                f' text="{el.get("text", "")[:50]}"'
                f' label="{el.get("label", "")[:30]}"{val}'
            )
    else:
        lines.append("\n(No DOM elements captured)")

    lines.append(
        "\nREMINDER: return ONE JSON object only — nothing after it. "
        '"target" is a plain integer id from the [N] list — '
        'never a word, never the task text, never "[7]". '
        'Include "subgoal" and "blocked". Keep "thought" <= 8 words, "subgoal" <= 5 words.'
    )

    parts.append({"type": "text", "text": "\n".join(lines)})
    return parts


def build_rethink_content(
    task: str,
    screenshot_b64: str,
    dom: list[dict],
    history: list[dict],
    warnings: list[str] | None = None,
    verified_targets: list[dict] | None = None,
) -> list[dict]:
    """Build content for the /rethink endpoint: force an alternative plan after
    the agent reports it is stuck or blocked.

    The VLM has been repeating itself. We ask it to STOP and propose a genuinely
    different approach rather than firing the same failing action.
    """
    parts: list[dict] = []

    parts.append({
        "type": "image_url",
        "image_url": {"url": f"data:image/jpeg;base64,{screenshot_b64}"},
    })

    lines = [
        f"Task: {task}",
        "",
        "You are STUCK. The actions you have tried so far did not complete the task.",
        "Do NOT repeat any of them. STOP and think of a genuinely different approach.",
        "",
    ]

    # The do-not-repeat list is the critical context here — without it the model
    # simply re-fires the same failing action.
    if warnings:
        lines.append("⚠ DO-NOT-REPEAT list (you already tried these and they did NOT work):")
        for w in warnings[-8:]:
            lines.append(f"  • {w}")
        lines.append("")

    if verified_targets:
        lines.append("DETECTED ELEMENTS (verified by the executor — use VERBATIM, do NOT re-guess):")
        for vt in verified_targets[:8]:
            lines.append(f"  target #{vt.get('id')} = {vt.get('desc', '')}  → if you act on this element, use exactly this integer id.")
        lines.append("")

    lines.append("History of what you already tried:")
    lines.append("")
    for i, h in enumerate(history[-8:], 1):
        action_str = h.get("action", {})
        result = h.get("result", "")
        lines.append(f"  {i}. {action_str} → {result}")

    lines += [
        "",
        "Your previous approach did not work. Pick ONE new action from a DIFFERENT",
        "angle. Examples of changing strategy:",
        "  - If blocked by a login wall, navigate to the site's public search/home page",
        "    (use 'navigate' with the home URL) and search for the content there instead.",
        "  - If targeting a missing element, scroll, wait, or load an equivalent page.",
        "  - If a dialog blocks, wait for it to dismiss, then continue.",
        "  - NEVER return a bare wait action just to stall. If you are stuck, NAVIGATE",
        "    or CLICK a different target — a wait is not a plan.",
        "",
        "Return exactly ONE JSON object of the same shape as before with a NEW action,",
        'a "subgoal" describing your new plan, and "blocked": true only if you are still',
        "stuck (otherwise false). Set done=true only if the task is now truly complete.",
    ]

    if dom:
        lines.append(f"\nDOM elements ({len(dom)} total):")
        for el in dom[:40]:
            val = f' value="{el.get("value", "")}"' if el.get("value") else ""
            lines.append(
                f'  [{el["id"]}] <{el["tag"]}> role={el["role"]}'
                f' text="{el.get("text", "")[:50]}"'
                f' label="{el.get("label", "")[:30]}"{val}'
            )

    lines.append(
        "\nREMINDER: 'target' is a plain integer id from the [N] list. "
        "Pick a DIFFERENT action than the ones already tried."
    )

    parts.append({"type": "text", "text": "\n".join(lines)})
    return parts
