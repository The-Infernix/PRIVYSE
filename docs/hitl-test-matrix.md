# Human-in-the-Loop — Test Matrix

Every `ask` question and every Proceed/Cancel prompt is emitted by the VLM, so
testing them against a real model is non-deterministic: you cannot force a
question at step 3, and you cannot reproduce a failure you just saw. This
matrix drives them with `benchmarks/mock-act-server.mjs`, which replays a
scripted list of actions and captures every request body that left the device.

**25 cases · 5 groups · ~40 min for the whole matrix.**

---

## 1. Setup

```powershell
# 1. Build + load the extension (Chrome MV3)
cd C:\SIH\26171\extension
npm run build
#    chrome://extensions -> Developer mode -> Load unpacked
#    -> C:\SIH\26171\extension\.output\chrome-mv3

# 2. Start the scripted server
cd C:\SIH\26171\benchmarks
$env:HITL_PRESET = "ask-basic"     # any preset from the table in §2
$env:HITL_LOG    = "results/hitl-capture.jsonl"
node mock-act-server.mjs
```

3. In the side panel: **Advanced → Server URL** → `http://127.0.0.1:8010`, then
   reopen the panel. The log must read `Server up at http://127.0.0.1:8010 (ok (mock))`.
   *(This is the `sihServerUrl` storage key read by `core/config.ts`.)*
4. Open any **test-site** page (e.g. `http://127.0.0.1:8000/test-site/flight-booking.html`,
   or a local `file://` copy) so there are real elements to click.

Reset the script between cases without restarting anything:

```
http://127.0.0.1:8010/__reset      # rewind the queue + clear the capture
http://127.0.0.1:8010/__requests   # everything captured so far, as JSON
```

### Reading the capture log

`results/hitl-capture.jsonl` is one JSON object per `/act` call. The fields that
matter for this matrix:

| Field | Why |
|---|---|
| `history[-1].result` | What the agent recorded as the step outcome — this is where `USER ANSWER: …` / `USER SKIPPED …` / `USER CANCELED: …` land. **Cases 21–22 assert on this.** |
| `task` | The user's task string, verbatim. **Case 22 asserts on this.** |
| `dom[].text` / `dom[].value` | Must be tokenized (`[EMAIL_1]`, `[AADHAAR_1]`, `[SECRET]`). |
| `screenshotBytes`, `imageMime` | Payload budget + the MIME actually sent. |
| `warnings[]` | The "do NOT attempt it again" note injected on a cancel. |

> `history[].result` and `task` are recorded **exactly as sent**. That is the
> point of cases 21–22: they are *not* tokenized today (see §6, defect D2).

---

## 2. Presets

| Preset | Script |
|---|---|
| `ask-basic` | `ask("Which seat do you want?", ["Window","Aisle"])` → `wait` → `done` |
| `ask-freetext` | `ask("Which date should I use?")` (no options) → `done` |
| `ask-then-done` | `ask("Proceed with the booking?", ["Yes","No"])` → `done` → `ask("…what should I do instead?")` |
| `ask-same-twice` | `ask("Pick one.", ["A","B"])` ×5 |
| `empty-question` | `ask("")` → `done` |
| `cross-origin` | `navigate("https://example.com/")` → `done` |
| `same-origin` | `navigate("/index.html")` → `done` |
| `noisy-answer` | `ask("Read me your PAN and Aadhaar to continue.", ["Proceed","Cancel"])` → `done` |
| `padded-pii` | `ask("Confirm the PAN you want used.", ["Proceed","Cancel"])` |
| `no-ask` | `wait` → `done` — proves the gate does **not** over-trigger |

For a one-off sequence, skip the presets:

```powershell
$env:HITL_SCRIPT = '[{"thought":"t","action":{"type":"ask","question":"Q","options":["A"]},"done":false},{"thought":"t","action":{"type":"done","answer":"x"},"done":true}]'
```

`HITL_REPEAT=false` makes the server answer **409** once the script runs out, so
you can observe the loop's own failure handling instead of an endless loop.
`HITL_DELAY_MS` adds think time between steps.

> **The queue is unconditional.** The mock serves the next entry regardless of
> what you clicked — it has no idea whether you cancelled. That is fine for
> testing the *gate* (which is deterministic, client-side code) but it means you
> must not read the agent's next move as "the model changed its mind". Where a
> case depends on the branch you took, the script is written so the two branches
> are distinguishable — `ask-then-done` is the example: **Proceed** ends the run on
> entry 2, **Cancel** falls through to entry 3.

---

## 3. Group A — the `ask` decide path

| # | Steps | Expected |
|---|---|---|
| **HITL-01** | `ask-basic`. **Run loop** with task `book a window seat`. | Side-panel card appears with the question + `Window`/`Aisle` chips. Page banner appears at the top of the tab. Pipeline stage = `Waiting for your input…`. Loop does **not** advance. |
| **HITL-02** | Click `Window` in the **panel**. | Panel card and banner both dismiss. Log: `👤 You answered: Window`. Capture: `history[-1].result == "USER ANSWER: Window"`. Loop resumes and completes. |
| **HITL-03** | `ask-freetext`. Answer in the panel input, press **Enter**. | No chips rendered; typed text is sent. `history[-1].result == "USER ANSWER: <text>"`. |
| **HITL-04** | `ask-basic`. Click **Skip** in the panel (or the banner's `Skip`). | `history[-1].result == "USER SKIPPED the question."` Loop continues — a skip is **not** a failure and does not consume the retry budget. |
| **HITL-05** | `ask-basic`. While the question is on screen, open DevTools on the tab → **Application → Frames**, or watch the page for changes. | **No `execute-action` message is dispatched to the content script for the `ask` step** — no click, no keystroke, no field mutation. The page is completely untouched while it waits. This is the core safety property of `ask` (`background.ts`). |

---

## 4. Group B — the deterministic confirm gate

The gate is **deliberately narrow**: only task-complete `done` and **cross-origin**
`navigate`. Routine `press Enter` is *not* gated, because gating every Enter made
the loop look frozen. Cases 09–11 are the regression guard for that decision.

| # | Steps | Expected |
|---|---|---|
| **HITL-06** | `ask-then-done`. Answer the `ask`, let it reach `done`. | A second prompt appears: badge reads **`safety check`**, question `Mark the task as complete and stop?`, chips `Proceed` / `Cancel` (the `Cancel` chip is styled as danger). |
| **HITL-07** | `ask-then-done`. Click **Cancel** on the `done` prompt. | Task does **not** end. Log: `USER CANCELED: DONE`. Capture: `warnings[]` on the **next** `/act` contains *"do NOT attempt it again"*. The loop continues and reaches the script's **entry 3**, so a fresh question appears — visible proof the gate blocked the finish. |
| **HITL-08** | `ask-then-done` again. Click **Proceed** instead. | Log `Confirmed by user: DONE`, loop finishes at **entry 2** with `Task complete at step N` — entry 3 is never reached. |
| **HITL-09** | `cross-origin`. | `Navigate to https://example.com/? (leaving the current site)` prompt appears **before** the page changes. Proceed → navigates. |
| **HITL-10** | `same-origin`. | **No prompt.** The step runs straight through. |
| **HITL-11** | Toggle **Confirm risky actions** off in the panel, then `ask-then-done` and `cross-origin`. | Neither `done` nor cross-origin `navigate` prompts. Toggle back on afterwards. |

---

## 5. Group C — lifecycle & robustness

| # | Steps | Expected |
|---|---|---|
| **HITL-12** | `ask-basic`. Trigger the ask, then make **both** surfaces unreachable: close the side panel *and* send `cursor-hide` (or disable the orb) so the banner is hidden. Do not answer. | After **25 s** (`ASK_TIMEOUT_MS` in `background.ts` — *not* the 120 s the README claims, see §7) the ask auto-skips, the loop continues, and the run never looks frozen for minutes. |
| **HITL-13** | Trigger the ask, then press **Stop**. | Resolves immediately with a skip, loop exits cleanly, no orphan card left in the panel, no banner left on the page. |
| **HITL-14** | `ask-same-twice`. Answer the first question. | The **second** question replaces the first cleanly. No double-resolve, no stale resolver, both cards/banners behave as if there had only ever been one. |
| **HITL-15** | `ask-same-twice`. Answer Q1 slowly, so the 25 s timer is nearly expired, then let Q2 raise. | Q1's stale timer must **not** auto-skip Q2 (the sequence guard in the ask code). Q2 stays answerable for its own full 25 s. |
| **HITL-16** | `ask-same-twice` (5 identical asks). Skip every question. | Each `ask` reports a stable `ASK:<question>` fingerprint, so repeats are counted as no-progress. The threshold is 4 repeats, so the rethink (`Recovery - page unchanged…`) fires **on the 5th ask** — not before. The run terminates instead of asking forever. |
| **HITL-17** | Set **Max steps** to `2`, then run `ask-then-done`. | The `ask` consumes one step of the budget even though nothing was executed. The loop stops at 2 with the `done` never reached — confirms ask is budgeted like any other step. |
| **HITL-18** | `ask-basic`. While the question is pending, **switch to another tab**, then answer from that tab's panel/banner. | ⚠ **Known defect D4** — expect the banner on the *original* tab to stay on screen after the answer. |
| **HITL-19** | `ask-basic`. Answer from the **page banner** only (leave the panel open on the question). | ⚠ **Known defect D3** — expect the side-panel card to stay visible and enabled. Clicking it afterwards sends an answer that is silently dropped. |
| **HITL-20** | `empty-question`. | ⚠ **Known defect D5** — the loop blocks with **no banner at all** and a blank card in the panel, for the full 25 s, then skips. |

---

## 6. Group D — privacy (the cases that matter most here)

The whole project thesis is *nothing raw leaves the device*. HITL adds a new
path for text to leave: **the user types it**. The answer is injected into
`history[].result` as `USER ANSWER: …` and sent on the next step.

| # | Steps | Expected |
|---|---|---|
| **HITL-21** | `noisy-answer`. When asked for your PAN/Aadhaar, type a real-looking one into the answer box: `my PAN is ABCDE1234F, Aadhaar 1234 5678 9012`. Let the loop take one more step. | ⚠ **Known defect D2.** Inspect `results/hitl-capture.jsonl` → `history[-1].result` for the next `/act`. **Today the PAN and Aadhaar appear verbatim.** The DOM/token layers did their job, but `history` is not tokenized and the zero-leak gate only scans the DOM — so the gate never sees it. This is the highest-priority follow-up. |
| **HITL-22** | Put PII in the **task** box instead: `book a flight for aadhaar 1234 5678 9012`. Run one step. | ⚠ Same defect, second vector: `task` is copied into the outbound body verbatim. Assert on the `task` field of the capture. |
| **HITL-23** | `ask-basic`, and while the banner is on screen inspect the **sanitized screenshot** the side panel shows for that step (Preview / AI View) plus the capture's `dom[]`. | The banner itself is a closed-shadow-DOM host appended to `<html>`, so it is excluded from the DOM snapshot and must not appear in the uploaded pixels. No `ask` text, no typed answer, and no `sih-ask-banner` node in `dom[]`. |

---

## 7. Group E — surfaces

| # | Steps | Expected |
|---|---|---|
| **HITL-24** | `ask-basic`. Close the side panel before the question appears. | The page banner is still the answerable surface, and the floating orb keeps the panel re-openable. Answering from the banner resumes the loop. |
| **HITL-25** | `ask-basic`. Trigger the ask, then toggle the overlay visibility off mid-question. | The question becomes unanswerable → auto-skip fires at 25 s rather than hanging. Confirms there is no path where the loop waits forever. |

---

## 8. Known defects these cases find

Verified by reading the implementation; each is reproducible with the case noted.
**None are fixed yet** — this matrix documents them so they can be triaged.

| ID | Defect | Location | Repro | Severity |
|---|---|---|---|---|
| **D1** | The confirm gate **fails open**. Cancel is detected *only* by `startsWith("cancel")`, so typing `no`, `nope`, or `don't` **executes the action** — including `done` on a payment flow. Should be an explicit allow-list (`proceed`/`yes`/`ok`) with everything else treated as cancel. | `extension/entrypoints/background.ts` (confirm branch) | HITL-06 with `no` typed instead of clicking Cancel | **High** — safety gate, fail-open |
| **D2** | `history[].result` and `task` go into the outbound body **untokenized**, and the zero-leak gate only walks `body.dom[].text/value`. User-typed PII therefore leaves the device in plaintext with the gate blind to it. | `extension/core/sanitizer.ts` (body assembly) + `extension/core/zero-leak.ts` (`scanForLeaks`) | HITL-21, HITL-22 | **High** — breaks the core privacy claim |
| **D3** | The side panel has no `ask-hide` listener, so answering from the **page banner** leaves the panel card on screen; clicking it sends an answer that is silently dropped (the pending resolver is already cleared). | `extension/entrypoints/sidepanel/main.ts` (message listener) | HITL-19 | Medium — confusing dead UI |
| **D4** | Banner dismissal re-queries the *currently active* tab instead of the tab the question was sent to, so switching tabs mid-question leaves a stale banner on the original tab. | `extension/entrypoints/background.ts` (`hideBanner`) | HITL-18 | Medium — stale overlay over live content |
| **D5** | An `ask` with an empty `question` renders **no banner** (the guard is a truthiness check) while the loop still blocks, so you get a blank card and a 25 s stall. The server's action model accepts an empty question. | `extension/entrypoints/content.ts` (`ask-user` handler) + `server/app.py` (`AskAction`) | HITL-20 | Low–Medium — hostile/malformed output stalls the run |

### Doc / code mismatches

- The README states a **120 s** human-in-the-loop safety net; the code uses
  **25 s** (`ASK_TIMEOUT_MS`). HITL-12 asserts the real number.
- `server/app.py` still declares `PROTOCOL_VERSION = 1` while
  `extension/core/protocol.ts` declares `2`. The server does not validate the
  client's version (it only echoes its own in `/health`), so nothing breaks —
  but the "frozen protocol v2" claim should be consistent across both sides.

---

## 9. Not covered here

This is a **manual** matrix. It cannot run in CI, because the HITL code lives in
the background service worker and the side panel, and the existing benches
(`executor-guard.test.mjs`, `adversarial-bench.mjs`) only inject the in-page
bundle via `addScriptTag` — they never load the extension, so they cannot reach
the worker, the panel, or the banner.

Automating this later is straightforward and worth doing before the judging
round: Chrome supports extensions under `--headless=new`, so
`chromium.launchPersistentContext` + `--load-extension` can load
`.output/chrome-mv3`, grab the service worker via `context.serviceWorkers()`,
point `sihServerUrl` at this mock server, and assert both the UI transitions and
the captured request bodies. The mock server already exposes `/__requests` and
`/__reset` for exactly that. Target: fold the Group C + D cases into a
`benchmarks/hitl.test.mjs` that follows the repo's `PASS/FAIL … results: N pass,
M fail` convention.
