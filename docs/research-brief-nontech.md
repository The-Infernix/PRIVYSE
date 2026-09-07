# SIH 26171 — Research Focus Areas

## Current state of the project (what's already built)

We're building a privacy-first browser assistant. It watches a webpage, figures out what
to do next, does it, and repeats — without any of your personal data ever leaving the machine.

How it works:

1. The extension reads the page (structure + screenshot).
2. On-device, before anything is sent anywhere, it **hides sensitive info** — passwords,
   emails, phones, Aadhaar, PAN, card numbers — replacing them with safe placeholders like
   `[EMAIL_1]`.
3. Only the cleaned version goes to the AI model, which decides the next action
   (click, type, scroll…).
4. The action executes back in the browser, and the loop repeats until the task is done.

**Working so far:** DOM reader, PII hiding (email/phone/Aadhaar/PAN/card + password fields),
action engine, the AI loop itself (Qwen2.5-VL model, runs on a local server), and a side
panel UI to watch each step.

**Not built yet — our current gaps:** no face-blur, no OCR for text inside images, no
measurement of how accurate our hiding is (no test pages / metrics dashboard yet), and no
polished slides/demo evidence.

**The rule for research:** anything in the "working so far" list is already decided — don't
research it. Focus only on the gaps.

---

## The research

Four areas, each feeding a different part of the build. Pick one and run with it —
your findings get incorporated directly into the product.

---

## Track 1 — Competitive landscape

**What we need to know:** what AI browser-assistant products already exist, and how
each one positions itself — especially around privacy and where data is processed.

Look at: current AI browser agents (e.g., OpenAI Operator and similar), open-source
projects in this space, and any coverage around them and data privacy.

**Return:** a short list of the main players, one line on what each does, and any
privacy/data-handling claims they make, with links.

---

## Track 2 — Sensitive data on Indian sites

**What we need to know:** the full range of personal/sensitive details that appear on
Indian web pages — bank portals, checkouts, flight booking, government services — and
what each looks like in the wild.

Look at: live examples on real sites, plus official format references for Indian IDs
(Aadhaar, PAN, Voter ID, Driving Licence, Passport), phone numbers, UPI IDs, IFSC and
bank account formats.

**Return:** a collected set of examples — "email looks like x, Aadhaar is 12 digits with
structure y, UPI is name@bank, IFSC is 11 chars…" — with any official reference pages
linked.

---

## Track 3 — On-device perception feasibility

**What we need to know:** whether face detection / blurring and text recognition can run
inside a normal browser tab (no server involved), and how well.

Look at: browser-based face-detection tools (e.g., MediaPipe and its demos), browser
text-recognition (e.g., Tesseract.js demos), and current WebGPU support across browsers.

**Return:** for face detection and for text reading — does a working browser demo exist,
and does it actually run in a normal browser? Links encouraged.

---

## Track 4 — Evaluating redaction quality

**What we need to know:** how others measure whether a tool successfully hides sensitive
information — i.e., what "hiding it correctly" means in measurable terms.

Look at: PII redaction evaluation approaches and tooling (e.g., Microsoft Presidio and
similar), precision/recall conventions for detection tasks, and OCR-based leak checking.

**Return:** the common ways "did the sensitive data stay hidden" gets measured, in plain
terms, with links.

---

Each track maps to a real gap in the current build. Findings from all four get merged in
the same doc, so shared links and short notes (a few lines each) are completely sufficient.