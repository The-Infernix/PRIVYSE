# Perception failure-path audit — on-device MobileViT (extension)

Scope: `extension/core/perception.ts` + its wiring in `extension/core/vision.ts`, the
WebAssembly runtime (onnxruntime-web), and the "ON-DEVICE PERCEPTION" block sent to the
server. The question under audit: **can any perception failure cause a privacy leak, i.e.
fail-open in a way that the rest of the pipeline does not catch?**

Verdict up front: **no fail-open leak path was found.** Every perception failure degrades to
the pre-perception baseline (blind redaction + DOM sweep + OCR + faces + zero-leak gate all
still enforce in full). Perception is purely an *additive backstop*; nothing about the
shipping guarantee depends on it. Two real issues were found and fixed (below, §4, §5).
One residual capability limit is documented and accepted (§7).

---

## 1. Method

1. Read the full perception pipeline (`perception.ts` end to end, then `vision.ts::runVision`
   and the sanitizer's handling of `decisions.escalate`).
2. Enumerated every failure point, and for each asked: *"what does the system do, and does
   anything sensitive still transit?"*
3. Reproduced the two suspected failure modes under a real headless Chromium (probe scripts in
   `benchmarks/`): stale/unbundled model (graceful disable), and batched-ONNX-input corruption.
4. Re-ran the full bench suite to confirm no metric regression after the fixes.

## 2. Architecture (as of this audit)

`vision.ts::runVision` runs **three independent on-device passes concurrently** —
`Promise.all([perception, faces, ocr])` — each wrapped in its own `withTimeout`, plus the
models-size meter. Any pass that fails is recorded in `stats.skipped` and the others complete
unaffected. A sanitized payload is only produced *after* all passes resolve.

- Face detection (BlazeFace) → padded boxes → whole-region taint for non-DOM regions.
- OCR (Tesseract) over image/canvas regions → PII hits added as redactions.
- Perception (MobileViT-small q8) → semantic tile map + per-region decisions
  (`escalate` = whole-region Tier-C blur; `ocrPriority`; `captchaLike`).

Perception **never blocks** the others and **never runs first**; its `decisions.escalate`
merely *adds* redaction regions to the sanitizer. It is best-effort by construction.

## 3. Failure mode catalog

Each row: mode → consequence → open/closed → mitigation.

| # | Failure mode | Consequence | Fail-open? | Mitigation |
|---|--------------|-------------|------------|------------|
| 1 | `session`/labels never load (fetch 404, CSP blocks `chrome.runtime.getURL`) | `enabled:false`, zero tiles/decisions | No | `perceiveScreen` returns the `{enabled:false,...}` base object; `vision.ts` records `skipped:"perception:…"`; nothing is escalated via perception. Baseline protections unchanged. |
| 2 | WASM unavailable / module bundle missing (e.g. stale build, `file://` page) | `loadOrt` throws → same as #1 | No | Same degrade path. Verified live: feeding a build without the ort glue yields `"mobilevit-small (q8) — unavailable: no available backend found"` — graceful, no crash (`benchmarks/probe-perception.mjs`). |
| 3 | Image decode of screenshot fails | `enabled:false` | No | Same. |
| 4 | A single tile classification throws | tile skipped, loop continues | No (per-tile isolation) | `try/catch` per tile inside the budget loop. |
| 5 | `perception` inner timeout (7 s) | partial tile set; regions not covered by a finished tile get no decision | Partial | `vision.ts` has its own 30 s overall budget, but perception now runs **concurrently** with faces/OCR (§4), so a slow perception can no longer eat the shared budget. Missing decisions only mean fewer *additive* redactions; faces/OCR/zero-leak still fire. |
| 6 | Budget (`budgetMs` 2500) exceeded mid-grid | partial grid — far-from-grid regions not tiled → no region decision | Partial (tiles only) | Bounded; face + OCR are independent and cover non-DOM regions regardless of tiling. |
| 7 | `decideRegions` sees no overlapping tile | no escalation for that region | No | By design: if the ViT couldn't see the region, it must not invent decisions; face + OCR still guard the region. |
| 8 | ONNX batched input — **ort-wasm 1.29 bug** | degraded logits (uniform ~30 %) → wrong tags/decisions | Yes (if shipped) | Found via `_abTest` A/B; **fixed** by staying at `batch=1` per tile (§5). |
| 9 | Server-side block serialization of `screen_perception` | N/A (server already treats model errors → cautious prompt) | No | Prompts mark on-device perception as *additive context*. If the block is absent the VLM still redacts from instructions + its own vision. |

Coverage conclusion after fixes: perception failures fall into **Fail-closed (1–3) → additive
redactions lost** or **Bounded (5–6) → partial grid**. In **no** case does sensitive content
travel that the other three independent passes would not already block or flag.

## 4. Fix 1 — perception can no longer starve faces/OCR

Before: perception ran **serially** inside `runVision`, with a **15 s** inner timeout against
a shared **30 s** vision budget. A hung/slow MobileViT could consume half the whole budget and,
in the worst case, cause faces/OCR to be skipped → *that* was a genuine fail-open contributor
(faces/OCR are the layers perception must not starve). Fixed in `vision.ts` by moving all three
passes into `Promise.all([...])`; perception's inner timeout tightened to **7 s**. Wall-clock
vision latency is now `max(perception, faces, OCR)` instead of the sum.

## 5. Fix 2 — onnxruntime-web wasm batch corruption

`InferenceSession.run` with a `[N,3,256,256]` batched input on **onnxruntime-web 1.29 wasm**
returns degraded logits (every tile pinned at ~22–33 % `uncertain`, wrong classes), while
`onnxruntime-node` is **bit-exact** for the same batches and while `batch=1` on the web
backend matches the native reference exactly (verified tile-by-tile in
`benchmarks/probe-batch.mjs`). A batched deployment would have mis-escalated regions and,
worse, turned *real* photos into `uncertain`/`blank` — reducing sensitivity. Resolution:
perception stays at **`batch=1` per tile** (documented in `perception.ts::classifyCanvas`),
and `_abTest()` is retained as a regression tripwire for future ort upgrades. The latency win
comes from the §4 parallelization, not batching.

## 6. Guarantees that hold regardless of perception

- **Zero-leak gate** (`zero-leak.ts`): GT PII values are re-scanned in the *sanitized* body and
  screenshot before upload. Perception cannot disable this.
- **Face + OCR passes** run independently of perception and are themselves whole-region
  conservative for non-DOM imagery.
- **DOM sweep + tokenizer** mask text PII in the DOM before vision even starts.
- **Escalation is additive**: `decideRegions` can only *add* regions to redaction; a false
  negative (missed escalation) leaves the baseline layers in force.

## 7. Residual risk (accepted, capability not failure)

A `photo`-bearing element (e.g. an avatar photo) that lives in a tile the ViT reads as low-info
`blank` gets **no perception escalation**. This is not a leak: face detection + OCR still
operate on that region and the region redaction still applies when either fires. It is a
duplication-redundancy limit, not an open channel — and it is exactly what the
`perception-eval` ("photo/blank separation") measurement exists to surface. Improved by any
stronger local vision model, without changing the integrity of the other layers.

## 8. Verification

- `benchmarks/probe-perception.mjs` — graceful disable on broken backend; accurate tile map on
  pii-in-the-wild (`blank 5, photo 1`), escalate 0 (correct: avatars handled by face, not ViT).
- `benchmarks/perception-eval.mjs` — labelled-tile GT page: photo/blank separation **100 %**,
  region escalation fires on photo cell, blank cells never escalated.
- `benchmarks/probe-batch.mjs` — documents the wasm batch bug and pins determinism.
- Full `npm run bench` remains green with prior metrics (see `benchmarks/results/latest.json`).