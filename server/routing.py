"""Perception-driven VLM triage (PS §1): the on-device MobileViT picks the
cheapest adequate model per step — it already classified the visible screen
before anything was uploaded, so the server can route on that signal for free.

Rules (all conservative):
  * An explicit client `model` in the /act request always wins (operator override).
  * Routing is OFF unless PERCEPTION_ROUTING=1 (default ON, but a no-op unless
    at least one of VLM_MODEL_SMALL / VLM_MODEL_BIG is set):
      - complex visuals (photo / document / uncertain tiles, non-DOM escalation,
        possible CAPTCHA)            -> VLM_MODEL_BIG   (default: current model)
      - everything else (ui/data/blank) -> VLM_MODEL_SMALL (default: current model)
  * No perception map, or a disabled one  -> default model (never a downgrade).
  * A missing SMALL/BIG env var falls back to the operator default, so routing
    can never silently run a model the operator did not opt into.

`router_choose` is a pure function (no I/O) so the bench/unit tests can drive it.
"""

import os


def perception_complexity(screen_perception: dict | None) -> int:
    """0 = DOM-like/simple for the small model; >0 = visually complex/ambiguous."""
    if not screen_perception or not screen_perception.get("enabled"):
        return 0
    summary = screen_perception.get("summary") or {}
    n = 0
    for tag in ("photo", "document", "uncertain"):
        n += int(summary.get(tag) or 0)
    decisions = screen_perception.get("decisions") or {}
    if decisions.get("escalate"):
        n += 1  # redacted non-DOM graphics -> the big model should reason about the layout
    if decisions.get("captchaLike"):
        n += 1  # possible CAPTCHA -> never automate the checkbox on a small model
    return n


def router_choose(
    req_model: str | None,
    screen_perception: dict | None,
    *,
    small: str | None = None,
    big: str | None = None,
    enabled: bool | None = None,
) -> str | None:
    """Return a routed model name, or None to keep the caller's default.

    Env is resolved at call time (not import time) so tests and dev can override
    without a process restart.
    """
    small = small if small is not None else os.getenv("VLM_MODEL_SMALL")
    big = big if big is not None else os.getenv("VLM_MODEL_BIG")
    routing_on = os.getenv("PERCEPTION_ROUTING", "1") == "1" if enabled is None else enabled
    if req_model or not routing_on or not screen_perception or not screen_perception.get("enabled"):
        return None
    if perception_complexity(screen_perception) > 0:
        return big or None
    return small or None