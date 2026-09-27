# PRIVYSE — Visual Framework Brief

> **Deliverable for** `docs/visual-research-brief.md`. Research + recommendation only. No slide design.
> **Ground truth:** `benchmarks/results/latest.json` (17 Sep) + `benchmarks/results/dashboard.json` (14 Sep) +
> `extension/core/pii-rules.ts` + `extension/core/action-guards.ts` + `benchmarks/adversarial-bench.mjs`.
> **Rule honoured:** every number below is read from a file in this repo. Gaps are flagged in §7, not invented.

---

## 0. TL;DR — the 5 charts that actually do the work

Of the 18 concepts, **5 carry the deck** and **9 are decoration**. Build these:

| # | Visual | Slide | Why it wins |
|---|---|---|---|
| 1 | **Three-panel paradigm ladder** (naive / local-only / hybrid) | 2 + 3 | The single clearest argument PRIVYSE exists. Borrowed from GUIGuard Fig. 2. |
| 2 | **Swimlane pipeline** with a hard trust boundary | 4 | Proves architecture *and* proves the boundary in one image. |
| 3 | **Per-category P/R dot plot** (14 categories) | 6 | Judges cannot fake this. Recall 100% everywhere, one honest weak bar. |
| 4 | **Latency waterfall with the 97% band exploded** | 10 | Turns a missed target into a diagnosed root cause. |
| 5 | **Threat → control table** (9 attacks, the exact control) | 11 | 30/30 + 27/27 + 10/10 stop being assertions. |

Everything else is either a duplicate of one of these (Venn, funnel, before/after) or too slow to read
(Gantt, radar, pyramid, hub-and-spoke). See the cut list in §5.

**The one thing to do first:** the three `demo-india-pii-*.png` screenshots form a *before → gate → model*
filmstrip that already exists, is real, and beats any diagram we could draw for slides 2/3/13. Lead with it.

---

## 1. Data inventory — what we can actually plot

Read this before any diagram. If a row is not here, we do not draw it.

| Signal | Value | Source |
|---|---|---|
| PII F1 (pixel) | **0.984** | `latest.json` → `overview.f1Px` |
| Precision / Recall | **0.968** / **1.000** | `latest.json` → `overview` |
| Per-category F1, 14 cats | name 1.0 · pan 1.0 · address 1.0 · card 1.0 · account 1.0 · ifsc 1.0 · face 1.0 · upi 1.0 · voterid 1.0 · dl 1.0 · passport 1.0 · email 0.999 · aadhaar 0.95 · password 0.90 · **phone 0.506 (P 0.339)** | `latest.json` → `categories` |
| Per-category element recall | **100% on all 14** | `latest.json` → `categories.*.recallElementPct` |
| Zero-leak | **PASS**, `hits: []` | `latest.json` → `zeroLeak` |
| Test pages | 7 | `latest.json` → `pages[]` |
| Latency p50 (routed) | capture 73 ms · serialize 0.7 · sanitize 86 · vision 34 (cached 0) · **VLM 14 211** · execute 1.1 | `dashboard.json` → `vlm_routed_ms` |
| Latency p50 (offline bench) | capture 120 · serialize 2.2 · perception 2 716 · sanitize 217 · imageGate 731 | `latest.json` → `latencyWaterfallMsPct` |
| e2e per step | 7B **21 150 ms** → routed **12 954 ms** | `dashboard.json` → `scorecard` |
| VLM task accuracy | 3B 2/3 · 7B 3/3 · **routed 2/3** | `dashboard.json` → `visual_context_accuracy` |
| Adversarial suite | **30 / 30 blocked**, 9 page classes | `adversarial-bench.mjs`, `PROGRESS-BRIEF §3.2` |
| Executor guards | **27 / 27** | `executor-guard.test.mjs` |
| Live hostile `/act` | **10 / 10** | `act-spot-check.mjs` |
| Perception | 7 pages, WebGPU backend, MobileViT 6.3 MB, **5 regions escalated to Tier C** | `latest.json` → `vision.perception` |
| Tier escalation reasons | `uncertain` ViT tile → "redacted conservatively" | `latest.json` → `decisions.escalate` |
| GT tokens, verbatim | `[NAME_1] [EMAIL_1] [PHONE_1] [PAN_1] [AADHAAR_1] [CARD_1] [ACCOUNT_1] [IFSC_1] [UPI_1] [VOTERID_1] [DL_1] [PASSPORT_1] [ADDRESS_1]` | `latest.json` → `pages[].preds[].token` |
| Adversarial page classes | `pii-in-images` `pii-in-canvas` `pii-in-svg` `tiny-text` `obfuscated` `prompt-injection` `visual-prompt-injection` `malicious-dom` `partial-pii` | `adversarial-bench.mjs` |
| Guard refusals, verbatim | `blocked scheme "<x>" (http/https only)` · `malformed URL` · `form action blocked: "<x>" scheme` · file-input refusal | `action-guards.ts:19,23,41,45,52` |

### The three real screenshots (already exist, do not regenerate)

| Asset | Path |
|---|---|
| Your screen — live UPI / voter ID / DL / passport | `docs/readme/demo-india-pii-user-view.png` |
| Gate's view — redaction boxes + tokens per field | `docs/readme/demo-india-pii-gate-view.png` |
| **The exact bytes the VLM receives** | `docs/readme/demo-india-pii-model-view.png` |
| Architecture vector master | `docs/Report/architecture.svg` (+ `architecture.tex`) |

---

## 2. The 18 concepts, evaluated

Format per concept: **type → argument → slide → literal contents → difficulty → alternatives → data note.**

Difficulty assumes `python-pptx` native shapes. `SVG` = author in LaTeX/TikZ or Mermaid, export, embed.

---

### ① Three-panel paradigm ladder — **BUILD THIS (hero)**

1. **Type:** 3-panel comparative strip (a / b / c), horizontal, with a red dashed trust boundary in each panel.
2. **Argument:** Privacy and cloud reasoning are *independent* problems. Every existing agent solves at most one.
   PRIVYSE is the only cell in the 2×2 that is both private **and** uses a real frontier-class VLM.
3. **Slide:** 2 (right half) and 3. This is the deck's central argument — give it slide 3 full width.
4. **Literal contents:**

   | | **(a) Cloud agent** | **(b) Local-only agent** | **(c) PRIVYSE** |
   |---|---|---|---|
   | caption | raw screenshot → cloud VLM | small model on device | **local sanitize + cloud VLM** |
   | device box | `Device` — capture, DOM | `Device` — capture · MobileViT · OCR · sanitize · Qwen 3B · execute | `Device` — capture · MobileViT · OCR · sanitize · **GATE** |
   | crossing arrow | `raw JPEG + full DOM` **in red, 2 px, arrow crosses boundary** | nothing crosses | `redacted JPEG + numbered DOM` in green, crosses once |
   | model box | `Cloud VLM (black box)` | `Qwen2.5-VL 3B on-device` | `Qwen2.5-VL 3B / 7B` |
   | footer verdict | `raw PII leaves device` | `private, but weak model + no verified gate` | `private AND capable — gate proves it` |
   | accent | red `#EF4444` | grey `#A0AEC0` | green `#00E676` |

5. **Difficulty:** **easy** — 3 panels × 4 rounded rects + 1 arrow each. `add_rect` / `add_text` already exist in `create_presentation.py`.
6. **Alternatives:** (a) a genuine **2×2 positioning map** — x = `reasoning power`, y = `privacy guarantee`, plot Operator / Claude for Chrome / Browser Use / MINIM / GUIGuard / **PRIVYSE** in the empty top-right. *(This is the better alternative — see §4, concept ⑲.)* (b) a two-panel **before/after** with only (a) vs (c). (c) a **Venn** of Privacy ∩ Local AI ∩ Cloud Reasoning.
7. **Data note:** every cell is a code fact — device-side modules from `wxt.config.ts` / `public/models/manifest.json`, model choice from `dashboard.json` → `model_set`. Competitor placement in the 2×2 needs external citations (see §8).

> **Why this beats the Venn.** The requested *Venn* (Privacy ∩ Local AI ∩ Cloud Reasoning) states the goal but
> proves nothing — any team could draw it. The 3-panel ladder shows *two real alternatives we rejected and why*,
> which is an argument, not a decoration.

---

### ② Swimlane pipeline with a hard trust boundary — **BUILD THIS**

1. **Type:** horizontal swimlane flowchart, 2 lanes, 8 stages, with the trust boundary as a vertical dashed rule.
2. **Argument:** The AI does not get the browser. A sanitizer and a fail-closed gate sit between the screen and
   the model, and **exactly one arrow** crosses the boundary.
3. **Slide:** 4 (`How It Works — End-to-End Flow`). Replaces the current 5-box version.
4. **Literal contents:**

   **Lane A — ON-DEVICE (inside a green-tinted container labelled `your device`):**
   `01 CAPTURE` → `02 PERCEIVE` → `03 SANITIZE` → `⟦04 GATE⟧`

   **Lane B — SERVER (`127.0.0.1:8000` / Ollama):**
   `05 REASON` → `06 VALIDATE` → `07 EXECUTE` (execute actually runs in lane A — draw the return arrow)

   **Stage sub-labels, verbatim:**
   - 01 `captureVisibleTab` + shadow-DOM walker · ≤120 elements · id·label·role·value
   - 02 MobileViT-Small 6.3 MB · BlazeFace 230 KB · Tesseract.js — **in parallel** · WebGPU → WASM
   - 03 Tier A black box · Tier B stable token · Tier C blur · SoM `[N]` tags
   - 04 DOM regex **+** OCR of the exact uploaded bytes · **fail-closed**
   - 05 3B interactive / 7B read-report — routed from the tile map
   - 06 `resolve_target` · **DO-NOT-MODIFY veto** · scheme guards
   - 07 pointer/keyboard via content script

   **Boundary rule:** a 2 px dashed vertical orange line labelled `privacy boundary — 1 arrow crosses`.
   The crossing arrow is labelled `redacted JPEG + numbered DOM (tokens only)`. A second label underneath:
   `0 MB raw data off-device · no CDN`.
   **Loop-back arc** from 07 to 01 labelled `↺ max 15 steps · 750 ms throttle · /rethink on repeat`.
   **GATE node styled differently from all others** — orange fill, and a small green `PASS` / red `BLOCKED` chip,
   because it is the only node that can refuse to let the loop continue.
5. **Difficulty:** **medium** — 8 boxes + 2 lane containers + 7 arrows + 1 loop arc. All `add_rect` +
   straight connectors; the loop arc is the only fiddly part (use a curved `MSO_SHAPE.ARC` or a `blockArc`).
   *Recommendation: author this one in TikZ/Graphviz and embed as `architecture.svg` — you already have a proven
   LaTeX toolchain and the line quality will be far better than python-pptx connectors.*
6. **Alternatives:** (a) **layered architecture** (see ⑤) as a companion on slide 8. (b) a **circular feedback
   loop** — see ⑫. (c) plain 6-box linear flow with the GATE node enlarged — cheapest option if time is short.
7. **Data note:** all module names are real files in `extension/core/`. The `≤120 elements` cap is in
   `dom-serializer.ts`. The 15-step / 750 ms limits are in `background.ts`. Nothing here is invented.

---

### ③ Per-category P/R dot plot — **BUILD THIS (most credible slide in the deck)**

1. **Type:** horizontal lollipop / dot plot, 14 rows, two dots per row (precision, recall), x-axis 0 → 1.
2. **Argument:** We don't just claim a headline F1. Here is every category we tested, we caught **100% of
   elements in all 14**, and here is exactly where we over-redact.
3. **Slide:** 6 (`Performance That Speaks`) — replaces generic metric cards as the *main* visual, or 7
   (`Automated, Reproducible, Scoring-Aligned`) if 6 keeps the cards.
4. **Literal contents:**

   - **y-axis, top to bottom (sorted by F1 ascending so the weak one is at the bottom and visible):**
     `phone · password · aadhaar · email · card · name · pan · address · account · ifsc · face · upi · voterid · dl · passport`
   - **x-axis ticks:** `0 · 0.25 · 0.5 · 0.75 · 1.0`, labelled `pixel precision / recall vs ground truth (IoU ≥ 0.5)`
   - **Two marks per row:** green dot = recall, cyan dot = precision, 8 px, on a 1 px grey track
   - **The weak bar, called out in orange with a leader line:** `phone — P 0.34 / R 1.00`
     and the caption: `over-redacts the +91 prefix; recall unaffected`
   - **A vertical green rule at 1.0** labelled `every category: 100% element recall`
   - **Header strip, verbatim:** `F1 0.984 · P 0.968 · R 1.000 · 14/14 categories · 7 GT pages`
   - **Legend:** `● recall   ● precision`
5. **Difficulty:** **medium** — 14 rows × (1 line + 2 circles + 1 label) ≈ 70 shapes. `add_circle` already exists.
   *Alternative: export a real chart to SVG/PNG and embed — much better typography, and matplotlib
   `hlines`+`scatter` produces this in ~15 lines. **Recommend SVG embed** if any plotting tool is available.*
6. **Alternatives:** (a) a **confusion-style 2×2 heatmap** of category × {P, R} with values printed in each cell —
   denser but instantly scannable, and the phone cell jumps out. (b) a **grouped bar chart** P vs R per category —
   familiar, but 28 bars is too many for 60 seconds. (c) plain **two-number hero cards** (current slide 6) —
   safe, but a judge can fake two numbers; they cannot fake 14 categories.
7. **Data note:** 100% present in `latest.json` → `categories`. **This is the strongest slide in the deck
   precisely because it includes our worst number.** `phone` precision 0.339 is a real, measured weakness —
   do not hide it and do not explain it away; the recall of 1.000 next to it is the whole argument.

---

### ④ Latency waterfall with the 97% band exploded — **BUILD THIS**

1. **Type:** stacked horizontal bar (one bar, log or broken scale) + an inset callout of the bottleneck.
2. **Argument:** We missed 5 s/step. Here is the breakdown, here is the one stage that costs 97% of it, and here
   is the diagnosed hardware reason. We didn't guess.
3. **Slide:** 10 (`Optimized for Modest Hardware`).
4. **Literal contents:**

   One horizontal bar, ~11 in wide, split into 6 segments with real p50 values as **inline labels**:

   | Segment | p50 | Render as | Colour |
   |---|---|---|---|
   | Capture | 73 ms | 0.6% of bar (too thin to label inside) | cyan `#00B4D8` |
   | Serialize | 0.7 ms | invisible | cyan |
   | Sanitize | 86 ms | invisible | cyan |
   | Vision (cached) | 0–34 ms | invisible | purple `#7C3AED` |
   | **VLM /act** | **14 211 ms** | **97% of the bar, one big orange block** | orange `#FF6B35` |
   | Execute | 1.1 ms | invisible | green `#00E676` |

   - **Label above the bar:** `12 954 ms/step end-to-end (routed) · 7B-only was 21 150 ms`
   - **Callout box attached to the orange block, verbatim:**
     `qwen2.5vl:7b = 6.2 GB on a 4 GB RTX 3050 → 75% CPU / 25% GPU`
     `image tokens floor at ~1024 → prefill+decode are CPU-bound`
     `a *minimal* prompt already costs ~10.5 s`
     `→ architectural on 4 GB hardware, not a code defect`
   - **Second callout (green), attached to the routing lever:** `perception-driven routing: 7B 21.2 s → 12.7 s (−40%)`
   - **Target marker:** a dashed vertical tick labelled `5 000 ms target` sitting inside the orange block,
     with the honest label `not met on this GPU`.
5. **Difficulty:** **medium-hard** — 6 rectangles with computed widths + 2 callout boxes. Widths must be
   computed from ms, and the 4 sub-100 ms stages are sub-pixel at true scale, so either (a) use a
   **broken/log axis** with a `⚠ scale` marker, or (b) simpler: **omit the thin segments entirely** and show
   `VLM 14 211 ms` as one bar against a `5 000 ms target` tick, with the other stages as a small
   `everything else: 161 ms` residual. **(b) is the right call — it is honest and readable in 60 seconds.**
6. **Alternatives:** (a) a **p50/p95 range plot** per stage using the min/max/p50/p95 already in
   `latencyWaterfallMsPct` — richer, but too slow to read. (b) **two bars side by side** (`7B only 21.2 s` vs
   `routed 12.7 s`) with the levers as the annotation — cleanest possible, and the routing win is the story.
   (c) a small **"what we cut" list** as a waterfall of improvements: 21.2 s → 19 s → 16 s → 12.7 s.
7. **Data note:** all p50 values in `dashboard.json` → `vlm_routed_ms`; the root-cause numbers are the
   `hardware_note` field, already written down. **We do not have a judge-GPU measurement** — never draw the
   `<5 s` target as if achieved. It is a dashed, unmet tick.

---

### ⑤ Threat → control table — **BUILD THIS**

1. **Type:** two-column mapping table with a coloured status chip per row. Not a diagram — a **ledger**.
2. **Argument:** Every privacy attack class has a named, implemented, tested control with a pass count.
   This is how "we're secure" becomes "here are 30 tests and they all pass".
3. **Slide:** 11 (`Defense in Depth — No Soft Fail`).
4. **Literal contents — 9 rows, verbatim from the repo:**

   | Attack | Control | Test |
   |---|---|---|
   | PII rendered in an **image** | Tesseract.js region-restricted OCR → Tier B tokens | `pii-in-images` |
   | PII rendered in **canvas** | OCR on canvas regions; canvas → Tier C | `pii-in-canvas` |
   | PII rendered in **SVG** | SVG region detection | `pii-in-svg` |
   | **Tiny** visual text | MobileViT `uncertain`/`document` tile → conservative Tier C | `tiny-text` |
   | **Obfuscated** values | label/attribute heuristics + token rules | `obfuscated` |
   | **Text** prompt injection | page content never becomes instruction; `DOM` treated as data | `prompt-injection` |
   | **Visual** prompt injection | image regions → Tier C, no text survives to the model | `visual-prompt-injection` |
   | Exfiltration via `data:` / `blob:` / `javascript:` **form action** | `validateFormAction` — non-HTTP refused | `malicious-dom` |
   | **Partial** PII in one field | same value ⇒ same token across DOM and OCR paths | `partial-pii` |

   **Then a footer strip of three counters, verbatim:**
   `adversarial 30/30 blocked · executor guards 27/27 · live hostile /act 10/10`
   **And the fail-closed box, styled as the punchline:**
   `gate cannot run → step BLOCKED. There is no fail-open path.`

5. **Difficulty:** **easy** — 9 rows × 3 text cells. The current slide 11 already builds cards; this is the same
   code with a real table instead of vague layer names.
6. **Alternatives:** (a) **STRIDE-style** attack→control table (KubeCon's format) — more rigorous, but STRIDE
   is the wrong vocabulary for PII leakage; stay concrete. (b) **shield layers** (see ⑮) as a visual frame with
   this table dropped underneath. (c) an **attack tree** with the bad outcome at the root — elegant, but needs a
   paragraph to explain. Cut.
7. **Data note:** the 9 page labels are literal in `adversarial-bench.mjs`. The guard strings are literal in
   `action-guards.ts`. The 30/27/10 counts are from `PROGRESS-BRIEF §3.2`. **Optional high-value addition:**
   D2 and D1 from our own HITL audit, shown as **open, red** rows with the owner and status. See §6.

---

### ⑥ Venn — Privacy ∩ Local AI ∩ Cloud Reasoning — **CUT as a Venn, KEEP as ①**

1. **Type:** 3-circle Venn.
2. **Argument:** The intersection of the three is the design goal. True but self-evident.
3. **Slide:** 3 — but only as a *secondary* 20% strip under the 3-panel ladder.
4. **Literal contents:** circles `Privacy` (green), `Local AI` (cyan), `Cloud Reasoning` (purple);
   centre label `PRIVYSE`; **label the empty outer crescents** — that's where the existing agents live:
   `Local AI only` (no cloud power) and `Cloud only` (no privacy).
5. **Difficulty:** **easy** — 3 ovals, but **overlap math in python-pptx is painful**; native shapes will not
   produce clean translucent intersections. Use `Diagram Tools` or export SVG.
6. **Alternatives:** **the 3-panel ladder (①) is strictly better** — it names the two rejected designs instead of
   asserting an intersection. If you want a Venn, at least label the crescents so it argues something.
7. **Data note:** no numbers. Cut if slide 3 is tight.

---

### ⑦ Gantt / timeline — **CUT the build Gantt, KEEP a 1-line build strip**

1. **Type:** horizontal Gantt.
2. **Argument:** *Weak.* "We worked for 23 days" is not a judge-scored criterion and reads as filler.
3. **Slide:** none. If SIH's mandated structure forces a roadmap, use the bottom 0.5 in of slide 12.
4. **Literal contents (only if forced):** 5 bars, Sep dates 4→26, exit criteria as labels —
   `P0 scaffold` ✅ · `P1 e2e spine` ✅ · `P2 on-device vision` ✅ · `P3 GT site + metrics` ✅ · `P4 hardening` 🟡
   with a hatched tail labelled `Firefox runtime test + demo video outstanding`.
5. **Difficulty:** **easy** — 5 rects + a date axis.
6. **Alternatives:** (a) a **phase status strip** (5 pills, ✅✅✅✅🟡) — 10 seconds to read, same honesty. **(b) A
   *runtime* timeline instead:** `capture → … → act` with per-stage ms written under each node. This is far more
   relevant to a research track than a build history, and it dovetails with ④. **Prefer (b).**
7. **Data note:** dates from `SIH26171_build_plan.md`; phase exit criteria from `PROGRESS-BRIEF §6`.

---

### ⑧ Priority triangle / pyramid — **CUT**

1. **Type:** 4-level pyramid, `Privacy → Accuracy → Latency → Resources`.
2. **Argument:** *Weak as a pyramid.* A pyramid implies a strict hierarchy of importance, but the rubric
   **weights** the five criteria 25/20/20/20/15 — they are not nested, and privacy is not above the others.
3. **Slide:** none.
4. **N/A**
5. **Difficulty:** easy, but wrong.
6. **Alternatives:** (a) a **weighted rubric bar** on slide 7 — five horizontal bars proportional to 25/20/20/20/15
   with our measured score on each. This is *honest to the rubric* and lands directly on how judges score.
   (b) a **trade-off scatter** — see ⑩. **Use (a).**
7. **Data note:** weights from the problem statement. Scores: visual-context 2/3 routed, PII F1 0.984,
   redaction precision 0.968, resources 8.15 MB weights / 0 MB off-device, latency 12 954 ms vs 5 000 target.
   **Plots our own miss.** That is the point.

---

### ⑨ Layered architecture — **KEEP as the secondary visual on slide 8**

1. **Type:** 4-band layered stack.
2. **Argument:** Which layer owns what, and that the privacy layer is *inside* the client, not a proxy.
3. **Slide:** 8 (`Built for Privacy & Performance`).
4. **Literal contents, top to bottom:**

   | Band | Contents, verbatim |
   |---|---|
   | **UI surfaces** | side-panel cockpit · Privacy Lens · AI View · floating orb · forensic filmstrip · virtual cursor · Spotlight `Alt+K` |
   | **Agent core** | background loop (15 steps, 750 ms) · `/rethink` + repeat-veto · `sihLessons` (cap 8) · `ask` HITL · Proceed/Cancel gate |
   | **Privacy core** | `sanitizer.ts` (Tier A/B/C) · `pii-rules.ts` · `zero-leak.ts` **fail-closed** · `action-guards.ts` · `executor.ts` |
   | **On-device vision** | MobileViT-Small 6.3 MB · BlazeFace 230 KB · Tesseract.js · WebGPU → WASM fallback |
   | **Server** *(separate box, not a band — it is a different trust zone)* | FastAPI `/health /act /act/stream /rethink /warm /models` · Ollama Qwen2.5-VL 3B/7B · any OpenAI-compatible VLM |

   Colour rule: the first four bands sit inside one green-tinted container labelled `your device`;
   the server box sits outside it. **The container edge is the privacy boundary** — same visual device as ②.
5. **Difficulty:** **medium** — 4 bands + 1 detached box + 1 container. Fine in python-pptx.
6. **Alternatives:** (a) a **stack of concentric rounded rects** ("shield" metaphor). (b) a **file-tree literal**
   of `extension/core/` — accurate but not a visual. (c) omit entirely and use the space for the model table.
7. **Data note:** all module names are real files. Model sizes from `PROGRESS-BRIEF §3.3` — **but see the
   asset-size conflict in §7.1 before printing an MB figure.**

---

### ⑩ Before vs After — **CUT (subsumed by ①)**

Same information as the 3-panel ladder, with one fewer column. Use ①.
Only exception: if you want a *screenshot* before/after rather than a schematic, that's the
`demo-india-pii-user-view.png` → `demo-india-pii-model-view.png` pair — and that is ⑰, not this.

---

### ⑪ Data-flow diagram (on-device vs server) — **CUT (subsumed by ②)**

A DFD adds process/flow notation on top of the swimlane. The swimlane already *is* the data flow, and
adding DFD notation costs 60 seconds of reading. The one thing worth borrowing from DFD practice: **draw the
trust boundary as a first-class object**, which ② does.

---

### ⑫ Threat → Protection mapping — **THIS IS ⑤. Build it once.** See ⑤.

---

### ⑬ Decision tree (transmit or redact?) — **KEEP, as the tier decision inside ⑤'s slide family**

1. **Type:** binary decision tree, 3 levels, 4 leaves.
2. **Argument:** The redaction policy is deterministic, not a model guess. One path per information class.
3. **Slide:** 5 (`Three-Tier On-Device Redaction`) — this is a **better fit for slide 5 than a tier pyramid**,
   because a tree shows *how a field is classified*, which is the actual mechanism.
4. **Literal contents:**

   ```
   FIELD / REGION
        │
        ├─ Q1  password · otp · cvv · api_key · secret?  ──YES──► TIER A  ████ solid black
        │                                                  NO     no text, no token
        │
        ├─ Q2  face · canvas · video · non-DOM graphic
        │       or MobileViT tile = uncertain?           ──YES──► TIER C  ▓▓▓ irreversible blur
        │                                                  NO          (region taint)
        │
        ├─ Q3  name · email · phone · address · PAN ·
        │       Aadhaar · UPI · voter ID · DL · passport ·
        │       card · DOB · IFSC · account?            ──YES──► TIER B  [EMAIL_1] stable token
        │                                                  NO
        │
        └─ Q4  anything else?  ──────────────────────► PASS THROUGH + numbered [N] SoM tag
   ```
   - **Footer strip:** `same value ⇒ same token, across DOM and OCR, for the whole run`
   - **Second footer strip:** `Q2 answer comes from the on-device ViT, not from a heuristic`
5. **Difficulty:** **medium** — 1 root, 2 mid-level, 4 leaves, ~8 connectors. Doable in python-pptx; Mermaid
   `flowchart TD` → SVG is faster and cleaner.
6. **Alternatives:** (a) the current **three horizontal tier bands** — fine, but a list, not a mechanism.
   (b) a **lens/iris metaphor** — 3 concentric rings, Tier C outermost. Elegant, less informative. (c) a
   **live screenshot with callout arrows** — `demo-india-pii-gate-view.png` with 4 numbered arrows pointing at
   a black box, a token, a blur and an `[N]` tag. **Strongest alternative** — it uses a real artifact and needs
   zero drawing.
7. **Data note:** Tier A field list is literal in `pii-rules.ts:62-63`. Tier B fields in `TIER_B_FIELDS`
   (`pii-rules.ts:64+`). Tier C escalation is in `latest.json` → `decisions.escalate` with the verbatim reason
   `on-device ViT: low-confidence graphic → redacted conservatively`.

---

### ⑭ 2×2 matrix — **KEEP TWO, they are the deck's best competitive slides**

**(a) Rubric-weight × our-score bar set** → slide 7. See ⑧ alternative (a).

**(b) Competitive positioning 2×2** → slide 9. **This is the one that wins the "what's different" question.**

1. **Type:** scatter 2×2 with labelled quadrant axes.
2. **Argument:** Everyone else is either private-and-weak or capable-and-leaky. We are top-right.
3. **Slide:** 9 (`What No Other Agent Does`) — replaces the current comparison table as the hero.
4. **Literal contents:**

   - **x-axis:** `reasoning power  →`  tick labels `on-device small model` … `cloud frontier VLM`
   - **y-axis:** `privacy guarantee  →`  tick labels `raw pixels leave` … `nothing sensitive leaves`
   - **Quadrant labels, faint grey:**
     - top-left `private but weak`
     - top-right **`PRIVYSE`**
     - bottom-left `neither`
     - bottom-right `capable but leaks`
   - **Plotted systems (cite each in small grey text):**
     - `Operator / CUA`, `Claude for Chrome`, `ChatGPT Agent`, `Browser Use (cloud)`, `Director` →
       **bottom-right**, at varying x
     - `local Qwen agent`, `on-device Moondream (rejected — 0/36 actions)` → **top-left**
     - `GUIGuard`, `MINIM` → **top-left / top-middle**, labelled `research, not shipped`
     - **`PRIVYSE`** → top-right, large cyan dot with a white ring, label `+ measured gate`
   - **Bottom strip:** `the only browser agent that is both private and capable — and the only one that proves it`
5. **Difficulty:** **medium** — 2 axes, 4 quadrant tints, ~9 dots + labels. Comfortable in python-pptx.
   *Don't use a native PowerPoint scatter chart — data-label positioning is worse than placing circles manually.*
6. **Alternatives:** (a) a **feature-matrix table** (the current slide 9) — precise, boring, and 8 rows is too
   many for 60 seconds. Keep the table, cut to 4 rows. (b) a **"leak surface" bar** — for each system, how many
   bytes of raw PII reach a third party per step. Hard to source honestly; skip.
7. **Data note:** **PRIVYSE's own position is measured. Every other dot is a literature claim and must carry a
   citation** (see §8). `Privacy Practices of Browser Agents` (8 agents, 30 vulnerabilities) is the strongest
   single source. If you cannot cite a dot within 30 seconds, remove the dot. Also note a
   **PrivacyLens** repo exists publicly for the same SIH problem statement — expect a sibling team; position on
   mechanism, not on the problem statement.

---

### ⑮ Funnel — **CUT (it would be dishonest)**

1. **Type:** descending funnel, `raw screen → detected → sanitized → actionable`.
2. **Argument:** *Tempting, and it is the wrong shape.* A funnel implies monotonically **decreasing** volume and
   implies information is *discarded*. Our whole claim is the opposite: recall is **1.000** and we keep full
   structure via stable tokens. A narrowing funnel visually argues that we threw information away.
3. **Slide:** none.
4. **N/A**
5. **Difficulty:** easy, but semantically backwards.
6. **Alternatives:** (a) the **before → gate → model filmstrip** (⑰) — same narrative, correct shape, real images.
   (b) a **constant-width band** showing volume preserved: `1 200 DOM elements in → ≤120 serialised →
   100% of GT PII caught → 0 raw values out`. That is a funnel-shaped story told with a *rectangle*.
   **Use (b) if you need the idea.**
7. **Data note:** `domElements` per page is in `latest.json` → `pages[].domElements` (5–10 per test page; cap is 120).
   **Careful:** the test-site pages are small, so "120 elements" and "10 elements" are not comparable. Show the
   cap as a *design constraint*, not as a funnel measurement.

---

### ⑯ Feedback loop — **KEEP, but merged into ②**

The `CAPTURE → … → ACT → ↺ CAPTURE` arc is already in ②. What ② does not show is the **recovery** path, which
is genuinely novel and worth 20 seconds on slide 4 or 11:

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
   CAPTURE ──▶ … ──▶ ACT ──┬─▶ done? ──YES──▶ Proceed/Cancel confirm ──▶ END
                            │
                            NO
                            ▼
                     fingerprint step
                            │
              ┌─────────────┴─────────────┐
        same as last 4 steps?          new element?
              YES                          NO
              ▼                            ▼
        /rethink  (structural          act on the
        repeat-veto + escape           untried element
        hatch)                             │
              └──────────────┬──────────────┘
                             ▼
                    per-host sihLessons
                    (verified only, cap 8)
```

- **Difficulty:** medium-hard. **Merge into ②** rather than giving it its own slide.
- **Alternatives:** a plain circular arrow labelled `↺ observe → reason → act` — the industry-standard
  perceive-reason-act loop (OpenAI CUA, UI-TARS both use it). Cheap, instantly readable, less differentiated.
  **Use the plain loop on slide 4 and keep the recovery tree for slide 11 or speaker notes.**
- **Data note:** 15 steps max, 750 ms throttle, rethink fires on the **5th** identical step, `sihLessons` cap 8 —
  all in `background.ts`. 4-repeat threshold is documented in `hitl-test-matrix.md` (HITL-16).

---

### ⑰ Comparison diagram (traditional vs privacy-preserving) — **CUT (use the filmstrip + ⑭b)**

Covered by ① (schematic) and ⑰-filmstrip (empirical). Do not build a third one.

---

### ⑱ Layered privacy shield (DOM → OCR → Vision → Redaction → Gate) — **KEEP, merged into ⑤**

The shield is a good *frame* for slide 11 but the *table* is the substance. Recommendation: build ⑤'s table,
and use a 5-segment horizontal shield bar as its header — `DOM rules` → `OCR` → `ViT vision` → `redaction` →
`⟦GATE⟧` — with the GATE segment visually breaking the bar (because it's the only one that can stop the flow).
**Difficulty:** easy. **Alternatives:** concentric rings (least informative); nested shields (pretty, slow).

---

### ⑲ Latency breakdown — **THIS IS ④. Build it once.** See ④.

---

### ⑳ Risk pyramid (low → medium → high-risk actions) — **KEEP. Nobody has proposed this yet and it maps to real code.**

1. **Type:** 3-step ascending staircase, not a pyramid.
2. **Argument:** The agent's authority is graduated by risk, and the graduation is enforced in code, not by
   asking the model nicely. This maps to our HITL design and to what every other agent gets wrong.
3. **Slide:** 11 (right column) or a half of slide 5. **Recommend slide 11 — it strengthens the safety story
   that slide 11 currently under-serves.**
4. **Literal contents:**

   | Step | Actions | Who authorises |
   |---|---|---|
   | **LOW** — automatic | `scroll` · `wait` · `extract` · `click` on non-payment, non-identity elements | agent, no prompt |
   | **MEDIUM** — guarded | `type` into non-protected fields · `navigate` same-origin · form `submit` over http(s) | agent, **guards must pass** (`validateNavigationUrl`, `validateFormAction`) |
   | **HIGH** — human decides | `type` into a **protected** field · any write replacing a redacted value · `navigate` **cross-origin** · task-complete `done` on a payment flow | **`ask` card + page banner, or Proceed/Cancel gate — blocks the loop** |
   | **FORBIDDEN — no override** | `javascript:` `file:` `data:` `blob:` `about:` · non-HTTP form action · `<input type=file>` · `DO-NOT-MODIFY` violation | **refused, deterministic** |

   - **Key caption under the top step:** `ask` is never dispatched to the page — it surfaces in the side panel
     *and* a shadow-DOM page banner, and blocks until answered.`
   - **And the honest footnote:** `confirm gate detects Cancel by allow-list; D1 open — see self-audit row`
5. **Difficulty:** **easy-medium** — 4 rects at increasing heights on a left axis, or 4 steps rising left→right.
6. **Alternatives:** (a) a **traffic-light ladder** (green/amber/red/grey) mapped to the same 4 bands — faster
   to read than geometry. (b) a **single column of "who can authorise what"** with user-silhouette icons —
   clearest of all, and the visual argument ("the human is still in the loop for the dangerous 10%") is the point.
   (c) a **matrix** of action-type × authorisation, 8×4 — precise, too dense.
7. **Data note:** LOW/MEDIUM/FORBIDDEN rows are literal in `action-guards.ts` and `executor.ts`. The
   cross-origin-`navigate` and task-complete-`done` confirm gates are documented in `PROGRESS-BRIEF §2.6`.
   D1 is real and open — see §6. **Do not draw the HIGH step as airtight while D1 is open.**

---

### ㉑ Hub-and-spoke — **CUT**

Radiates components around the privacy boundary. The 2② swimlane already places every component in a lane
and shows flow. A hub has no flow, so it can't answer "what happens to my data" — the only question that matters
on this deck. **Alternative worth stealing from it:** the hub's *one* good property is a clear centre, so if you
want a single at-a-glance component map, put the `GATE` in the centre and the 6 modules around it, with the
**only** arrows radiating *into* the gate. That's not a hub, it's a **gate-and-suppliers** diagram, and it's
genuinely different from ②. Medium value. Optional.

---

## 3. Concepts we did not get asked about, that beat some we did

### ⑲′. Paradigm-gap 3-panel (same as ①, listed as the honest "evolution" frame)
GUIGuard Figure 2 does exactly this: (a) local deployment is expensive → weak; (b) Trustworthy Remote Service
is advocacy-stage, no enforcement; (c) Trustworthy Local–Remote Hybrid. Steal this. It is the strongest
problem→solution arc available and it has a citation.

### ⑳′. **Precision/recall scatter against a Pareto frontier** *(replaces the radar chart)*
- **Argument:** we sit at a point on the privacy–utility trade-off curve; over-redaction is the cost, and we
  publish our own position on it.
- **Slide:** 6 or 7.
- **Contents:** x = `pixel precision (over-redaction)`, y = `task success (visual context)`. Plot
  `PRIVYSE (0.968, 2/3)`, `7B no redaction (1.00, 3/3)` in grey labelled `ideal but leaks`, and a shaded
  `feasible region` under the curve. **This is how you show a judge that you understand your own trade-off** —
  the single most senior-sounding visual available, and it uses numbers we already have.
- **Difficulty:** easy. **Data note:** both axes are measured. The "no redaction" point is a genuine measured
  datapoint (7B accuracy with no redaction), so this is not a hypothetical.

### ㉑′. **Self-audit / known-defects visual** — see §6. High value, explicitly optional in the brief.

---

## 4. Cut list

| # | Concept | Verdict | If cut, what covers it |
|---|---|---|---|
| ⑮ | Funnel | **CUT** | Visually argues we discard information — contradicts recall 1.000 |
| ⑧ | Priority pyramid | **CUT** | Rubric weights are not a hierarchy; use the weighted bar (slide 7) |
| ⑦ | Gantt | **CUT** | Build history isn't scored; use 5 phase pills if forced |
| ⑩ | Before/After | **CUT** | Subsumed by ① |
| ⑪ | Data-flow diagram | **CUT** | Subsumed by ② |
| ⑫ | Threat→Protection | *merge* | Same as ⑤ |
| ⑰ | Comparison diagram | **CUT** | Subsumed by ① + ⑭b + filmstrip |
| ⑲ | Latency breakdown | *merge* | Same as ④ |
| ㉑ | Hub-and-spoke | **CUT** | No flow direction; ② is better |
| ⑥ | Venn | **demote** | Secondary strip on slide 3 only, or drop |
| ⑯ | Feedback loop | **demote** | Plain ↺ arrow on slide 4; recovery tree → slide 11 |
| ⑱ | Layered shield | **demote** | Merge as a header bar onto ⑤ |
| ① ② ③ ④ ⑤ ⑬ ⑭ ⑳ | — | **BUILD** | |

**Net: 8 visuals to build, 3 to demote, 9 to cut.** A 14-slide deck with 8–11 distinct real visuals is already
at the upper limit of what reads in 60 s/slide. Do not add a ninth.

---

## 5. Slide-by-slide visual plan

The single most useful table in this document. Slide numbering per `create_presentation.py` / `PROGRESS-BRIEF §5.1`.

| Slide | Title | Recommended visual | Difficulty | One-line spec |
|---|---|---|---|---|
| 1 | Title | **Hero strip**: `user-view → gate-view → model-view` thumbnails, 3-up, at 25% opacity behind the title | easy | Three real screenshots in a row prove the thesis before a word is spoken |
| 2 | Browser Agents Leak Everything | **① 3-panel ladder, panels (a) and (b) only**, plus the `demo-india-pii-user-view.png` screenshot as the "this is what leaves" inset | easy | Two rejected designs + one raw screenshot of a real Indian KYC page |
| 3 | Sanitize Before You Send | **① 3-panel ladder, full**, panel (c) highlighted; Venn demoted to a 20% footer strip | easy | The deck's thesis slide: naive / local-only / **PRIVYSE** |
| 4 | How It Works — End-to-End Flow | **② Swimlane + trust boundary** (TikZ→SVG preferred) + plain `↺` loop arc | medium | 8 stages, 2 lanes, exactly 1 arrow crossing a dashed boundary |
| 5 | Three-Tier On-Device Redaction | **⑬ Decision tree** (native shapes or Mermaid→SVG) | medium | 4 questions → Tier A black box / Tier B token / Tier C blur / pass-through |
| 6 | Performance That Speaks | **③ Per-category P/R dot plot**, 14 rows | medium | Recall 100% on all 14; the one weak bar (`phone`) labelled, not hidden |
| 7 | Automated, Reproducible, Scoring-Aligned | **Weighted rubric bars** (25/20/20/20/15) + our measured score on each + the 5 harness scripts as chips | easy | Shows the judges their own rubric, with our honest miss on latency |
| 8 | Built for Privacy & Performance | **⑨ 4-band layer stack** inside a green `your device` container, server box outside | medium | Privacy core is a *band*, not a proxy — that's the architectural claim |
| 9 | What No Other Agent Does | **⑭(b) 2×2 positioning map** + 4-row feature table underneath | medium | x = reasoning power, y = privacy; PRIVYSE alone in the top-right |
| 10 | Optimized for Modest Hardware | **④ Latency: VLM 14 211 ms vs 5 000 ms target tick**, plus `21.2 s → 12.7 s` routing win | easy–medium | One honest bar, one diagnosed root cause, one shipped lever |
| 11 | Defense in Depth — No Soft Fail | **⑤ 9-row threat→control table** + ⑳ risk ladder on the right + shield header bar | easy | 30/30 · 27/27 · 10/10, then the fail-closed punchline |
| 12 | Why This Matters | **Stakeholder ring** (citizen · bank · govt · employer · developer) around a centre `raw PII never leaves` | easy | Keep it light — impact is the lowest-weighted slide; do not over-invest |
| 13 | Live Walkthrough — 3 Minutes | **Filmstrip: 3 full-width screenshots** + a 4-step numbered timeline (30s/60s/30s/30s) | easy | This is the highest-value slide in the deck — don't crowd it |
| 14 | Questions? | **One line + the 3 hero numbers** as a footer strip | easy | `F1 0.984 · 30/30 adversarial · 0 MB off-device` |

**Optional insertion (if the deck has room):** a **slide 11.5 "What We Audited In Ourselves"** — see §6.

---

## 5b. Remapping to SIH's mandated section structure

If the final deck must follow SIH's template instead of the 14-slide structure, this is the mapping.

| SIH mandated section | Absorbs | Lead visual | Difficulty | Spec |
|---|---|---|---|---|
| `TITLE` | 1 | hero screenshot strip | easy | 3 thumbnails, 25% opacity |
| `TECHNICAL APPROACH` | 3, 4, 5, 8 | ② swimlane + ⑬ decision tree | medium | The two load-bearing technical diagrams; both are needed here, so **they must survive any cut** |
| `FEASIBILITY AND VIABILITY` | 6, 7, 10 | ③ dot plot + ④ latency | medium | Metrics and hardware realism |
| `IMPACT AND BENEFITS` | 9, 12 | ⑭(b) 2×2 + stakeholder ring | medium | 2×2 is the differentiator; the ring is decoration |
| `RESEARCH AND REFERENCE` | 11 + citations | ⑤ threat table | easy | Plus a real citation list: GUIGuard, MINIM, SoM, BrowserGym, Privacy Practices of Browser Agents |

### Diagrams that only work in one structure

| Visual | Favours | Why |
|---|---|---|
| ② swimlane | **14-slide structure** | Needs its own slide; in the SIH structure it competes with 3 other `TECHNICAL APPROACH` slides |
| ③ dot plot | **Both** | Reads as a single exhibit under either structure |
| ④ latency | **Both** | SIH folds it into `VIABILITY` — slightly less room to explain the root cause; consider dropping the callout text to speaker notes |
| ⑭(b) 2×2 | **14-slide structure** | Under SIH it belongs to `IMPACT`, which is the shortest section — fits, but competes with the stakeholder ring. **Cut the ring.** |
| ⑤ threat table | **SIH structure** | Strongly rewards an explicit `RESEARCH AND REFERENCE` section; in the 14-slide structure it has to share slide 11 with ⑳ |
| ⑳ risk ladder | **14-slide structure** | No natural SIH home; fold into `TECHNICAL APPROACH` as a sidebar on the decision-tree slide if forced |

---

## 6. Optional high-value addition: the self-audit visual

The brief says this is optional and must not be built at the cost of a core diagram. Agreed — **but it is the
highest-return 30 seconds in the entire deck**, because it is the one thing a competent competitor cannot
imitate.

**Recommended form:** a 4-row "claim → test → verdict" strip, or a **before/after of our own numbers**:

| We claimed | Reality | Action |
|---|---|---|
| F1 0.979 | **0.984** | corrected in the architecture SVG |
| assets 21.4 MB / 2.2 MB | **56.9 MB total / 8.15 MB weights** | older cheat-sheet retired |
| routed accuracy 3/3 | **2/3** | README corrected |
| HITL safety net 120 s | **25 s** (`ASK_TIMEOUT_MS`) | cheat-sheet corrected |

…followed by a second block, in a different colour, for the **open** items:

| Open defect | Severity | Status |
|---|---|---|
| **D2** — `history[].result` + `task` reach the outbound body untokenized; `zero-leak.ts` only walks `body.dom[].text/value` → PII typed into a HITL answer leaves in plaintext, gate blind to it | **High** | **open** — do not draw the privacy boundary as airtight until closed |
| **D1** — risky-action confirm detects Cancel via blocklist, so `no` executes the action including `done` on a payment flow | **High** | **open** — needs an allow-list |
| Firefox never run in a real browser | Medium | built + type-checked only |
| Zero-leak OCR nondeterministic ~1 in 4 runs | Low | always a *fail-closed block*, never a leak |
| Docker path unverified | Low | Docker unavailable on dev box |
| Unexplained target-validation mismatch (model says id 6, server says absent) | Medium | **not root-caused** |
| No CI for the 25-case HITL matrix | Low | plan specified, unbuilt |

**Difficulty:** easy. **Constraint:** this must be *after* the results slide, never before — a self-audit that
precedes your own numbers reads as an apology.

**Hard rule from our own audit:** *"Do not diagram the privacy boundary as airtight until D2 is closed."* That
applies to ② and ⑱ too. If D2 ships before the deck is built, the boundary can be drawn solid. If not, draw the
boundary with a **dashed** segment and a footnote.

---

## 7. Data gaps and honesty ledger

### 7.1 ⚠ Three different on-device asset totals — resolve before printing any MB figure

| Source | Figure |
|---|---|
| `dashboard.json` → `client_resources.total_assets_mb` | **40.76 MB** |
| `latest.json` → `vision.modelsMB` | **53.98 MB** |
| `PROGRESS-BRIEF §3.3` | **56.9 MB** |

These are from three different runs with different file sets (the 40.76 figure predates the `.jsep` runtime
swap — `git status` shows `ort-wasm-simd-threaded.{mjs,wasm}` deleted and `ort-wasm-simd-threaded.jsep.{mjs,wasm}`
untracked). **Action: re-measure once, hard-code that number, and cite it in speaker notes.** The `8.15 MB`
weights figure is consistent everywhere. Until re-measured, put **only** `8.15 MB weights · 0 MB off-device` on
slides — both are unambiguous and both are the ones the rubric cares about (20% client resources).

### 7.2 ⚠ Two other number conflicts

- `PROGRESS-BRIEF §3.3` says vision p50 = 34 ms; `latest.json` says perception p50 = **2 716 ms**
  (mean 3 522 ms). The 34 ms figure is the **cached** path. **Label the bars `cold` vs `cached` or the judge
  will find the discrepancy.** Cached = 0 ms, first ≈1.4 s per `PROGRESS-BRIEF`; `latest.json`'s 2.7 s is
  cold-in-bench. Pick one frame and say which.
- `redaction_precision` in `dashboard.json` is **identical** to `pii_detection_f1` (0.968 / 1.0 / 0.984). They
  are separate rubric criteria (20% each) and separate metrics in the problem statement. **Flag this** — a judge
  who reads the JSON will notice two criteria share a number. Worth a one-line explanation on slide 7:
  our zero-leak gate and redaction mask are the same operation, verified twice.

### 7.3 Gaps — do not draw these, we have not measured them

- **No judge-GPU latency number.** The `<5 s/step` target is unverified. Draw it as an unmet dashed tick.
- **No Firefox runtime measurement.** Say "built and type-checked".
- **No per-category latency.** ④ cannot show which PII type costs the most.
- **No energy / battery measurement.** If a judge asks about client resource utilisation beyond MB, we have
  weights + stage ms only.
- **No competitive benchmark run.** The 2×2 in ⑭(b) is literature-based, not measured head-to-head. Label the
  axes as claims, not measurements.
- **No user study.** Slide 12's impact must stay qualitative.

### 7.4 One honest weakness worth surfacing deliberately

`latest.json` → `vision.perception.summary` shows the MobileViT classified the test-site pages as
`blank: 7, uncertain: 1` — i.e. on our own synthetic pages it is not discriminating. It still produced **5
conservative Tier-C escalations**, which is the fail-safe behaviour working as designed. If a judge spots this,
the pre-emptive answer is: *"On a synthetic form page the ViT is low-confidence, so it errs toward redaction.
That costs us precision and buys fail-closed behaviour, which is the trade we chose."* **Better to have that
sentence ready than to be surprised.**

---

## 8. Inspiration — links and what to steal

### Prior art that is *the same idea* (cite these; they make you look rigorous, not naive)

| Source | Link | What to steal |
|---|---|---|
| **GUIGuard** — privacy-preserving GUI agents, 3-stage pipeline, **630 trajectories / 13 830 screenshots** benchmark | [arxiv.org/abs/2601.18842](https://arxiv.org/html/2601.18842v3) · [project page](https://futuresis.github.io/GUIGuard-page/) | **Figure 2's three panels** — (a) local deployment too expensive, (b) Trustworthy Remote Service is advocacy-only, (c) **Trustworthy Local–Remote Hybrid**. This *is* our ①, already published. Cite it. Their headline — SOTA privacy recognition is **13.3% Android / 1.4% PC** — is a gift for our problem slide. |
| **Privacy Practices of Browser Agents** — 8 agents, **30 vulnerabilities** | [arxiv.org/html/2512.07725](https://arxiv.org/html/2512.07725v1) | The best single citation for slide 2. Independent evidence that mainstream agents leak. Use their 5-factor framework as the spine of the 2×2's y-axis. |
| **MINIM** — trusted local sanitization broker, sensitivity × necessity scoring, Contextual Integrity | [exa.ai/library/publication/x29qbl339fk](https://exa.ai/library/publication/x29qbl339fk) | Their **sensitivity × necessity 2×2** is a better 2×2 than ours for slide 5, and their term "semantic over-privileged observation" is a better name for our problem than anything we invented. |
| **PrivacyLens** — another team on SIH #26171 | [github.com/anirbandotdev/PrivacyLens](https://github.com/laiyagushi.com/anirbandotdev/PrivacyLens) | A sibling solution to the same problem statement. Their architecture is a linear list; ours has a gate and a benchmark harness. **Position on mechanism, and expect this comparison in Q&A.** |

### Technical visuals to imitate

| Source | Link | What to steal |
|---|---|---|
| **Set-of-Mark prompting** (Yang et al., Microsoft Research) | [arxiv.org/abs/2310.11441](https://arxiv.org/abs/2310.11441) · [som-gpt4v.github.io](https://som-gpt4v.github.io/) · [github.com/microsoft/SoM](https://github.com/microsoft/SoM) | **Their Figure 1 is a before/after of the same screenshot** with and without marks. That is *exactly* our `user-view → model-view` filmstrip, done in a paper. Also the citation for our `[N]` tags — currently uncited in the deck, which is a free mark. |
| **BrowserGym ecosystem** — element ids, bboxes, `set_of_marks` flag | [ar5iv.labs.arxiv.org/html/2412.05467](https://ar5iv.labs.arxiv.org/html/2412.05467) | Their Figure 4 shows overlay alignment between DOM ids and screenshot pixels. Second citation for SoM, and it positions us inside the standard web-agent evaluation lineage. |
| **OpenAI Computer-Using Agent** | [openai.com/index/computer-using-agent](https://openai.com/index/computer-using-agent/) | The **perception → reasoning → action** triangle, and the fact that CUA "seeks user confirmation for sensitive actions, such as entering login details or responding to CAPTCHA." That is the industry conceding our ⑳ risk ladder is necessary. Cite it on slide 11. |
| **UI-TARS SDK** | [github.com/Joenasriani/UI-TARS-desktop](https://github.com/Joenasriani/UI-TARS-desktop/blob/756ccc44573d0b4d2f6c78e71ac5c66a012ee484/docs/sdk.md) | Their loop is a 7-node Mermaid `flowchart LR` — one line of code to a clean architecture figure. **Use their Mermaid-first approach for ② and ⑬.** |
| **JIT Compiling Computer-Use Agents** (ICML 2026) | [icml.cc/media/icml-2026/Slides/66062.pdf](https://icml.cc/media/icml-2026/Slides/66062.pdf) | A 3-part numbered system overview (Protocol / Planner / Scheduler) with one takeaway per part. Good template for the 3-panel ladder's typography. Also: their **"adaptive selection wins the frontier"** scatter is the model for our ⑳′ Pareto plot. |
| **OS-Genesis** (ACL 2025) | [chuanyangjin.com/assets/slides/OS-Genesis.pdf](http://chuanyangjin.com/assets/slides/OS-Genesis.pdf) | Screenshot + action + state rendered as a **vertical strip**. Good precedent for the filmstrip on slides 1 and 13. |

### Security-deck visuals

| Source | Link | What to steal |
|---|---|---|
| **Threat Modelling Zero Trust** (KubeCon EU) | [static.sched.com/hosted_files/kccnceu2023/f0/Threat_Modelling_Zero_Trust_Slides.pdf](https://static.sched.com/hosted_files/kccnceu2023/f0/Threat_Modelling_Zero_Trust_Slides.pdf) | The **STRIDE threat → architectural control** two-column table, and the `T01 Exfiltrate data → C05 Egress control` pattern. This is the layout for ⑤. Also their "draw data flow diagrams" insistence. |
| **Autonomous & Exploitable: Breaking AI Agents** (DEF CON 34) | [media.defcon.org/.../Aaron Ang - Autonomous & Exploitable.pdf](https://media.defcon.org/DEF%20CON%20SG%201/DEF%20CON%20SG%201%20creators%20presentations/Aaron%20Ang%20-%20Autonomous%20%26%20Exploitable%20-%20Breaking%20AI%20Agents%20Before%20They%20Break%20Everything%20Else.pdf) | Their **"No trust boundary between any of these components"** one-liner is the perfect caption for the top half of our ① panel (a). And their confused-deputy / ambient-authority framing is the right vocabulary for ⑳. |
| **Threat Model Thursday: Data Flow Diagrams** | [shostack.org/blog/tmt-data-flow-diagrams](https://shostack.org/blog/tmt-data-flow-diagrams/) | The argument that a trust boundary is *instantiated by a control*, not just a line. That's the intellectual justification for why our GATE is a box, not a dashed rule. |

### Privacy-explainer metaphors

| Source | Link | What to steal |
|---|---|---|
| **Zero-knowledge encryption guide** (Ciphera) | [ciphera.net/blog/zero-knowledge-encryption-guide](https://ciphera.net/blog/zero-knowledge-encryption-guide) | **The safety-deposit-box vs bank-vault metaphor** — *"you hand over your valuables, the bank locks them up, and the bank keeps a copy of the key"* vs *"you bring your own padlock."* The best 15-second metaphor we found for slide 2/12, and it maps exactly onto local-sanitize-then-send. |
| **Apple Privacy — on-device processing / Private Cloud Compute** | [apple.com/privacy/features](https://www.apple.com/privacy/features/) | The pattern *"it's aware of your personal data, without collecting your personal data"* and the **device → Private Cloud Compute** two-zone split with an explicit "only the data relevant to your task" arrow. This is Apple's version of our boundary, and putting ours next to theirs on slide 3 is a strong credibility move. |
| **Zero-knowledge / client vs server-side encryption** | [secretnote.eu/en/blog/zero-knowledge-encryption](https://secretnote.eu/en/blog/zero-knowledge-encryption) | The compact **client-side vs server-side comparison table** (where encryption happens / who holds the key / breach exposure). Usable almost verbatim as the 4-row table under ⑭(b). |

### Systems-paper and deck-craft conventions

| Source | Link | What to steal |
|---|---|---|
| **Systems paper writing skill** — architecture, page-one figure, "draw a picture first" | [github.com/orchestra-research/ai-research-skills](https://github.com/orchestra-research/ai-research-skills/blob/HEAD/20-ml-paper-writing/systems-paper-writing/SKILL.md) | *"Architecture diagram first"*; Design section = architecture + module walkthrough + **alternatives considered and why the choice wins**. Our ① *is* the alternatives slide. This is the citation to justify why ① exists. |
| **OSDI '26 presenter instructions** | [usenix.org/conference/osdi26/instructions-presenters](https://www.usenix.org/conference/osdi26/instructions-presenters) | The figure-real-estate rules. Relevant because SIH is judged like a research track. |
| **Hackathon pitch deck structure** | [hacktribe.co](https://hacktribe.co/blog/how-to-build-a-hackathon-pitch-deck-practical-5-minute-structure) | *"One core idea per slide. Replace feature lists with a user flow, screenshot or result. Use charts only when they make a comparison easier."* Direct justification for the cut list. |
| **SIH playbook — what winning PPTs do** | [scribd.com/document/1075230242/SIH-Playbook](https://www.scribd.com/document/1075230242/SIH-Playbook) | **"The 15-second rule"** and **"visual-first design: replace long text with flowcharts, wireframes, process diagrams, comparison tables."** Use this when arguing for the visual rebuild. |

---

## 9. Build guidance (python-pptx reality)

**Native shapes are free and should carry:** ① 3-panel ladder · ⑤ threat table · ⑬ decision tree ·
⑭(b) 2×2 · ⑳ risk ladder · ⑤'s shield header bar · ②'s lane containers.

**Export as SVG/PNG and embed for:** ② the full swimlane · ③ the dot plot · ④ the latency bar.
Reason: connectors-with-bends and precise data-driven geometry are where python-pptx is worst, and these three
are the most information-dense. We already have a proven `LaTeX/TikZ → SVG → PDF` toolchain
(`docs/Report/architecture.tex` → `architecture.svg`) and Mermaid is already used in the README.

**Never use a native PowerPoint chart** for ③ or ④. Data-label positioning will wreck the layout, and you can't
control tick colour on a dark background. Render to SVG and place it.

**Dark-theme constraints (palette already fixed):**

| Colour | Hex | Use |
|---|---|---|
| background | `#0B0E17` | slide bg |
| card | `#121725` | panel fills — **never** pure black, it kills the ① boundary contrast |
| cyan | `#00B4D8` | on-device, capture, recall |
| green | `#00E676` | pass, verified, the safe side of the boundary |
| purple | `#7C3AED` | vision/perception, Tier B, Local AI |
| orange | `#FF6B35` | **GATE**, the bottleneck, Tier C escalation |
| red | `#EF4444` | raw pixels crossing, FORBIDDEN, D1/D2 open |
| yellow | `#FFD600` | the unmet 5 s target tick, Tier A |
| grey | `#A0AEC0` | competitor dots, de-emphasised text |

- **Contrast rule:** on `#0B0E17`, `#A0AEC0` is the *minimum* legible grey. Anything dimmer disappears on a
  projector. Competitor dots in ⑭(b) must be `#A0AEC0` or brighter, never 40% grey.
- **Minimum body text 14 pt, axis labels 12 pt, hero numbers 44–60 pt.** If a label needs to be smaller than
  12 pt to fit, the label is too long — shorten it, don't shrink it.
- **One accent per panel.** ① uses red/grey/green; do not also add purple and orange inside the same panels.
- **Redundant encoding.** Every meaning carried by colour must also be carried by shape or text. Colour-only
  encoding is the single most common way a projected deck fails.

---

## 10. Stretch goal — the one hero visual

**Recommendation: the three-panel paradigm ladder (①), full-width, with panel (c) carrying a real
`demo-india-pii-model-view.png` screenshot inside the device box.**

**Why this one, in 5 seconds:** a judge sees three agents. The first two send raw pixels to a black box or
can't reason at all. The third shows them a screenshot where every Aadhaar and PAN is a token, and the panel
that is red in (a) is green in (c). They understand both the problem and the fix without reading a word.

**Why not the alternatives:**
- *The swimlane (②)* is the best **architecture** diagram but it answers "how", and a judge who doesn't yet
  know why they should care won't read it. It is slide 4, not the hero.
- *The dot plot (③)* is the most **credible** visual and it belongs on the results slide, where a judge is
  already in evaluation mode. It persuades someone who is already persuaded.
- *The filmstrip alone* is strong but reads as "a demo screenshot" rather than "an argument."

**The one-line caption that must accompany it, verbatim:**
> *"The privacy layer isn't bolted on afterwards — it is the architecture."*

**Runner-up (use if the deck is judged to be purely technical):** ③ the per-category dot plot. It is the
visual no competitor can fake, because it publishes our worst number on the same slide as our best one.

---

## 11. Recommended build order

1. **Re-measure on-device assets** and resolve §7.1. Everything else can be built before this; this blocks slide 8.
2. **① 3-panel ladder** → slide 3. Highest return per hour.
3. **③ dot plot** → slide 6. Generate the SVG from `latest.json` programmatically so it can never drift.
4. **⑤ threat table** → slide 11. Almost free — the data is already in prose.
5. **Filmstrip** → slides 1, 2, 13. Crop the screenshots, add the numbered arrows.
6. **⑭(b) 2×2** → slide 9. Needs the citations, so do the reading in parallel.
7. **② swimlane** → slide 4. Most build time; author in TikZ or Mermaid, not python-pptx.
8. **⑬ decision tree** → slide 5. Mermaid → SVG is 20 minutes.
9. **④ latency** → slide 10. Reuse ③'s SVG pipeline.
10. **⑳ risk ladder + ⑨ layer stack** → slides 11, 8. Quick native shapes.
11. **§6 self-audit**, only after all of the above is on the slides.

**Every diagram should be generated from `benchmarks/results/*.json` rather than typed by hand.** We have
already been bitten once by hand-copied numbers drifting from the dashboard. A script that reads
`latest.json` and emits the SVG means the slide is *correct by construction* and can be regenerated after any
re-run.

---

## Quick reference

```
PIPELINE      CAPTURE → PERCEIVE → SANITIZE → GATE → REASON → ACT
TIERS         A = black box | B = stable token | C = blur
BOUNDARY      raw screen NEVER leaves; redacted JPEG + numbered DOM only
GATE          DOM regex + pixel OCR · fail-closed (gate can't run → BLOCKED)
GROUNDING     integer element ids [N], never coordinates
MODELS        MobileViT-Small 6.3MB · BlazeFace 230KB · Tesseract.js · Qwen2.5-VL 3B/7B

BUILD (8)     ① 3-panel ladder (s3) · ② swimlane+boundary (s4) · ③ P/R dot plot (s6)
              ⑤ threat→control (s11) · ⑬ tier decision tree (s5) · ⑭b 2×2 (s9)
              ⑳ risk ladder (s11) · filmstrip (s1,s2,s13)
CUT (9)       ⑮ funnel · ⑧ pyramid · ⑦ gantt · ⑩ before/after · ⑪ DFD
              ⑰ comparison · ㉑ hub-and-spoke · ⑥ venn · ⑯ feedback loop · ⑱ shield
NEVER DRAW    an airtight boundary before D2 closes · 5 s/step as achieved ·
              phone precision as anything but 0.34 · Firefox as "tested"

GAPS          judge-GPU latency · Firefox runtime · per-category latency ·
              energy · head-to-head competitive bench · user study
```
