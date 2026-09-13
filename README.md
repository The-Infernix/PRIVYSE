# PRIVYSE — On-device Privacy-Preserving Browser Agent

**SIH 26171 · Track: On-device Visual Perception for Light-weight Browser Agents**

A privacy-preserving browser agent: on-device screen understanding + PII redaction,
sanitized-only context to a server VLM, JSON actions back, executed locally.
Your screen never leaves the device — and the gate is visible every step of the way.

<p align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![WXT](https://img.shields.io/badge/WXT-0.20-blue?style=for-the-badge&color=365FC7&logo=googlechrome&logoColor=white)](https://wxt.dev)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)]()
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white&color=009688)](https://fastapi.tiangolo.com)
[![Qwen2.5-VL](https://img.shields.io/badge/Qwen2.5_VL-7b-7B3FF2?style=for-the-badge&color=7B3FF2)](https://ollama.com/library/qwen2.5vl)
[![Ollama](https://img.shields.io/badge/Ollama-local-0B1220?style=for-the-badge&logo=ollama&logoColor=white)](https://ollama.com)
[![MediaPipe](https://img.shields.io/badge/MediaPipe_BlazeFace-on%2Ddevice-34D399?style=for-the-badge)](https://developers.google.com/mediapipe)
[![Tesseract.js](https://img.shields.io/badge/Tesseract.js-WASM-D14836?style=for-the-badge&color=D14836)](https://tesseract.projectnaptha.com)

[![PII F1](https://img.shields.io/badge/PII%20F1%20(px)-0.984-38BDF8?style=for-the-badge)](benchmarks/results/dashboard.json)
[![Zero-Leak](https://img.shields.io/badge/ZERO%2DLEAK-PASS-22C55E?style=for-the-badge)](benchmarks/results/dashboard.json)
[![E2E per step](https://img.shields.io/badge/E2E%20~12.7%20s%2Fstep-100.0%25-111827?style=for-the-badge&color=64748B)](benchmarks/results/dashboard.json)
[![On-device assets](https://img.shields.io/badge/on%2Ddevice%2040.8%20MB%2C%200%20MB%20off%2Ddevice-0B1220?style=for-the-badge)](extension/public/models/manifest.json)
[![SIH 2026](https://img.shields.io/badge/SIH-2026-FFFFFF?style=for-the-badge&color=111827)]()

</p>

---

## Quick links

<p align="center">

[![Pitch script](https://img.shields.io/badge/Pitch_Script-PDF-F87171?style=flat-square)](docs/PITCH.pdf)
[![Architecture](https://img.shields.io/badge/Architecture-PDF%20%26%20SVG-38BDF8?style=flat-square)](docs/Report/architecture.pdf)
[![Report](https://img.shields.io/badge/Report-PDF-34D399?style=flat-square)](docs/Report/report.pdf)
[![Slides](https://img.shields.io/badge/Slides-PPT%20assets-A78BFA?style=flat-square)](ppt-final/)
[![Benchmarks](https://img.shields.io/badge/Benchmarks-Dashboard%20JSON-22C55E?style=flat-square)](benchmarks/results/dashboard.json)
[![Test site](https://img.shields.io/badge/Test_site-GT%20labelled%20pages-FACC15?style=flat-square)](test-site/)
[![Build plan](https://img.shields.io/badge/Build_plan-Markdown-0B1220?style=flat-square)](C:/SIH/plans/SIH26171_build_plan.md)

</p>

---

## Why PRIVYSE

Generic "computer use" agents capture the **raw screen** — every email, phone
number, PAN, address and face — and ship those pixels to a hosted model.
PRIVYSE puts a **sanitizer between the camera and the model**. Every screenshot
passes through a fail-closed, on-device privacy gate before anything can leave:

<p align="center">

`CAPTURE → SANITIZE → GATE → REASON → ACT`

</p>

- **Tier A — absolute secrets.** Password / OTP / CVV / API-key fields: solid black.
- **Tier B — PII.** Emails, phones, Aadhaar, PAN, Luhn-valid cards, names,
  addresses → redacted **and** replaced with stable tokens (`[EMAIL_1]`, `[PAN_2]`)
  so the model keeps continuity. Same value → same token.
- **Tier C — faces & non-DOM text.** BlazeFace blurs faces on-device; region-restricted
  Tesseract OCR scans image/canvas/video regions the DOM never carries. Weights bundled,
  never fetched from a CDN.
- **On-device ViT screen perception (PS §1).** A MobileViT-Small (q8 ONNX) runs in the
  browser, reads the visible screen into a semantic tile map (`photo / ui / document / data /
  blank`), escalates non-DOM graphics regions to whole-image blur before upload, and ships a
  compact "ON-DEVICE PERCEPTION" block so the VLM reasons from locally-observed structure.
- **Sensitive pages skipped entirely.** Banking, password-reset, ID pages are never captured.
- **Zero-leak OCR verification.** The *sanitized* image is OCR'd again — if any PII is
  still readable in the pixels that would be uploaded, the gate reports `BLOCKED` and the step stops.

Trust is demonstrated, not promised: the gate is visible in the side panel, and a
`GATE PASS` / `BLOCKED` flash fires on every step.

## Features

- **Side panel control center** — task box, live agent-state pill, 5-stage pipeline
  strip with a GATE node, privacy hero card (detected / protected / raw-values-sent
  with `jes\*\*\*@gmail.com → [EMAIL_1]` token map), before/after "Your screen vs.
  what the AI sees", structured decision trace, activity log, session history.
- **Spotlight (Alt+K)** — page-level command palette: run / step-one / stop, toggle
  cursor, switch models, VLM health check, toggle orb / Privacy Lens / AI View.
- **Floating PRIVYSE orb** — draggable status dot that expands into a live pill
  (stage, step counter, pipeline dots) while the panel is closed; hides itself
  during every capture.
- **Privacy Lens** — one-key live scan that highlights sensitive regions on the page
  (red rings + type tags) with a *Show sanitized view* banner.
- **AI View mode (USER | AI VIEW)** — flip the page into exactly what the model
  sees: PII rewritten to stable tokens + Set-of-Marks chips on every interactive element.
- **Adaptive loop** — `/act` + `/rethink`, stuck / no-progress detection, site-level
  lesson memory, auto-type escalator.

## Status

- [x] WXT extension scaffold (Chrome MV3 via WXT; Firefox pass in Phase 4)
- [x] Side panel UI: task input, Run-one-step, capture preview, activity log
- [x] Background orchestrator: capture → POST /act → execute in tab
- [x] Content script: executor + DOM serializer (labels, bboxes × dpr, shadow roots)
- [x] Frozen v1 protocol shared by client + server (`extension/core/protocol.ts`)
- [x] FastAPI server: `/health`, `/warm`, `/act` (Qwen2.5-VL), `/rethink`
- [x] `core/sanitizer.ts` — privacy gate + Tier A/B redaction + prose PII sweep
- [x] **Phase 2 on-device vision** — offscreen-document inference host:
      BlazeFace face blur (Tier C), region-restricted Tesseract OCR, account/ifsc
      label rules, whole-region taint redaction, zero-leak layer-2 OCR gate
      (fail-closed). ~2.2 MB models + WASM runtime (~21 MB total), no CDN.
- [x] **Phase 4 on-device ViT perception (PS §1)** — `core/perception.ts`:
      MobileViT-Small (q8 ONNX, 6.3 MB) + onnxruntime-web (13.3 MB) run fully
      locally; semantic tile map + per-region escalation decisions feed the
      sanitizer, and a compact ON-DEVICE PERCEPTION block feeds the server prompt.
- [x] **Phase 3 helpers** — `core/orb.ts` floating status orb, `core/privacy-lens.ts`
      live PII scanner, `core/ai-view.ts` tokenized + SoM view, spotlight commands.
- [x] `test-site/` — GT-labelled pages (flight booking, bank transfer, faces,
      PII-in-canvas, PII-in-the-wild, India-KYC UPI/voter/DL/passport) + perception
      ground-truth tile page + adversarial/ attack pages
- [x] `benchmarks/` — sanitizer P/R + zero-leak + latency + full VLM agent loop +
      perception tile eval + executor guard tests + adversarial privacy suite
- [x] **Executor action guards** — navigation restricted to http(s), form submissions
      with non-http actions refused, file inputs never clicked (offline test 20/20)
- [x] **Indian PII expansion** — UPI ID, voter ID (EPIC), driving licence, passport
      patterns (all 100% recall/precision in the GT bench)
- [x] **Perception failure-path audit** — (`docs/perception-failure-path-audit.md`) no
      fail-open path; failures degrade to the pre-perception baseline
- [x] Pitch script (`docs/PITCH.pdf`), architecture diagram (`docs/Report/architecture.pdf`)

### Measured now (`benchmarks/results/dashboard.json`)

| Criterion | Result |
|---|---|
| PII detection F1 (px) | **0.984** (precision 0.968, recall 1.000) |
| Redaction precision (px) | **0.968** |
| Zero-leak | **PASS** — DOM regex scan + OCR of the sanitized screenshot |
| Face detection (Tier C) | 2/2 faces blurred, F1 1.0 |
| Canvas PII via OCR | account 2/2 (canvas + input), F1 1.0; ifsc 1/1 |
| On-device ViT perception | 7/7 pages classified in-browser; ~1.6 s/pass; 5 non-DOM graphics regions escalated to Tier C blur (source `perception`); photo-vs-blank accuracy 100% on labelled tiles (`perception-eval.mjs`); runs **in parallel** with faces/OCR (independent timeouts, no shared budget) |
| Visual-context accuracy (qwen2.5vl:7b) | **3/3 tasks (100%)**, avg 1.3 steps |
| Visual-context accuracy (qwen2.5vl:3b) | 2/3 (fails prose "read & report" task) |
| Visual-context accuracy (routed 3b/7b) | **3/3 tasks (100%)**, avg 1.0 steps |
| E2E ms/step — 7b | ~19.4 s (incl. ~1.0 s on-device vision + OCR gate on image pages) |
| E2E ms/step — routed (interactive→3b, read→7b) | ~12.7 s avg; interactive steps ~7.5–8.0 s |
| Client resources | ~1.7 s vision (faces+OCR+ViT, parallel) + ~0.5 s OCR gate per step; 8.5 MB model weights, 40.8 MB total on-device assets (incl. WASM runtime), 0 MB off-device |

Zero-leak is checked twice: `scanForLeaks` (regex over the outbound DOM JSON)
and an OCR pass over the **sanitized screenshot pixels** (what would actually be
uploaded). Pixel precision/recall are computed on **rasterized masks** (union of
predicted redaction boxes vs. union of GT boxes, clipped to the captured
viewport). The 3b-vs-7b gap shows the harness discriminates model capability.

## Roadmap

1. **Latency** — p50 < 5000 ms/step on judge-class GPU (VRAM ≥ 7b + NBF) with
   routed 3b/7b as the low-memory fallback.
2. **Firefox pass** — sidebar as the vision host (no offscreen documents in MV2),
   `browser.*` APIs, packaged extension for the judging VM.
3. **Demo deliverables** — 3-min video (network-tab proof that only sanitized
   payloads leave), rehearsal on a cold profile.

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
  core/protocol.ts      frozen v1 action protocol + message types
  core/vision.ts        Phase 2 on-device vision (BlazeFace + Tesseract, bundled weights)
  core/perception.ts    Phase 4 on-device ViT (MobileViT-Small q8 + onnxruntime-web)
  core/sanitizer.ts     privacy gate + Tier A/B redaction + prose PII sweep
  core/action-guards.ts executor safety: navigation/form-action/file-input guards
  core/orb.ts           floating status orb (Phase 3)
  core/privacy-lens.ts  live PII highlight scanner (Phase 3)
  core/ai-view.ts       tokenized + Set-of-Marks view (Phase 3)
  entrypoints/          background (orchestrator) · content (executor) · sidepanel (UI) · offscreen (vision host)
  public/models/        bundled weights + WASM runtimes (no CDN)
server/             FastAPI — /health, /act (Qwen2.5-VL via Ollama), /rethink
test-site/          synthetic pages with ground-truth PII labels (incl. faces + canvas PII),
  perception GT tiles, adversarial/ attack pages (canvas/SVG/tiny-text/obfuscation/
  prompt-injection/exfil DOM)
benchmarks/         metrics runner: detection P/R, redaction, zero-leak, latency, VLM loop,
  perception tile eval, executor-guard tests, adversarial privacy suite
docs/               pitch script (PDF), architecture diagram, research briefs, perception audit
ppt-final/          slide assets
```

## Benchmarks

```bash
cd C:\SIH\26171\benchmarks
npm run build          # bundles benchmarks/src/inpage-entry.ts → dist/inpage.js
node run.mjs           # sanitizer P/R + leak + latency + perception  → results/latest.json
node perception-eval.mjs      # MobileViT labelled-tile accuracy      (needs test server)
node executor-guard.test.mjs  # offline executor safety tests 20/20   (no server/VLM)
node adversarial-bench.mjs    # adversarial privacy-pipeline suite    (needs test server)
node probe-batch.mjs          # onnxruntime-web batch determinism tripwire (wasm batch>1 bug doc)
node vlm-bench.mjs            # full agent loop (needs server + Ollama) → results/vlm-accuracy.json
node aggregate.mjs            # merge → results/dashboard.json
npm run bench          # alias for `npm run build && node run.mjs`
npm run bench:vlm      # alias for `npm run build && node vlm-bench.mjs`
```

Set `BENCH_MODEL=qwen2.5vl:7b`, `BENCH_ONLY=pii-in-the-wild`, `BENCH_STEPS=12`
to select model/task/budget. `BENCH_ROUTED=1` switches to small/big routing
(`BENCH_MODEL_SMALL` / `BENCH_MODEL_BIG`, default qwen2.5vl:3b/:7b). VLM tasks:
`flight-booking`, `bank-transfer`, `pii-in-the-wild`.

---

<p align="center">

**PRIVYSE · SIH 26171 · "Your screen never leaves — and you can watch it."**

</p>