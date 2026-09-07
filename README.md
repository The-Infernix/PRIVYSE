# SIH 26171 — On-device Visual Perception for Light-weight Browser Agents

Privacy-preserving browser agent: on-device screen understanding + PII redaction,
sanitized-only context to a server VLM, JSON actions back, executed locally.

Full plan: `C:\SIH\plans\SIH26171_build_plan.md`

## Status (Phase 2 + 3 — on-device vision live, sanitizer + VLM accuracy measured)

- [x] WXT extension scaffold (Chrome MV3 via WXT; Firefox pass in Phase 4)
- [x] Side panel UI: task input, Run-one-step, capture preview, activity log
- [x] Background orchestrator: captureVisibleTab → POST /act → execute in tab
- [x] Content script: executor + DOM serializer (labels, bboxes × dpr, shadow roots)
- [x] Frozen v1 protocol shared by client + server (`extension/core/protocol.ts`)
- [x] FastAPI server: `/health`, `/warm`, `/act` (Qwen2.5-VL), `/rethink`
- [x] `core/sanitizer.ts` — privacy gate + Tier A/B redaction + prose PII sweep
- [x] **Phase 2 on-device vision** — offscreen-document inference host:
      MediaPipe BlazeFace face blur (Tier C), region-restricted Tesseract OCR
      (canvas/img/video only), account/ifsc label rules, whole-region taint
      redaction, and a zero-leak layer 2 that OCRs the sanitized screenshot
      before upload (fail-closed). All weights bundled in `public/models/`
      (~2.2 MB models + WASM runtime, ~21 MB total) — never fetched from a CDN.
- [x] `test-site/` — 7 GT-labelled pages (flight booking, bank transfer, faces,
      PII-in-canvas, PII-in-the-wild)
- [x] `benchmarks/` — sanitizer P/R + zero-leak (DOM + image OCR) + latency,
      and full VLM agent loop

### Measured now (`benchmarks/results/dashboard.json`)

| Criterion | Result |
|---|---|
| PII detection F1 (px) | **0.979** (precision 0.959, recall 1.000) |
| Redaction precision (px) | **0.959** |
| Zero-leak | **PASS** — DOM regex scan + OCR of the sanitized screenshot |
| Face detection (Tier C) | 2/2 faces blurred, F1 1.0 |
| Canvas PII via OCR | account 2/2 (canvas + input), F1 1.0; ifsc 1/1 |
| Visual-context accuracy (qwen2.5vl:7b) | **3/3 tasks (100%)**, avg 1.3 steps |
| Visual-context accuracy (qwen2.5vl:3b) | 2/3 (fails prose "read & report" task) |
| Visual-context accuracy (routed 3b/7b) | **3/3 tasks (100%)**, avg 1.0 steps |
| E2E ms/step — 7b | ~19.4 s (incl. ~0.9 s on-device vision + OCR gate) |
| E2E ms/step — routed (interactive→3b, read→7b) | ~12.7 s avg; interactive steps ~7.5–8.0 s |
| Client resources | ~0.3 s vision + ~0.6 s OCR gate per step; 2.2 MB weights, 21.4 MB total on-device assets, 0 MB off-device |

Zero-leak is checked twice: `scanForLeaks` (regex over the outbound DOM JSON)
and an OCR pass over the **sanitized screenshot pixels** (what would actually
be uploaded). Pixel precision/recall are computed on **rasterized masks**
(union of predicted redaction boxes vs union of GT boxes, clipped to the
captured viewport) — set-based, so both are bounded by 1 by construction. The
3b-vs-7b gap shows the harness discriminates model capability — intended.

## Latency engineering (Phase 4 partial)

Server levers (all on, env-tunable): `VLM_MAX_TOKENS=128` (was 256),
`SYSTEM_PROMPT_MODE=compact` (~60% fewer system tokens), `IMAGE_MAX_SIDE=800`
(Pillow JPEG resize before the VLM call). Bench harness adds `BENCH_ROUTED=1`:
interactive steps use `qwen2.5vl:3b` (~7.5–8.0 s/step), read/report tasks use
`qwen2.5vl:7b` — 3/3 tasks, avg VLM time per step 18.6 s → 12.7 s.

Hardware reality on the dev box (RTX 3050 4 GB): `qwen2.5vl:7b` (6.2 GB) runs
**75% CPU / 25% GPU** (`ollama ps`), and vision tokens floor at ~1024 per image,
so prefill (~5.5 s) + decode (~5.5 s) are CPU-bound even on a minimal prompt
probe. The sub-5 s/step target needs VRAM ≥ model size (judge hardware) or a
GPU-resident small model — the routed design is what makes the agent usable on
memory-constrained hardware today.

## Run it

### 1. Server (terminal 1)

```bash
cd C:\SIH\26171\server
.venv\Scripts\activate          # created during scaffold; else: python -m venv .venv
pip install -r requirements.txt # only if venv is fresh
uvicorn app:app --reload
# → http://127.0.0.1:8000/health
```

### 2. Extension (terminal 2)

```bash
cd C:\SIH\26171\extension
npm install                     # only if node_modules is missing
npm run build                   # one-shot build (or: npm run dev for HMR)
```

Load in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select `C:\SIH\26171\extension\.output\chrome-mv3`.

### 3. Checkpoint

1. Open any scrollable page (e.g. a news site).
2. Right-click the extension's toolbar icon → **Open side panel**.
3. Confirm "Server up at http://127.0.0.1:8000" appears (else start step 1).
4. Click **Run one step** → page scrolls; log shows the round trip.

## Layout

```
extension/          WXT extension (TypeScript)
  core/protocol.ts  frozen v1 action protocol + message types
  core/vision.ts    Phase 2 on-device vision (BlazeFace + Tesseract, bundled weights)
  entrypoints/      background (orchestrator) · content (executor) · sidepanel (UI) · offscreen (vision host)
  public/models/    bundled weights + WASM runtimes (no CDN)
server/             FastAPI — /health, /act (Qwen2.5-VL via Ollama), /rethink
test-site/          synthetic pages with ground-truth PII labels (incl. faces + canvas PII)
benchmarks/         metrics runner: detection P/R, redaction, zero-leak, latency, VLM loop
docs/               architecture diagram, demo script
```

## Next (Phase 4 — meeting targets)

1. Latency: reach p50 < 5000 ms/step on judge-class GPU (VRAM ≥ 7b model size +
   NBF support) and keep routed 3b/7b as the low-memory fallback.
2. Firefox pass: sidebar as the vision host (no offscreen documents in MV2),
   `browser.*` APIs, packaged extension for the judging VM.
3. Demo deliverables: 3-min video (network-tab proof that only sanitized
   payloads leave), pitch deck, rehearsal on a cold profile.

## Benchmarks

```bash
cd C:\SIH\26171\benchmarks
npm run bench          # sanitizer P/R + leak + latency  → results/latest.json
npm run bench:vlm      # full agent loop (needs server + Ollama) → results/vlm-accuracy.json
node aggregate.mjs     # merge → results/dashboard.json
```

Set `BENCH_MODEL=qwen2.5vl:7b`, `BENCH_ONLY=pii-in-the-wild`, `BENCH_STEPS=12`
to select model/task/budget. `BENCH_ROUTED=1` switches to small/big routing
(`BENCH_MODEL_SMALL` / `BENCH_MODEL_BIG`, default qwen2.5vl:3b/:7b). VLM tasks:
`flight-booking`, `bank-transfer`, `pii-in-the-wild`.
