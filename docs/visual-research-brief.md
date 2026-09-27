# PRIVYSE — SIH 2026 PPT Visual Research Brief

> **Status:** open task for a research partner. No code, no repo work — only search, read, compare, recommend.
> **Deliverable:** this file, filled in, committed to a branch.

---

## 0. The ask (read this first)

I'm building the SIH 2026 presentation for our project **PRIVYSE**. Right now the deck is
text-heavy and I want it to be **visual** — real diagrams, not decorative clipart.

**Your job: research and recommend diagram / visual-framework ideas we can use, mapped
slide-by-slide.**

You are NOT designing the deck. You are NOT writing slides. You are producing a **visual
recommendation document**. I (or my teammate) will build the actual PPTX from your
recommendations.

**Deliverable:** one markdown file, `docs/visual-framework-brief.md`, that answers: *for each
slide, what information from our project converts into a strong visual, and exactly what that
visual should look like.*

**Timebox:** 1–2 days is fine. Depth over speed.

---

## 1. What PRIVYSE is

**One-liner:** *A privacy-preserving browser agent that redacts your Aadhaar, PAN, cards, OTPs
and faces **on your own device** before anything is sent to an AI model.*

**Track:** SIH 2026 Research Track, Problem #26171 — *On-device Visual Perception for
Light-weight Browser Agents*

**The core thesis:**

> Sensitive information should be protected **before** an AI ever gets the opportunity to see it.

**The pipeline (memorise this, it drives every diagram):**

```
CAPTURE → PERCEIVE → SANITIZE → GATE → REASON → ACT
```

**The core trick:** traditional browser agents screenshot the page and upload the raw pixels to
a cloud vision model. PRIVYSE puts a **privacy choke point** between the browser and the model.
The model never receives the raw screen — only a sanitized screenshot + a numbered DOM + a
compact on-device perception block. And a **fail-closed gate** re-verifies the exact bytes that
would be uploaded before they leave.

---

## 2. Why this matters (the stakes — use this in diagrams)

India runs on Aadhaar, PAN, UPI, voter ID, driving licence and passport numbers. A raw
screenshot of an Indian KYC or banking page is a complete identity-theft kit. That is why
"raw screenshot → cloud model" is unacceptable here, and it is the emotional hook for the
Problem and Impact slides.

---

## 3. The scoring rubric — every diagram must serve one of these

Judges score on exactly five weighted criteria. **Any diagram that doesn't help prove one of
these is decoration — cut it.**

| Weight | Criterion | What we have to prove |
|---|---|---|
| **25%** | Visual-context accuracy | The sanitized payload is still rich enough for the model to act correctly |
| **20%** | PII detection recall & precision | We catch the PII, we don't over-redact |
| **20%** | Redaction precision | Pixel-level accuracy of the redaction masks |
| **20%** | Client resource utilization | Small models, WebGPU, all weights bundled, nothing off-device |
| **15%** | End-to-end latency | Per-stage breakdown, routing strategy |

---

## 4. What is already built (ground your diagrams in these real facts)

Everything below is **implemented and measured** in a working Chrome MV3 + Firefox MV2
extension with a FastAPI backend. Do not invent numbers.

### 4.1 Architecture (real, running)

| Stage | What actually happens |
|---|---|
| **01 Capture** | `captureVisibleTab` + DOM walker (shadow-root aware), ≤120 elements, `id · label · role · value`, bbox × devicePixelRatio |
| **02 Perceive** | **On-device**: MobileViT-Small (q8 ONNX, 6.3 MB) page classification · BlazeFace face detection · Tesseract.js region-restricted OCR — all three run in parallel. WebGPU EP first, automatic WASM fallback. |
| **03 Sanitize** | **Tier A / Tier B / Tier C** redaction + stable privacy tokens + Set-of-Marks `[N]` tags |
| **04 Gate** | **Zero-leak gate**: regex-scan the outbound DOM JSON **AND** OCR-scan the exact sanitized screenshot bytes. Fail-closed. |
| **05 Send** | Only the redacted JPEG + numbered DOM cross the boundary |
| **06 Reason** | FastAPI builds the prompt, routes Qwen2.5-VL **3B or 7B** from the on-device tile map, Ollama returns exactly one JSON action |
| **07 Execute** | Content-script executor: resolve id → scrollIntoView → pointer/keyboard, through a guard layer |
| **08 Loop** | `/rethink` recovery, per-host lessons, DO-NOT-REPEAT, until `done=true` |

### 4.2 Three-tier privacy system (a core visual)

| Tier | Information | Protection |
|---|---|---|
| **Tier A** 🔴 | Passwords, OTPs, CVVs, API keys | Solid black box — no text, no token |
| **Tier B** 🟠 | Email, phone, PAN, Aadhaar, UPI, voter ID, driving licence, passport, cards, names, addresses, IFSC, account number | **Stable privacy tokens** — `[EMAIL_1]`, `[PAN_1]`, `[CARD_1]`, `[UPI_1]` (same value → same token, so the model keeps continuity without ever seeing the secret) |
| **Tier C** 🟣 | Faces, canvas text, video, non-DOM graphics, tiny visual text | Irreversible blur / region taint |

### 4.3 Guarded execution (safety layer)

Action guards refuse: `javascript:` `file:` `data:` `blob:` `about:` · non-HTTP form actions ·
`<input type="file">` interaction · any write that would replace a redacted value
(**DO-NOT-MODIFY veto**). Plus a human-in-the-loop `ask` action and a deterministic
Proceed/Cancel confirm gate on task-complete and cross-origin navigation.

### 4.4 Verified numbers (source of truth — `benchmarks/results/dashboard.json`)

| Metric | Value |
|---|---|
| PII detection F1 (pixel) | **0.984** (precision 0.968, **recall 1.000**) |
| Redaction precision | 0.968 |
| Zero-leak | **PASS** (DOM regex + OCR of sanitized pixels) |
| Face detection | 2/2 · Canvas OCR 2/2 · IFSC 1/1 |
| ViT page classification | 7/7 pages · photo-vs-blank 100% |
| Adversarial suite | **30/30 blocked** |
| Executor guard tests | **27/27 passed** |
| Live `/act` hostile-response spot-check | 10/10 |
| Raw data off-device | **0 MB** (no CDN, all weights vendored) |
| On-device assets | **56.9 MB** total (8.15 MB model weights + WebGPU/WASM runtimes) |
| Latency, routed 3B/7B | **≈12.7–13 s/step** (interactive 3B steps ≈7.5–8.0 s) |
| Latency stages (p50) | capture 73 ms · serialize 0.7 ms · sanitize 86 ms · vision 34 ms · execute 1.1 ms · VLM 14 211 ms |
| Perception cache | first ≈1.4 s → cached **0 ms** on unchanged page |
| VLM accuracy | 7B: 3/3 tasks · 3B: 2/3 (fails prose-read) · routed: **2/3** per latest dashboard |

### 4.5 Latency levers already implemented

WebP q=0.7 at 1280 px cap · history capped to 6 steps (older = text-only) · compact system
prompt · `VLM_MAX_TOKENS` 64 · `NUM_CTX` 8192 · temperature 0 · prefix caching · `keep_alive`
model pinning · **perception-driven 3B/7B routing** (interactive → 3B,
read/report/captcha → 7B) · pixel-hash perception cache.

### 4.6 Real assets I can drop straight onto slides (use these in diagrams)

- `docs/readme/demo-india-pii-user-view.png` — raw screen with live UPI / voter ID / DL / passport
- `docs/readme/demo-india-pii-gate-view.png` — same page with redaction boxes + tokens drawn over each field
- `docs/readme/demo-india-pii-model-view.png` — **the exact bytes the VLM receives**
- `docs/Report/architecture.svg` — existing architecture vector master (LaTeX/TikZ source at `docs/Report/architecture.tex`)
- Sidepanel UI: 5-stage pipeline strip with a flashing GATE node, privacy hero card
  (`detected / protected / raw-values-sent`), stable-token map, before/after "your screen vs what
  the AI sees", filmstrip evidence rail, printable **privacy receipt**
- Floating PRIVYSE orb, Privacy Lens (live PII region highlighter), AI View mode

### 4.7 Honest limitations and open defects (the deck should own these)

- **Target `p50 < 5 s/step` is not met** — 12.7 s measured. Root cause: Qwen2.5-VL 7B is 6.2 GB
  and spills to 75% CPU on an RTX 3050 4 GB; image tokens floor at ~1024, so even a minimal
  prompt costs ~10.5 s. This is architectural on 4 GB hardware, not a code defect.
- **Firefox is built and type-checked but never actually run** on a real Firefox instance.
- **Routed VLM accuracy is 2/3**, not 3/3, on the current dashboard. Do not put 3/3 in a diagram.
- **Total on-device assets are 56.9 MB**, not the 21.4 MB an older internal cheat-sheet claims.
  Use 56.9 MB.
- **Zero-leak OCR is occasionally nondeterministic** — roughly 1 failure in 4 full runs, always a
  *fail-closed block* on a blur-sample variance, never a leak.
- **No CI.** The human-in-the-loop test matrix (25 cases) is manual only; the automation plan
  (`--headless=new` + `--load-extension` → `benchmarks/hitl.test.mjs`) is specified but unbuilt.

**Two High-severity open defects, found by our own HITL audit. Both are being fixed first.**

- **D2 (High) — currently breaks the core privacy claim.** `history[].result` and `task` enter
  the outbound body **untokenized**, and `zero-leak.ts` only walks `body.dom[].text/value`. A
  PAN typed into a human-in-the-loop answer would leave in plaintext with the gate blind to it.
  **No diagram may depict the privacy boundary as airtight until this is closed.** If it is fixed
  and verified, it becomes an excellent "adversarial thinking / we audited ourselves" visual.
- **D1 (High) — fail-open safety gate.** The risky-action confirm gate detects Cancel only via
  `startsWith("cancel")`, so typing `no` instead of clicking Cancel executes the action, including
  `done` on a payment flow. Needs an explicit allow-list rather than a blocklist.

> **If either defect suggests a good "known issues / self-audit" visual, flag it.** Judges reward
> teams that find and fix their own holes. This is optional — do not build it at the cost of a
> core diagram.

---

## 5. The deck — diagrams need a home

### 5.1 Our working 14-slide deck (`PRIVYSE_SIH26171_Presentation.pptx`)

| # | Slide title | What it must prove | Diagram opportunity |
|---|---|---|---|
| 1 | Title | — | — |
| 2 | **Browser Agents Leak Everything** | the problem | before/after, data-flow of raw pixels leaving |
| 3 | **Sanitize Before You Send** | the one-line solution | Venn of Privacy ∩ Local AI ∩ Cloud Reasoning |
| 4 | **How It Works — End-to-End Flow** | architecture | 8-stage pipeline / swimlane |
| 5 | **Three-Tier On-Device Redaction** | how privacy works | tier decision tree, layered shield |
| 6 | **Performance That Speaks** | results | hero metric cards, radar chart, bar charts |
| 7 | **Automated, Reproducible, Scoring-Aligned** | the benchmark harness maps to the rubric | 2×2 / weighted coverage matrix |
| 8 | **Built for Privacy & Performance** | tech stack | layered architecture |
| 9 | **What No Other Agent Does** | competitive edge | comparison table, 2×2 positioning map |
| 10 | **Optimized for Modest Hardware** | latency engineering | latency waterfall / stacked bar |
| 11 | **Defense in Depth — No Soft Fail** | zero-leak + guards | threat→protection mapping, shield layers |
| 12 | **Why This Matters** | impact | stakeholder hub-and-spoke |
| 13 | **Live Walkthrough — 3 Minutes** | demo | filmstrip of the 3 real screenshots |
| 14 | Questions? | — | — |

### 5.2 SIH's official mandated section structure

SIH's template (`ppt-final/*.png`) mandates these sections. **We do not yet know whether the
final deck must follow this structure instead of §5.1.** Design for **both** and tell us the
remapping.

| SIH mandated section | Likely PRIVYSE slides it absorbs |
|---|---|
| `TITLE` | 1 |
| `TECHNICAL APPROACH` | 3, 4, 5, 8 — solution, architecture, three-tier, stack |
| `FESABILITY AND VIABILITY` | 6, 7, 10 — results, benchmarks, latency |
| `IMPACT AND BENIFITS` | 9, 12 — competitive edge, why this matters |
| `RESEARCH AND REFERENCE` | 11 + prior-art citations — zero-leak, threat→protection |

**Required:** a second mapping table, SIH section → recommended visual → difficulty → one-line
spec. **Flag any diagram that only works in one of the two structures**, and say which structure
it favours.

---

## 6. YOUR TASK — research these 18 diagram concepts

For each one, tell me whether it's worth using, and how.

| # | Diagram concept | Why it might fit PRIVYSE |
|---|---|---|
| 1 | **Venn diagram** | relationship between Privacy, Local AI, and Cloud Reasoning |
| 2 | **Pipeline / flow** | Capture → Sanitize → Gate → Reason → Act |
| 3 | **Gantt / timeline** | development phases, or per-step execution timeline |
| 4 | **Priority triangle / pyramid** | Privacy → Accuracy → Latency → Resource usage trade-off |
| 5 | **Layered architecture** | extension / on-device vision / privacy core / server / VLM |
| 6 | **Before vs After** | naive cloud browser agent vs PRIVYSE |
| 7 | **Data-flow diagram** | what stays on-device vs what reaches the server |
| 8 | **Threat → Protection mapping** | 8 attack classes → the specific defence that stops each |
| 9 | **Decision tree** | can this data be transmitted, or must it be redacted? |
| 10 | **2×2 matrix** | privacy risk vs visual sensitivity, or rubric weight vs our strength |
| 11 | **Funnel** | raw screen → detected information → sanitized context → actionable output |
| 12 | **Feedback loop** | agent observes → reasons → acts → observes again |
| 13 | **Radar / metric visualisation** | our 5 evaluation criteria |
| 14 | **Comparison diagram** | traditional cloud agent vs privacy-preserving browser agent |
| 15 | **Layered privacy shield** | DOM → OCR → Vision → Redaction → Gate |
| 16 | **Latency breakdown** | perception / sanitization / gate / reasoning / execution |
| 17 | **Risk pyramid** | low → medium → high-risk actions and who authorises each |
| 18 | **Hub-and-spoke** | major components around the privacy boundary |

**Add any diagram type you think we've missed** that would make a strong research/hackathon deck.
If you find something better than one of the 18, say so.

### Required output format — for EACH diagram idea

1. **Diagram type** (e.g. "swimlane flowchart", "stacked bar", "Sankey")
2. **What it would represent in PRIVYSE** — the actual argument it makes, not a generic description
3. **Which PPT slide it fits on** (use the numbering in §5.1, and the section in §5.2)
4. **What elements/labels go inside it** — be literal. Give me the exact box text, axis labels, legend entries, node names. This is the most important field. I need to be able to build it without guessing.
5. **Design difficulty: easy / medium / difficult** — and *why* (e.g. "easy: 5 rectangles and arrows, python-pptx can do this")
6. **2–3 alternative visual formats for the same information** — so I can pick

### Also required

- **A "what data do I actually have?" note.** For every diagram, name which verified number,
  screenshot, or code fact from §4 feeds it. If a diagram needs a number we haven't measured, say
  so explicitly — I would rather cut it than fabricate it.
- **A cut list.** Tell me which of the 18 ideas are weak for this project and should be dropped.
  Fewer, stronger diagrams beat more diagrams.
- **A slide-by-slide visual plan.** A table: slide number → recommended visual → difficulty →
  one-line spec. This is the single most useful thing you can produce.

---

## 7. Design constraints — what is actually buildable

- The deck is generated with **python-pptx** (`create_presentation.py` in the repo root). 16:9,
  13.333 × 7.5 inches. So: **native PPT shapes are free; embedded images are fine; actual native
  charts are painful.** Tell me honestly which diagrams are better as native shapes vs. exported
  images.
- We already have `docs/Report/architecture.tex` → LaTeX/TikZ → SVG → PDF as a proven toolchain,
  and Mermaid diagrams are already used extensively in the README. **If you recommend a diagram we
  can generate as SVG/PDF and embed, say so** — that unlocks far better visuals than native shapes.
- **Dark theme palette already chosen:** background `#0B0E17`, card `#121725`, accents cyan
  `#00B4D8`, green `#00E676`, purple `#7C3AED`, orange `#FF6B35`, red `#EF4444`, yellow `#FFD600`,
  grey `#A0AEC0`. **Recommend diagrams that work on a dark background**, or tell me if a specific
  one needs a light variant.
- Judges get ~60 seconds per slide. **Anything that needs a paragraph to explain is too complex.**
  Flag any idea that is elegant but slow to read.

---

## 8. Inspiration to mine

Find real examples — not textbook clipart — and tell me which slide each one informs:

- **Security / privacy conference decks** — how do they visualise trust boundaries and data
  egress? (BlueCon, DEF CON, Black Hat, IEEE S&P, USENIX Security programme talks)
- **Systems papers** — Figure 1 of a top-tier paper (NSDI, OSDI, SOSP, EuroSys). What makes a
  systems pipeline figure readable at a glance?
- **AI agent / computer-use talks** — how do BrowserGym, WebArena, OpenAI Operator, Anthropic
  computer-use, UI-TARS, browser-use present their architecture?
- **Good hackathon pitch decks** — what visual actually lands in 60 seconds?
- **Set-of-Marks prompting** (Yang et al.) — the technique behind our numbered `[N]` element tags.
  Worth a citation visual.
- **Privacy-engineering explainers** — how do Mozilla, Apple, Signal, or Proton explain "this never
  leaves your device"? Their metaphors are probably the best models for our Problem and Impact slides.

For each: **link + one line on what to steal from it.** Screenshots or descriptions of the specific
figure/frame are ideal.

---

## 9. Rules

1. **No fabrication.** Every number must come from §4.4. If you want a number we don't have, flag
   it as a gap.
2. **Relevance over decoration.** If a diagram would be equally at home in an unrelated project, it
   fails.
3. **60-second test.** If you can't describe what the audience learns in one sentence, cut it.
4. **Readability at the back of the room.** Font size, label length, and contrast matter. Flag
   anything that will be illegible when projected.
5. **Deliver in markdown, in the repo, at `docs/visual-framework-brief.md`.** Commit to a branch.

---

## 10. Stretch goal (only if the core is done)

Sketch the **one hero visual** for the whole deck — the single image that, if we could only show
one, would make a judge understand PRIVYSE in 5 seconds. Argue for why that one.

---

## Reference material in the repo

Read these before you start:

| File | What it gives you |
|---|---|
| `README.md` | Full system write-up; already has 8 Mermaid diagrams you can lift |
| `SIH26171_browser_agent.pdf` | The original problem statement |
| `SIH26171_build_plan.md` | Phased plan + the scoring map |
| `docs/prototype-report.pptx-materials.md` | 450 lines of already-written technical depth |
| `docs/Report/architecture.tex` | The existing TikZ architecture master |
| `benchmarks/results/dashboard.json` | The raw verified metrics |
| `create_presentation.py` | The current deck generator, so you know what's cheap to build |
| `docs/latency-budget-judge-gpu.md` | Latency budget model for judge-class GPU |
| `docs/hitl-test-matrix.md` | 25-case human-in-the-loop test matrix |
| `docs/perception-failure-path-audit.md` | Fail-closed design audit |
| `docs/Research and Reference` / `Competitive Landscape.pptx` | Prior-art landscape already compiled |

---

## Quick reference card (print this)

```
PIPELINE      CAPTURE → PERCEIVE → SANITIZE → GATE → REASON → ACT
TIERS         A = black box | B = stable token | C = blur
BOUNDARY      raw screen NEVER leaves; only redacted JPEG + numbered DOM
GATE          DOM regex + pixel OCR, fail-closed (gate can't run → BLOCKED)
GROUNDING     integer element ids [N], never coordinates
MODELS        MobileViT-Small 6.3MB · BlazeFace · Tesseract.js · Qwen2.5-VL 3B/7B

HERO NUMBERS  F1 0.984 (P 0.968 / R 1.000) · zero-leak PASS · 30/30 adversarial
              27/27 guards · 10/10 live hostile · 0 MB off-device · 56.9 MB on-device
HONEST        12.7 s/step vs 5 s target (4 GB VRAM limit) · routed accuracy 2/3
              Firefox unrun in real browser · 5 known defects, 2 High, both being fixed
```
