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

[![PII F1](https://img.shields.io/badge/PII%20F1%20(px)-0.979-38BDF8?style=for-the-badge)](benchmarks/results/dashboard.json)
[![Zero-Leak](https://img.shields.io/badge/ZERO%2DLEAK-PASS-22C55E?style=for-the-badge)](benchmarks/results/dashboard.json)
[![E2E per step](https://img.shields.io/badge/E2E%20~12.7%20s%2Fstep-100.0%25-111827?style=for-the-badge&color=64748B)](benchmarks/results/dashboard.json)
[![On-device assets](https://img.shields.io/badge/on%2Ddevice%2021.4%20MB%2C%200%20MB%20off%2Ddevice-0B1220?style=for-the-badge)](extension/public/models/manifest.json)
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
- [x] **Phase 3 helpers** — `core/orb.ts` floating status orb, `core/privacy-lens.ts`
      live PII scanner, `core/ai-view.ts` tokenized + SoM view, spotlight commands.
- [x] `test-site/` — 7 GT-labelled pages (flight booking, bank transfer, faces,
      PII-in-canvas, PII-in-the-wild)
- [x] `benchmarks/` — sanitizer P/R + zero-leak + latency + full VLM agent loop
- [x] Pitch script (`docs/PITCH.pdf`), architecture diagram (`docs/Report/architecture.pdf`)

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
  core/sanitizer.ts     privacy gate + Tier A/B redaction + prose PII sweep
  core/orb.ts           floating status orb (Phase 3)
  core/privacy-lens.ts  live PII highlight scanner (Phase 3)
  core/ai-view.ts       tokenized + Set-of-Marks view (Phase 3)
  entrypoints/          background (orchestrator) · content (executor) · sidepanel (UI) · offscreen (vision host)
  public/models/        bundled weights + WASM runtimes (no CDN)
server/             FastAPI — /health, /act (Qwen2.5-VL via Ollama), /rethink
test-site/          synthetic pages with ground-truth PII labels (incl. faces + canvas PII)
benchmarks/         metrics runner: detection P/R, redaction, zero-leak, latency, VLM loop
docs/               pitch script (PDF), architecture diagram, research briefs
ppt-final/          slide assets
```

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

---

<p align="center">

**PRIVYSE · SIH 26171 · "Your screen never leaves — and you can watch it."**

</p>