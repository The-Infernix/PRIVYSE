# PRIVYSE — Presenter Cheat-Sheet (SIH 2026 · Research Track · Problem #26171)

## One-line pitch
"PRIVYSE is the only browser agent that redacts your Aadhaar, PAN, cards and faces **on your own device** before anything is sent to an AI model."

## Slide-by-slide (14 slides, ~60s each)
| # | Slide | One thing to say | Key number |
|---|-------|------------------|-----------|
| 1 | Title | "Privacy-Preserving Browser Automation" | — |
| 2 | Problem | Cloud agents send raw screenshots; local agents don't redact | — |
| 3 | Solution | **Sanitize before you send** | — |
| 4 | Architecture | Loop: Capture → Sanitize → Zero-Leak → Local VLM → Execute | Only redacted pixels leave |
| 5 | 3-Tier Redaction | A: secrets(black box) · B: PII(tokens) · C: faces+canvas | [EMAIL_1] stable tokens |
| 6 | Results | Hero numbers — read slowly | **F1 0.979 · 3/3 · PASS** |
| 7 | Benchmarks | Maps to the 5 scoring criteria | 25/20/20/20/15% |
| 8 | Tech Stack | Local-first everything | 21.4MB total, 0MB cloud |
| 9 | Edge | Both **local AND redacted** — no one else does both | — |
| 10 | Latency | 5 levers, 3B/7B routing | 12.7s → <5s on judge GPU |
| 11 | Zero-Leak | 5 defense layers, fail-closed | "Gate can't run → BLOCKED" |
| 12 | Impact | Privacy · Productivity · Accessibility · Research | — |
| 13 | Demo | Network tab = proof | 3 min, 4 steps |
| 14 | Thank You | Restate pitch, open Q&A | — |

## Hero metrics (memorize these)
- PII detection **F1 0.979** — recall **1.000** (caught everything), precision 0.959
- Redaction precision **0.959** (VLM still sees enough context)
- **3/3** tasks at 100% visual-context accuracy, avg **1.0 step**
- Zero-leak: **PASS** (DOM regex + OCR of sanitized pixels)
- Face detection F1 **1.0** · Canvas OCR F1 **1.0**
- Latency: **12.7s/step** routed (interactive 7.5–8.0s) on 4GB GPU
- Assets: **2.2MB** model weights, **21.4MB** total, **0MB** off-device fetches

## The 5 scoring criteria (judges check these)
1. Visual-context accuracy **25%** → 3/3 tasks, DOM+SoM+screenshot hybrid
2. PII detection recall/precision **20%** → F1 0.979, GT test site
3. Redaction precision **20%** → 0.959 pixel-level, rasterized masks
4. Client resource utilization **20%** → small models, bundled, no CDN
5. End-to-end latency **15%** → routed 3B/7B

## Likely judge questions
- **"Why not just use a cloud agent?"** → Data sovereignty. India runs on Aadhaar/UPI; raw screenshots to a cloud never acceptable.
- **"How do you PROVE zero-leak?"** → Network tab during demo shows only sanitized payloads to 127.0.0.1; two fail-closed gates; gate-can't-run = blocked.
- **"Does it work on weak hardware?"** → Yes — 4GB GPU laptop (RTX 3050), routed 3B/7B is the low-memory design.
- **"Where's the VLM?"** → Local Ollama, model pinned resident (keep_alive), zero API cost, offline.

## Honesty points to own
- <5s/step not yet met on 4GB dev laptop (12.7s measured). Sub-5s is reachable with VRAM ≥ model size (judge-class GPU).
- Firefox pass still in progress (vision host must move to sidebar).
- These are stated openly — judges respect it.

## Demo script (3 min)
1. **(30s)** Open test-site flight booking page (GT-labelled PII fields).
2. **(60s)** Type task in side panel → Run. Agent captures, sanitizes, calls local VLM, executes.
3. **(30s)** Network tab open: only sanitized payloads leaving, destined for **127.0.0.1:8000**.
4. **(30s)** Side-by-side original vs sanitized: black boxes, [EMAIL_1]/[PAN_1] tokens, blurred faces, numbered SoM tags.
5. **(30s)** Wrap: live VLM "thinking" tokens stream via SSE in the side panel.