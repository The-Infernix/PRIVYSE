# PRIVYSE — Project Progress Brief
### What we have done so far · SIH 2026 · Problem #26171

> **For:** a friend/partner picking up the PPT work.
> **Read this first, then §5 (honest limitations) — it will save you putting a wrong number on a slide.**

---

## TL;DR

We built a **working, measured, privacy-preserving browser agent** in 23 days. Not a mockup — a
real Chrome MV3 + Firefox MV2 extension with a FastAPI backend, an on-device vision stack, a
fail-closed privacy gate, and a benchmark harness that regenerates every number we claim.

**Phases 0–3 complete. Phase 4 (hardening / cross-browser / demo) partial.**

| | |
|---|---|
| **Pipeline** | `CAPTURE → PERCEIVE → SANITIZE → GATE → REASON → ACT` |
| **Core thesis** | Sensitive information should be protected *before* an AI ever gets the opportunity to see it |
| **Headline metric** | PII detection **F1 0.984** (precision 0.968, **recall 1.000**) |
| **Safety** | Zero-leak gate **PASS** · adversarial **30/30** · executor guards **27/27** |
| **Privacy** | **0 MB** raw data off-device · all weights vendored, no CDN |
| **Scale** | ~9,566 lines of source · 4 commits · 84 files published |
| **Timeline** | 4 Sep → 26 Sep 2026, 16 working sessions |

---

## 1. What the project is

**One-liner:** *A privacy-preserving browser agent that redacts your Aadhaar, PAN, cards, OTPs and
faces **on your own device** before anything is sent to an AI model.*

**Track:** SIH 2026 Research Track, Problem #26171 — *On-device Visual Perception for Light-weight
Browser Agents*

**The problem it attacks:** traditional browser agents screenshot the page and upload the raw
pixels to a cloud vision model. Every Aadhaar number, PAN, card, OTP and face on screen goes to a
third party. India runs on exactly those identifiers, so this is not abstract.

**Our fix — change the order of operations.** The AI never gets the browser first. A sanitizer sits
between the camera and the model, and a fail-closed gate *proves* the bytes leaving are clean:

```
CAPTURE → PERCEIVE → SANITIZE → GATE → REASON → ACT
```

**One line for the judges:** *"The privacy layer isn't bolted on afterwards — it is the
architecture."*

---

## 2. What is built and working

### 2.1 Capture & DOM (`extension/core/dom-serializer.ts`)

- `captureVisibleTab` for the viewport + a shadow-root-aware DOM walker.
- Per element: `id · tag · role · text (≤80 chars) · label · bbox × devicePixelRatio · value`.
  Labels resolved via `<label for>`, `aria-label`, `aria-labelledby`, placeholder, autocomplete.
- Capped at **120 elements** so the payload stays small.
- **Set-of-Marks**: numbered 12×12 px tags drawn at each bbox, so the model targets *integers,
  never coordinates*.

### 2.2 On-device perception (`core/perception.ts`, `core/vision.ts`, `core/vision-host.ts`)

Three models run **locally, in parallel**, inside the browser:

| Model | Size | Job |
|---|---|---|
| **MobileViT-Small** (q8 ONNX) | 6.3 MB | Classifies the screen into tiles: `PHOTO · UI · DOCUMENT · DATA · BLANK · UNCERTAIN` |
| **BlazeFace** | 230 KB | Face detection → irreversible blur (Tier C) |
| **Tesseract.js** (WASM) | ~1.9 MB lang data | Region-restricted OCR — only on image/canvas regions, skipped where the DOM already covers it |

- **WebGPU execution provider first**, automatic **WASM fallback** via the same bundled `.jsep`
  runtime. The active provider is surfaced live in the side panel (`perception · ⚡ WebGPU`).
- `core/vision-host.ts` abstracts the host so the *same* model stack runs in Chrome's offscreen
  document and in Firefox's MV2 background page.
- **Pixel-hash same-page cache**: unchanged page → tile map reused in **0 ms**. Faces, OCR and the
  gate still run fresh every step.
- Non-DOM graphics regions get **escalated to Tier C** based on the tile map.

### 2.3 Three-tier sanitizer (`core/sanitizer.ts`, `core/pii-rules.ts`)

| Tier | Information | Protection |
|---|---|---|
| **Tier A** 🔴 | Passwords, OTPs, CVVs, API keys | Solid black box — no text, no token |
| **Tier B** 🟠 | Email, phone, PAN, Aadhaar, UPI, voter ID/EPIC, driving licence, passport, cards, names, addresses, IFSC, bank account, DOB, salary | **Stable privacy tokens** — `[EMAIL_1]`, `[PAN_1]`, `[CARD_1]`, `[UPI_1]` |
| **Tier C** 🟣 | Faces, canvas text, video, non-DOM graphics, tiny visual text | Irreversible blur / region taint |

**Stable tokenization is the key design choice** — the same value always maps to the same token
across the whole run, and a value found by OCR in an image later gets the *same* token when it
appears in the DOM. The model keeps full structural continuity without ever seeing the secret.

**Indian PII coverage** (all at 100% precision/recall on the GT benchmark): UPI IDs · Voter ID /
EPIC · Driving Licence · Passport · PAN · Aadhaar · Indian banking (account + IFSC).

### 2.4 The zero-leak gate (`core/zero-leak.ts`)

The most important component isn't the model — it's the gate. Before anything crosses the privacy
boundary, **two independent checks**:

1. **DOM verification** — the outbound DOM JSON is regex-scanned for sensitive values.
2. **Pixel verification** — the *actual sanitized screenshot bytes that would be uploaded* are
   OCR-scanned again.

**Fail-closed by design:** if the gate itself cannot run, the step is **BLOCKED**. A gate that
cannot verify privacy cannot approve the request. There is no fail-open path — see
`docs/perception-failure-path-audit.md`.

### 2.5 Perception-driven model routing (`server/routing.py`)

The on-device MobileViT map tells the server *how much reasoning this step needs* before the model
is even called:

| Step type | Model | Why |
|---|---|---|
| Interactive · form fill · navigation · typing | `qwen2.5vl:3b` | Fast, low latency (≈7.5–8.0 s/step) |
| Read · report · captcha · complex visuals · documents | `qwen2.5vl:7b` | Reasoning-heavy |

Opt-in via env; a client-supplied `model` **always wins**. Streamed actions are validated, coerced
(`resolve_target` accepts `[6]`, `6.0` and single-element arrays) and guarded before execution.

### 2.6 Guarded action execution (`core/action-guards.ts`, `core/executor.ts`)

The AI does **not** get unrestricted browser control. Guards refuse:

- `javascript:` · `file:` · `data:` · `blob:` · `about:` navigation
- non-HTTP form actions
- `<input type="file">` interaction
- **any write that would replace a protected value** (the `DO-NOT-MODIFY` veto)

The veto is deterministic, so it defends the golden corners (card / PAN / email) against a
**hostile or malformed `/act` response**, not just an honest model making a mistake. Redacted rects
are also given a fake element id that maps to nothing — watermark-locked.

**Human-in-the-loop (`ask`, protocol v2):** the VLM can emit `{"type":"ask","question","options"}`,
which is **never dispatched to the page**. It surfaces as a card in the side panel *and* a
shadow-DOM banner on the page, and blocks until answered. Plus a narrow deterministic
Proceed/Cancel confirm gate on task-complete `done` and cross-origin `navigate`.

### 2.7 Agent loop & recovery (`entrypoints/background.ts`)

- Max 15 steps, 750 ms inter-step throttle (Chrome rate-limits `captureVisibleTab` to ~2/sec),
  history capped to 6 steps with older steps degraded to text-only.
- **3-tier self-healing:** auto-descend to the deepest visible input → within-run feedback
  injected into history → cross-run per-host `sihLessons` (verified-only, cap 8).
- `/rethink` with a structural repeat-veto and an untried-element escape hatch. No-progress
  fingerprinting → rethink fires on the 5th identical step.
- **MV3 keep-alive pokes** every 12 s (real `browser.runtime.getPlatformInfo()` calls) bracketing
  long awaits — Chrome suspends an MV3 service worker after ~30 s idle and `setTimeout` doesn't
  count as activity.

### 2.8 UI surfaces

| Surface | What it does |
|---|---|
| **Side panel cockpit** (`#0b1220` dark) | Task box, agent-state pill, 5-stage pipeline strip with a **GATE node that flashes PASS/BLOCKED**, privacy hero card (`detected / protected / raw-values-sent`), stable-token map, before/after "your screen vs what the AI sees", structured decision trace, activity log, session history |
| **Privacy Lens** | One-key live scan highlighting every sensitive region on the page, with type tags |
| **AI View** | Flips the live page into *exactly* what the model sees — PII as tokens, Set-of-Marks chips on every interactive element |
| **Floating PRIVYSE orb** | Draggable status dot, closed shadow root, `z-index: 2147483647`, expands to a live `CAPTURE · SANITIZE · GATE · REASON · ACT · step n` pill, hides itself during capture |
| **Forensic exhibit** | Filmstrip evidence rail of per-step frames, clickable redaction map, printable **privacy receipt** (by-type tally, deduped token list, gate verdict) |
| **Virtual cursor + spotlight** | Makes the agent's action visible in the page |
| **Spotlight palette** | `Alt + K` — run, step-one, stop, cursor toggle, model switching, VLM health check, overlay toggles |

### 2.9 Server (`server/app.py`, `routing.py`, `prompts.py`)

FastAPI + Ollama. Endpoints: `/health` · `/act` · `/act/stream` (SSE) · `/rethink` ·
`/rethink/stream` · `/warm` (with `keep_alive` model pinning) · `/models`.

Works with Ollama by default, and against **any** OpenAI-compatible VLM (vLLM, TGI, OpenRouter,
OpenAI) by overriding `OPENAI_BASE_URL` / `VLM_API_KEY`. Ships with a `Dockerfile` +
`docker-compose.yml` (optional GPU Ollama profile).

### 2.10 Ground-truth test site (`test-site/`)

Synthetic pages where every PII element carries a `data-gt` attribute: `pii-in-the-wild.html` ·
`india-pii.html` (KYC) · `flight-booking` / `flight-payment` · canvas PII · SVG PII ·
adversarial pages. AI-generated faces, license-safe.

### 2.11 Benchmark harness (`benchmarks/`)

| Script | Purpose |
|---|---|
| `run.mjs` | Sanitizer P/R + zero-leak + latency → `results/latest.json` |
| `aggregate.mjs` | Merge → `results/dashboard.json` |
| `perception-eval.mjs` | MobileViT labelled-tile accuracy |
| `executor-guard.test.mjs` | Offline executor safety (27/27) |
| `adversarial-bench.mjs` | Adversarial privacy pipeline (30/30) |
| `act-spot-check.mjs` | Live `/act` round trip + forged hostile responses (10/10) |
| `vlm-bench.mjs` | Full agent loop, per-phase p50/p95, waterfalls |
| `latency-probe.mjs`, `prefill-probe.mjs`, `probe-{batch,enter,perception,cache}.mjs` | Latency decomposition |
| `demo-images.mjs` | Regenerates the three README demo screenshots |
| `mock-act-server.mjs` | Scripted `/act` stub — makes the human-in-the-loop path deterministic and testable |
| `google-search-loop.mjs` | Real-world loop test |

**Metric methodology:** pixel precision/recall from rasterized masks of predicted vs GT boxes
clipped to the captured viewport; box match at IoU ≥ 0.5; zero-leak verified twice (DOM regex +
OCR of the exact uploaded bytes).

### 2.12 Cross-browser

One codebase → **Chrome MV3** (offscreen document hosts the models, side panel UI) and
**Firefox MV2** (background page *is* the DOM host, sidebar UI, `sidebar_action`). Both builds
succeed; `tsc --noEmit` is clean.

---

## 3. Verified numbers

Source of truth: `benchmarks/results/dashboard.json`. Every number below regenerates from the
harness — say that on the slide if a judge asks.

### 3.1 Quality

| Metric | Result |
|---|---|
| **PII detection F1 (pixel)** | **0.984** |
| Precision | 0.968 |
| **Recall** | **1.000** — caught every ground-truth PII element |
| Redaction precision | 0.968 |
| **Zero-leak** | **PASS** (DOM regex + OCR of sanitized pixels) |
| ViT page classification | 7/7 pages |
| Photo vs blank accuracy | 100% |
| Face detection (Tier C) | 2/2 |
| Canvas account via OCR | 2/2 |
| IFSC detection | 1/1 |
| **VLM task accuracy** | 7B **3/3** · 3B **2/3** (fails prose-read) · routed **2/3** per latest dashboard |

### 3.2 Security

| Suite | Result |
|---|---|
| Adversarial privacy pipeline | **30 / 30 blocked** |
| Executor guard tests | **27 / 27 passed** |
| Live `/act` hostile-response spot-check | **10 / 10** |

Adversarial coverage: canvas PII · SVG PII · tiny text · image-based PII · obfuscated values ·
visual prompt injection · text prompt injection · exfiltration via `data:`/`blob:`/`javascript:`
form actions · hostile `/act` responses · non-HTTP navigation · file inputs · protected-field
overwrite attempts.

### 3.3 Resources

| | |
|---|---|
| **Raw data off-device** | **0 MB** — no CDN, every weight vendored |
| Model weights | 8.15 MB |
| **Total on-device assets** | **56.9 MB** (dominated by the 27.8 MB `.jsep` runtime + 11.8 MB MediaPipe WASM) |

### 3.4 Latency

| Stage | p50 |
|---|---|
| Capture | 73 ms |
| Serialize | 0.7 ms |
| Sanitize | 86 ms |
| On-device vision | 34 ms (first ≈1.4 s, cached **0 ms**) |
| Execute | 1.1 ms |
| **VLM** | **14 211 ms** ← the bottleneck |
| **End-to-end routed 3B/7B** | **≈12.7–13 s/step** (interactive 3B steps ≈7.5–8.0 s) |

**Latency levers shipped:** WebP q=0.7 @ 1280 px cap · history capped to 6 steps (older =
text-only) · compact system prompt (−60% tokens) · `VLM_MAX_TOKENS` 64 · `NUM_CTX` 8192 ·
temperature 0 · prefix caching · `keep_alive` model pinning (no 20–60 s cold start) ·
**perception-driven 3B/7B routing** (7B e2e 21.2 s → 12.7 s) · pixel-hash perception cache.

**Root cause of the remaining gap — diagnosed, not guessed:** on an RTX 3050 4 GB, `qwen2.5vl:7b`
(6.2 GB) runs **75% CPU / 25% GPU**. Image tokens floor at ~1024, so prefill+decode are CPU-bound
and a *minimal-prompt* probe already costs ~10.5 s. This is architectural on 4 GB hardware, not a
code defect. Target is `p50 < 5 s/step` on a judge-class GPU.

---

## 4. Assets you can put straight on slides

| Asset | Path |
|---|---|
| Raw user screen (live UPI / voter ID / DL / passport) | `docs/readme/demo-india-pii-user-view.png` |
| Gate's view — redaction boxes + tokens drawn over each field | `docs/readme/demo-india-pii-gate-view.png` |
| **The exact bytes the VLM receives** | `docs/readme/demo-india-pii-model-view.png` |
| Architecture vector master (SVG) | `docs/Report/architecture.svg` |
| Same, LaTeX/TikZ source | `docs/Report/architecture.tex` |
| Full technical write-up (450 lines) | `docs/prototype-report.pptx-materials.md` |
| Prototype report (PDF) | `docs/Report/SIH26171_final_prototype_brief.pdf` |
| Pitch document (PDF) | `docs/PITCH.pdf` |
| Human-in-the-loop test matrix (25 cases) | `docs/hitl-test-matrix.md` |
| Fail-closed design audit | `docs/perception-failure-path-audit.md` |
| Latency budget model | `docs/latency-budget-judge-gpu.md` |
| Raw metrics JSON | `benchmarks/results/dashboard.json` |
| Deck generator | `create_presentation.py` |
| Presenter script | `PRESENTER_CHEATSHEET.md` |

The three `demo-india-pii-*.png` images were generated through the **real production pipeline**,
not mocked. They make a natural **before → gate → model** filmstrip.

---

## 5. Honest limitations — read before you build any slide

**These are the things that will bite you if you take an older number at face value.**

1. **`p50 < 5 s/step` is NOT met.** 12.7 s measured. The cause is diagnosed and documented (§3.4).
   Present it as a hardware limit + a routing strategy, not as a miss.
2. **Routed VLM accuracy is 2/3, not 3/3**, on the current dashboard. `README.md` still says 3/3
   in two places — that number predates the 14 Sep dashboard regeneration. **Use 2/3.**
3. **Total on-device assets are 56.9 MB**, not the 21.4 MB claimed in `PRESENTER_CHEATSHEET.md`
   (and not the 2.2 MB weights figure from the same file — weights alone are 8.15 MB). The 56.9 MB
   includes the WebGPU/WASM runtimes. **Use 56.9 MB total / 8.15 MB weights.**
4. **PII F1 is 0.984**, not the 0.979 in `PRESENTER_CHEATSHEET.md` and older deck scripts. The
   architecture SVG footer was already corrected to 0.984. **Use 0.984.**
5. **Firefox has never been run in a real browser.** The build succeeds and type-checks, and the
   MV2 host abstraction is written, but no on-device Firefox smoke test has happened (this machine
   has no Firefox). **Say "built and type-checked", not "tested".**
6. **Zero-leak OCR is occasionally nondeterministic** — ~1 failure in 4 full runs, always a
   *fail-closed block* on a blur-sample variance, never a leak. This is the correct behaviour, but
   it is noise, not a clean 100%.
7. **Two High-severity open defects** from the human-in-the-loop audit, both identified by us and
   both being fixed first:
   - **D2 — currently breaks the core privacy claim.** `history[].result` and `task` enter the
     outbound body **untokenized**, and `zero-leak.ts` only walks `body.dom[].text/value`. A PAN
     typed into a human-in-the-loop answer would leave in plaintext with the gate blind to it.
   - **D1 — fail-open safety gate.** The risky-action confirm detects Cancel only via
     `startsWith("cancel")`, so typing `no` executes the action, including `done` on a payment
     flow. Needs an explicit allow-list.
   - Do **not** diagram the privacy boundary as airtight until D2 is closed. If it is fixed and
     verified, it makes a strong "we audited ourselves" visual — judges reward that.
8. **No CI.** The 25-case HITL matrix is manual only. The existing benches inject the in-page
   bundle via `addScriptTag` and never load the extension, so they cannot reach the service
   worker, panel, or banner. Automation is specified (Chrome `--headless=new` +
   `--load-extension` → `context.serviceWorkers()`) but unbuilt.
9. **An unexplained target-validation mismatch remains** — the model predicts DOM id 6 and the
   server claims it doesn't exist. Prime suspect is divergence between the serialized DOM and the
   sanitized DOM the server sees. Not root-caused.
10. **Docker path is unverified** — Docker was unavailable on this machine, so `docker compose` was
    never run.

### Failed experiments (don't repeat these)

| Experiment | Result | Verdict |
|---|---|---|
| **moondream** | **0 valid actions in 36 steps**; 757 ms/step; fits in 4 GB VRAM | Rejected — cannot emit the action schema, despite being fast and GPU-resident |
| **NVIDIA LocateAnything-3B / MoonViT** | Referring/grounding model, not a planner; no Ollama path; VRAM-hostile next to Qwen | Rejected as runtime, kept as prior art |
| **PaddleOCR.js** | Benchmarked against Tesseract.js | Tesseract retained |
| **3-minute vision blackout** on model load | Killed a real session mid-run | Replaced with per-step retry + parallel warm |
| Gating *every* Enter with a confirm prompt | Froze the loop | Narrowed to `done` + cross-origin `navigate` only |
| Page-as-canvas inspector / agent-as-narrator UI directions | Rejected in design review | Cut in favour of the cockpit + floating surfaces |

---

## 6. How it was built (chronology)

23 days, 16 working sessions, 4 commits, one continuous build from an empty repo to a demoable
cross-browser extension. Timeline in `SIH26171_build_plan.md`; full chronological log in the
`session-ses_*.md` files in the repo root.

| Phase | Status | Exit criterion |
|---|---|---|
| **0 — Scaffold** | ✅ | Screenshot → server → canned action round-trip |
| **1 — End-to-end spine** | ✅ | Unattended search task runs; sanitizer + real VLM + executor live |
| **2 — On-device vision** | ✅ | Page with a face + PII-in-an-image, both caught, loop still completes |
| **3 — GT test site + metrics** | ✅ | One click runs the suite; dashboard shows all five rubric metrics |
| **4 — Hardening / cross-browser / demo** | 🟡 | Firefox build ✅, Firefox runtime test ❌, demo video ⬜ |

**A note on how the work went:** the most valuable sessions were the ones that *audited our own
claims* — the metric audit against `dashboard.json` that caught three inflated numbers, the
latency root-cause that proved the GPU spill was hardware not code, and the failed-experiment
checks. If you want one process note for the deck, that's the honest one.

---

## 7. Repo layout

```
PRIVYSE/
├── extension/                 WXT extension (Chrome MV3 + Firefox MV2)
│   ├── core/                  sanitizer · pii-rules · zero-leak · perception ·
│   │                          vision · vision-host · action-guards · protocol ·
│   │                          orb · privacy-lens · ai-view · filmstrip ·
│   │                          redaction-map · receipt · executor · dom-serializer
│   ├── entrypoints/           background · content · sidepanel · offscreen
│   └── public/models/         bundled weights + WebGPU/WASM runtimes (no CDN)
├── server/                    FastAPI — /health /act /rethink /models · routing.py
│   ├── Dockerfile             container image
│   └── docker-compose.yml     server + optional Ollama GPU profile
├── test-site/                 GT-labelled pages (PII · faces · canvas · Indian KYC ·
│                              perception GT · adversarial)
├── benchmarks/                run.mjs · aggregate · perception-eval · executor-guard ·
│                              adversarial-bench · vlm-bench · act-spot-check ·
│                              latency probes · demo-images · mock-act-server
├── docs/                      this brief · PS brief · visual-research brief ·
│                              prototype-report materials · architecture master ·
│                              HITL matrix · failure-path audit · latency budget ·
│                              pitch + report PDFs
├── create_presentation.py     the deck generator
└── PRESENTER_CHEATSHEET.md    presenter script (⚠ has stale numbers — see §5)
```

---

## 8. How to run it

```powershell
# 1 — server
cd C:\SIH\26171\server
.\.venv\Scripts\activate
uvicorn app:app --reload                 # → http://127.0.0.1:8000/health

# 2 — build the extension
cd C:\SIH\26171\extension
npm install
npm run build                            # → .output/chrome-mv3
npm run build:firefox                    # → .output/firefox-mv2

# 3 — load it
#    Chrome:   chrome://extensions → Developer mode → Load unpacked
#              → C:\SIH\26171\extension\.output\chrome-mv3
#    Firefox:  about:debugging → Load Temporary Add-on → manifest.json

# 4 — run the benchmarks
cd C:\SIH\26171\benchmarks
npm run build
node run.mjs                             # sanitizer P/R + zero-leak + latency
node aggregate.mjs                       # → results/dashboard.json
```

**Optional:** perception routing via `$env:PERCEPTION_ROUTING = "1"`, `$env:VLM_MODEL_SMALL =
"qwen2.5vl:3b"`, `$env:VLM_MODEL_BIG = "qwen2.5vl:7b"`. Any OpenAI-compatible VLM works by setting
`OPENAI_BASE_URL` + `VLM_API_KEY`.

**Demo recipe that actually lands:** open a GT-labelled page → run a task in the panel → open the
**Network tab** and show that only sanitized payloads leave, to `127.0.0.1:8000` → show the
before/gate/model screenshot trio.

---

## 9. Known doc/code drift (fix before you quote anything)

| Claim | Reality |
|---|---|
| `PRESENTER_CHEATSHEET.md`: HITL safety net is 120 s | `ASK_TIMEOUT_MS = 25000` (25 s) |
| `server/app.py`: `PROTOCOL_VERSION = 1` | `protocol.ts`: `PROTOCOL_VERSION = 2` |
| `PRESENTER_CHEATSHEET.md`: 21.4 MB total / 2.2 MB weights | 56.9 MB total / 8.15 MB weights |
| `README.md`: routed accuracy 3/3 | `dashboard.json`: 2/3 |
| `README.md` + cheat-sheet: F1 0.979 | `dashboard.json`: **0.984** |

---

## 10. If you only remember five things

1. The model **never sees the raw screen** — a sanitizer and a fail-closed gate sit in front of it.
2. **F1 0.984 with recall 1.000** on ground-truth pages; **0 MB** raw data off-device.
3. **30/30 adversarial blocked, 27/27 guards passed** — the safety claims are tested, not asserted.
4. Latency is **12.7 s/step against a 5 s target**, and we can explain exactly why (4 GB VRAM, not
   code).
5. We **audited our own claims and corrected three inflated numbers.** That is the most
   defensible thing in the repo.
