# SIH 26171 — Build Plan: On-device Visual Perception for Light-weight Browser Agents

**Deadline:** 20 Sep 2026 (16 days from 4 Sep)
**Architecture in one line:** Browser extension captures tab screenshot + DOM snapshot → on-device sanitizer redacts PII (DOM rules + face detection + OCR) → sanitized payload to server VLM (Qwen2.5-VL) → server returns JSON action → content script executes → loop.

**Scoring map (every phase must serve these):**

| Metric | Weight | Served by |
|---|---|---|
| Accuracy of visual context | 25% | DOM snapshot + Set-of-Marks + screenshot hybrid (Phase 1) |
| PII detection recall & precision | 20% | Layered detector + ground-truth test site (Phases 1–3) |
| Redaction precision | 20% | Tokenization/blackout/blur + zero-leak OCR gate (Phases 1–3) |
| Client resource utilization | 20% | Small models (<20 MB), WebGPU, bundled weights (Phase 2) |
| End-to-end latency | 15% | Downscaled WebP, bounded history, fast VLM (Phases 1 & 4) |

---

## Repo layout (create once, never reorganize mid-hackathon)

```
C:\SIH\26171\
├── extension/                # WXT (TypeScript) — cross-browser MV3/MV2 handled by WXT
│   ├── entrypoints/
│   │   ├── background/       # orchestrator: agent loop, throttled capture
│   │   ├── content/          # DOM serializer, action executor, SoM overlay
│   │   ├── offscreen/        # ONNX/WebGPU inference host (Chrome offscreen doc)
│   │   └── sidebar/          # UI: original-vs-sanitized preview, action log, metrics
│   ├── core/                 # shared: protocol.ts, sanitizer.ts, pii-rules.ts, messaging.ts
│   ├── public/models/        # bundled ONNX weights (never fetched from CDN)
│   └── wxt.config.ts
├── server/                   # FastAPI
│   ├── app.py                # POST /act, GET /health
│   ├── prompts.py            # system prompt + redaction legend + JSON schema
│   └── requirements.txt      # fastapi, uvicorn, vllm, openai
├── test-site/                # synthetic site with ground-truth PII labels
│   └── (pages with data-gt attributes)
├── benchmarks/               # eval runner, metrics math, latency waterfall export
└── docs/                     # architecture diagram, demo script, video script
```

**Why WXT:** one codebase → Chrome MV3 + Firefox MV2, hot reload, auto webextension-polyfill. Alternative: Vite + @crxjs (Chrome-first, more manual Firefox work).

---

## Phase 0 — Scaffold (Day 1, ~half a day)

- [ ] `npm create wxt@latest` → extension/ skeleton; verify `load unpacked` works in Chrome AND Firefox (`npm run dev`/`build:firefox`).
- [ ] Manifest permissions: `activeTab`, `tabs`, `sidePanel` (Chrome) / `sidebarAction` (Firefox), host `<all_urls>`. Declare offscreen reason `WORKERS`/`BLOBS`.
- [ ] Server: FastAPI app with `GET /health` + `POST /act` returning a **canned** `{"action":{"type":"scroll","direction":"down"}}`. uvicorn running locally.
- [ ] Messaging bus: background ⇄ content ⇄ sidebar via `browser.runtime.sendMessage` + port for streaming logs. Define message types in `core/protocol.ts`.
- [ ] **Checkpoint:** sidebar button "capture" logs a base64 screenshot in the sidebar console; server /health reachable from extension.

## Phase 1 — End-to-end spine, zero ML (Days 2–4) ⭐ most important phase

Goal: full agent loop works with **no local model**. Everything after this only upgrades components.

### 1a. DOM serializer (content script)
- [ ] Recursive walk incl. **shadow roots** (`el.shadowRoot?.querySelectorAll("*")`) and same-origin iframes.
- [ ] Keep only visible, interactive/informative nodes: `a, button, input, select, textarea, [role], [onclick], img[alt], h1-h6`, plus text blocks capped at ~200 elements.
- [ ] Per element record: `id` (running int), `tag`, `role`, `text` (≤80 chars), `label` (resolve via `<label for>`, `aria-label`, `aria-labelledby`, placeholder, autocomplete attr), `bbox` (getBoundingClientRect × devicePixelRatio → screenshot pixel space), `value?` (inputs only).
- [ ] **Checkpoint:** JSON snapshot of github.com looks sane; bboxes align with screenshot pixels.

### 1b. Sanitizer v1 (`core/sanitizer.ts`) — the privacy gate
- [ ] Single exit point `sanitizeForUpload(payload)`. The **only** function allowed to build an outbound body; `fetch` wrapper refuses anything else. Log every outbound payload size + hash in sidebar.
- [ ] **Tier rules:**
  - Tier A — `input[type=password]`, `type=hidden` secrets: solid black box over bbox, value replaced `[SECRET]`.
  - Tier B — PII text: DOM text + input values matched by rules (email, `+91`/10-digit phone, 12-digit Aadhaar, PAN `[A-Z]{5}\d{4}[A-Z]`, Luhn-valid card, name/address via label heuristics: `autocomplete`/name/id matching name|email|phone|addr|dob|ssn|aadhaar|pan|card) → pixels replaced by token `[EMAIL_1]`, `[NAME_1]`… **same value ⇒ same token** across steps (VLM continuity). Draw token text on canvas over the region.
  - Tier C — faces: blur (added Phase 2).
- [ ] **Zero-leak gate (fail-closed):** before send, OCR/regex-scan the *sanitized* image; any surviving PII pattern → block request, re-redact with +10% padded boxes, retry ≤2, else abort step and tell user.
- [ ] **Checkpoint:** screenshot of a login page shows blacked password + `[EMAIL_1]`; sanitized-image scan finds zero PII strings.

### 1c. Set-of-Marks overlay
- [ ] In an offscreen canvas: draw screenshot, then numbered colored tags (12×12 px) at each serialized element's bbox top-left. Send tagged screenshot + DOM list (with tokenized values) to server.
- [ ] **Checkpoint:** tags visually aligned on a news site.

### 1d. Server VLM (real)
- [ ] vLLM: `vllm serve Qwen/Qwen2.5-VL-7B-Instruct --max-model-len 8192` on a cloud GPU box, OpenAI-compatible. For SIH demo, cloud API fallback via env (`OPENAI_BASE_URL` → DashScope/SiliconFlow Qwen2.5-VL) — both allowed by PS.
- [ ] `POST /act {task, history(≤6 steps), screenshot_b64, dom[]}` → **guided JSON** (vLLM `guided_json` / `response_format`): `{thought, action, done}`.
- [ ] **Action protocol (freeze this now, version it):**
```json
{"action": {"type": "click|type|press|scroll|navigate|wait|extract|done|ask",
            "target": 14, "text": "...", "direction": "down", "url": "...",
            "question": "...", "options": ["..."]},
 "thought": "…", "done": false}
```
- [ ] System prompt includes: redaction legend (`[EMAIL_1]` etc. are placeholders — reason about structure, never ask user to reveal them), action list, and "prefer `done` when task complete".
- [ ] Human-in-the-loop: `ask` pauses the loop to surface a realtime question in the side panel + page banner, then continues with the answer in context (never dispatched to the page). Revealed protocol changes bump `PROTOCOL_VERSION`. Deterministic safety confirm (Proceed/Cancel) gates task-complete `done` and cross-origin `navigate` (NOT routine Enter — that froze the loop).
- [ ] Malformed JSON → one repair retry → else return `wait` (loop never crashes).

### 1e. Executor + agent loop (background)
- [ ] Executor in content script: `click` → scrollIntoView + dispatch pointer/mouse events + `.click()`; `type` → focus + native value setter + input/change events; `scroll`/`navigate`/`wait`/`extract` similarly.
- [ ] Loop: capture → serialize → sanitize → /act → execute → sleep ≥700ms (Chrome rate-limits `captureVisibleTab` to ~2/sec) → repeat. Max 15 steps, stop on `done` or 2 consecutive failures.
- [ ] **Checkpoint (Demo 1):** "Search WebGPU on Google, open the first MDN result" runs unattended, sidebar shows each step's sanitized screenshot.

## Phase 2 — On-device vision (Days 5–8)

- [ ] **Inference host:** Chrome → offscreen document (MV3 service workers have no WebGPU); Firefox → sidebar page. Abstract behind `runInference()` in core. ONNX Runtime Web / MediaPipe tasks-vision, `device: "webgpu"` with WASM fallback (single-thread WASM to avoid COOP/COEP headaches).
- [ ] **Face detection:** MediaPipe Face Detector (~1 MB) on screenshot → bbox + 15% padding → Gaussian blur via canvas. → Tier C.
- [ ] **OCR:** Tesseract.js (WASM) run ONLY on image/canvas regions (skip DOM-covered areas) → detected text through same Tier B rules → tokenize/pixelate.
- [ ] Optional if time: YOLOv8n int8 (~6 MB) for icon/widget bboxes on non-DOM areas (upsell to judges as "equivalent CV model on-device"; skip without guilt if Phase 3 slips).
- [ ] Sidebar: side-by-side **Original | Sanitized** per step + redaction log (what/where/why) + resource meter (per-stage ms via performance marks, JS heap, model sizes loaded).
- [ ] **Checkpoint (Demo 2):** page with a face photo + PII inside an image → both caught in sanitized preview; loop still completes task.

## Phase 3 — Ground-truth test site + metrics (Days 9–12)

This is what converts "trust us" into numbers on screen — 60% of the score.

- [ ] `test-site/`: fake flight-booking / bank-transfer flow; every PII element carries `data-gt="email:alice@example.com"`; avatar images with faces (AI-generated, license-safe); PDF/canvas corner case page.
- [ ] Benchmarks runner (Playwright or plain extension): run K tasks × N pages, auto-collect:
  - **Detection P/R:** predicted redaction boxes vs GT boxes, match at IoU ≥ 0.5.
  - **Redaction precision:** (redacted ∩ GT) / redacted pixels + **zero-leak** (OCR sanitized output for GT values must be 0 hits).
  - **Latency waterfall:** capture / serialize / sanitize(+models) / upload / VLM / execute — p50 & p95.
  - **Resources:** model MB loaded, per-stage ms, heap, FPS during inference.
- [ ] Dashboard tab in sidebar rendering these live during the run.
- [ ] **Checkpoint (Demo 3):** one click → task suite runs on test-site → dashboard shows all five metrics.

## Phase 4 — Hardening, cross-browser, demo (Days 13–16)

- [ ] Firefox pass: sidebar as inference host, `browser.*` APIs (WXT handles most), test full loop.
- [ ] Latency: screenshot → 1280px-wide WebP q=0.7; history capped at 6 steps (text-only for old steps); system prompt cached (prefix caching); temperature 0.
- [ ] Graceful degradation: no WebGPU → WASM @ 640px input; VLM down → clear error card, agent halts (never sends unsanitized data as fallback).
- [ ] Edge cases: shadow-DOM-heavy sites (React), cookie banners (auto-dismiss), infinite scroll.
- [ ] Deliverables: README (architecture diagram + privacy guarantees + metrics table), 3-min video (raw-capture-never-leaves proof via network log), pitch deck, demo script (3 tasks + adversarial page + metrics dashboard).
- [ ] Rehearse on a fresh machine profile (no cache, cold model load) — that's what judges see.

---

## Day-by-day (4 Sep → 20 Sep)

| Date | Focus | Exit criterion |
|---|---|---|
| Sep 4–5 | Phase 0 scaffold + capture/health loop | Screenshot → server → canned action round-trip |
| Sep 6–8 | Phase 1: serializer, sanitizer v1, SoM, real VLM, executor, loop | Demo 1 (search task unattended) |
| Sep 9–10 | Phase 2: offscreen inference, face blur | Face demo |
| Sep 11–12 | Phase 2: OCR redaction, sidebar UI | Demo 2 |
| Sep 13–15 | Phase 3: test site, metrics, dashboard | Demo 3 with numbers |
| Sep 16–17 | Phase 4: Firefox, latency tuning, edge cases | Both browsers, p50 < ~5 s/step target |
| Sep 18–19 | Video, README, deck, rehearsal | All deliverables in repo |
| Sep 20 | Buffer | Submit |

## Parallel workstreams (if team > 1)

1. **Extension core** (Phases 0–1) — hardest scheduling risk, start first.
2. **Server/VLM** — prompt engineering + guided JSON + hosting; independent from day 1.
3. **Test-site + metrics** — independent from day 2; defines "done" for everyone.

## Risk register

| Risk | Mitigation |
|---|---|
| `captureVisibleTab` 2/sec rate limit | ≥700 ms sleep between steps; never burst |
| Judge machine lacks WebGPU | Auto-fallback WASM @ 640px; show fallback badge |
| VLM returns malformed JSON | Guided decoding; 1 repair retry; `wait` fallback |
| Chrome offscreen vs Firefox no-offscreen | `runInference()` host abstraction from day one |
| OCR latency spikes | OCR only image regions; hard 500 ms budget, skip on overrun |
| Sensitive text in canvas/image missed | OCR layer + zero-leak gate catches; log misses, pad boxes |
| Scope creep (YOLO, fancy UI) | Cut list, in order: YOLO → NER model → animation polish. Never cut metrics harness |

## Package shortlist

Extension: `wxt`, `typescript`, `onnxruntime-web`, `@mediapipe/tasks-vision`, `tesseract.js` (or `@huggingface/transformers` if using its pipelines).
Server: `fastapi`, `uvicorn`, `vllm` (self-host) / `openai` client pointed at DashScope/SiliconFlow (SIH demo), `pydantic`.
Models: Qwen2.5-VL-7B-Instruct (Apache-2.0), MediaPipe face_detector_short_range (~1 MB), optional yolov8n-int8 (~6 MB).
