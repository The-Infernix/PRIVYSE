# Perception-driven VLM routing — pure-function tests (no framework needed).
# Usage: python server/test_routing.py
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from routing import perception_complexity, router_choose  # noqa: E402

os.environ["PERCEPTION_ROUTING"] = "1"
os.environ["VLM_MODEL_SMALL"] = "qwen2.5vl:3b"
os.environ["VLM_MODEL_BIG"] = "qwen2.5vl:7b"
SMALL, BIG = "qwen2.5vl:3b", "qwen2.5vl:7b"


def eq(name, got, want):
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name} — got {got!r}")
    assert ok, name


# simple DOM-like page -> small model
eq("simple page -> small", router_choose(None, {"enabled": True, "summary": {"ui": 4, "blank": 2}, "decisions": {}}), SMALL)
# complex visuals -> big model
eq("photo page -> big", router_choose(None, {"enabled": True, "summary": {"ui": 3, "photo": 1}, "decisions": {}}), BIG)
# escalation alone -> big (opaque graphics)
eq("escalate-only -> big", router_choose(None, {"enabled": True, "summary": {"blank": 6}, "decisions": {"escalate": [{}]}}), BIG)
# captchaLike -> big
eq("captcha -> big", router_choose(None, {"enabled": True, "summary": {"ui": 6}, "decisions": {"captchaLike": [{}]}}), BIG)
# explicit client model always wins
eq("client override wins", router_choose("forced:1b", {"enabled": True, "summary": {"photo": 5}, "decisions": {}}), None)
# no perception -> default (no-op)
eq("no perception -> None", router_choose(None, None), None)
# disabled map -> default
eq("disabled map -> None", router_choose(None, {"enabled": False, "summary": {"photo": 5}, "decisions": {}}), None)
# disabled flag -> no-op
eq("routing disabled -> None", router_choose(None, {"enabled": True, "summary": {"ui": 1}, "decisions": {}}, enabled=False), None)
# missing big env ("" -> absent) -> complex falls back to default
eq("big env missing -> None", router_choose(None, {"enabled": True, "summary": {"photo": 2}, "decisions": {}}, small=SMALL, big=""), None)
# missing small env -> simple falls back to default
eq("small env missing -> None", router_choose(None, {"enabled": True, "summary": {"ui": 2}, "decisions": {}}, small="", big=BIG), None)
# complexity counter
eq("complexity(ui/blank)=0", perception_complexity({"enabled": True, "summary": {"ui": 4, "blank": 2}, "decisions": {}}), 0)
eq("complexity(photo+escalate)=2", perception_complexity({"enabled": True, "summary": {"ui": 1, "photo": 1}, "decisions": {"escalate": [{}]}}), 2)

print("test_routing: all pass")