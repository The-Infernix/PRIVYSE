# SIH 26171 — Research Brief (for the research team)

**Deadline:** 20 Sep 2026 (16 days)
**The rule for every track:** *no code, no repo work — only search, read, compare, recommend.*
Every deliverable is a short written doc, not files. You answer questions; the builders build.

**Why this brief exists:** the architecture is already built through most of Phase 1
(DOM serializer, sanitizer + PII redaction, Set-of-Marks overlay, real Qwen2.5-VL server,
executor, multi-step loop). So research targets **gaps**, not "what is a browser agent."

---

## Scoring map (what every research track must serve)

| Weight | Metric | Research relevance |
|---|---|---|
| 25% | Visual context accuracy | Track 1 (what the VLM needs, Set-of-Marks) |
| 20% | PII detection recall & precision | Track 2 (patterns + false positives) |
| 20% | Redaction precision | Tracks 2–3 (redaction methods, zero-leak) |
| 20% | Client resource utilization | Track 2 (tiny models, WebGPU/WASM) |
| 15% | End-to-end latency | Track 4 (what to measure, budgets) |

---

## How to run it

1. Assign one track per person (3 people → merge tracks 3+4; 2 people → you
   own 1+4, partner owns 2+3).
2. Everyone uses the **same research template** below.
3. Log every architectural decision in the **Research → Decision** log.
4. Day 1–2 research, then a half-day **architecture/evidence meeting** where each
   person presents 10 minutes. You draw one diagram; the "what needs AI?" question is mandatory.

---

## Track 1 — Visual context: what does the VLM actually need?

**Main question:** *What is the minimum information a server-side VLM needs to choose the
correct next action, while keeping the most sensitive pixels on-device?*

Investigate:

- **Set-of-Marks prompting** (Yang et al., "Set-of-Marks Prompting Unleashes Extraordinary
  Visual Grounding in GPT-4V") — we already tag bboxes; find the evidence that this works.
- Whether a **structured DOM + bboxes + sanitized screenshot** outperforms a bare screenshot.
- The accuracy cost of redacted regions: does the VLM act on `[EMAIL_1]` tokens + DOM text
  as well as it does on visible values? (This decides how aggressive redaction can be.)
- Token/latency tradeoffs of the hybrid payload (image tokens vs DOM text for the VLM).

**Sources to start:** Set-of-Marks paper, browser-use, OpenAI Operator, UI-TARS, SeeAct,
WebVoyager, WebArena.

**Deliverable:** landscape doc — 10–15 existing browser/computer agents listed with
perception mechanism, action schema, strengths/weaknesses, "what we borrow", "what doesn't
apply to our PS". End with: **recommended payload design.**

---

## Track 2 — Privacy + on-device vision

Highest priority (40% of the score).

**Main questions:**
- *Which Indian PII types are we missing, and how do you detect them with low false positives?*
- *What models/libraries can blur faces and OCR text on-device under a 20 MB budget, no CDN?*

### 2a. PII pattern gap (`extension/core/pii-rules.ts` already covers the below)

Already covered in code — do **not** re-research these: email, `+91`/10-digit phone,
12-digit Aadhaar, PAN `[A-Z]{5}\d{4}[A-Z]`, Luhn-validated cards, and field-name heuristics
(password/email/phone/aadhaar/pan/card/ssn/name/address/dob).

Research the gaps:

- UPI IDs (`name@okbank`), IFSC codes, bank account numbers (with bank-based validation),
- Voter ID, Driving Licence, Passport number formats,
- DOB / age / salary / address line heuristics and their false-positive rates,
- Whether existing open-source pattern libraries (Google libphonenumber, Aadhaar/PAN
  checksum validators on npm/PyPI) provide better patterns than our regexes.

**Deliverable:** a `PII type → pattern → source → tier → false-positive risk` table.
We copy patterns; we don't invent them.

### 2b. On-device face + OCR models

Candidates from the build plan (already shortlisted — validate, don't re-shop):
MediaPipe Face Detector, Tesseract.js (WASM), onnxruntime-web + WebGPU/WASM.

Investigate: model size, accuracy on **screenshots vs photos**, WebGPU availability on judge
machines, single-thread WASM behavior (no COOP/COEP), and real-world Chrome-extension
examples of each.

**Deliverable:** comparison table — model / size / accuracy / browser-friendliness / <20 MB? /
latency; then pick **one face model** and **one OCR lib** with reasons + fallback.

---

## Track 3 — Redaction precision + evaluation methodology

**Main question:** *How do we measure "detection recall/precision" and "redaction precision"
in a way judges accept, and what should our test pages contain?*

Investigate:

- Existing PII-redaction benchmarks and methodology: Microsoft Presidio, "PII redaction
  evaluation IoU", OCR-based leak detection.
- Standard formulas and IoU thresholds for box matching (e.g., IoU ≥ 0.5 = a hit).
- What `test-site/` needs: a fake flight-booking / bank-transfer flow where every PII
  element carries `data-gt="email:alice@example.com"` ground truth, plus AI-generated face
  images and a PDF/canvas corner-case page. Map the full PII inventory each page should embed
  (covered types + the Track-2 gaps).
- Latency waterfall conventions: capture / serialize / sanitize / upload / VLM / execute,
  p50 & p95.

**Deliverable:** (a) exact metric formulas we should compute, (b) a proposed ground-truth
dataset spec (pages + embedded PII inventory), (c) what a benchmarks runner must collect.

---

## Track 4 — Evidence, slides, and the "what's our edge" narrative

**Main question:** *Why is on-device redaction a defensible, winner-worthy claim?*

Investigate + collect citations for slide material:

- Privacy-preserving agent research: what do papers say about data leaving the device,
  and does on-device filtering measurably reduce leak risk?
- What past SIH entries in this category did, and what the PS wording emphasizes.
- Anything that supports showing "raw capture never leaves the machine" as proof in a demo
  (e.g., network-log capture during a run).

**Deliverable:** a short evidence doc with 5–8 citations and 3 slide-ready claims
(each claim: statement + source).

---

## Research template (everyone uses this)

```text
# Research Topic

## 1. Problem
What problem does this technology/approach solve?

## 2. Existing Solutions
Relevant systems / papers / projects.

## 3. How It Works
The mechanism, in a few paragraphs.

## 4. Advantages

## 5. Limitations

## 6. Browser Feasibility
Can it run in Chrome/Firefox, on a weak laptop?

## 7. Privacy Implications
What data leaves the device, and what stays local?

## 8. Performance
Size / latency / RAM / GPU (fill what's known).

## 9. Relevance to SIH 26171
High / Medium / Low — why.

## 10. Recommendation
Use / Don't use / Investigate further.

## 11. Sources
Paper / GitHub / Docs / Benchmark (links).
```

---

## Research → Decision log (use for every major decision)

Do **not** write "ONNX Runtime Web supports WebGPU." Write:

```text
RESEARCH
  ONNX Runtime Web supports browser inference + WebGPU acceleration.

DECISION
  Use ONNX Runtime Web as the primary local inference runtime.

REASON
  Control over model format, browser execution, performance benchmarking.

RISK
  Model compatibility / WebGPU availability on empty judge machines.

FALLBACK
  WASM execution.
```

---

## First question for the whole team (answer before building anything else)

> **How should a privacy-preserving browser agent represent a webpage before sending
> anything to a server?**

It connects DOM + vision + PII + redaction + VLM + latency — answering it well decides
almost everything else, and it's the story the judges will hear.