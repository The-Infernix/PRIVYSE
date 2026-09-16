# Latency budget — target <5 s/step (judge-class GPU)

Status: **projection** (written 2026-09-16 after live measurement drive on the 4 GB dev box).
The `<5 s/step` target (README line 167: *p50 < 5000 ms/step on judge-class GPU*, latency = 15% of the scoring map) is **not reachable on the 4 GB development laptop**; this doc records why, and the expected budget on the judge machine.

Reference: `benchmarks/vlm-bench.mjs` (per-phase waterfall), `benchmarks/results/dashboard.json`, `benchmarks/latency-probe.mjs`.

---

## 1. Measured today on the 4 GB dev box (Ollama, warm server)

### VLM call breakdown (via Ollama `/api/chat` metrics, identical prompt+image per model)

| Model | Prompt tokens | Prefill | Decode rate | /act-like wall (steady state) |
|---|---|---|---|---|
| qwen2.5vl:3b (interactive) | ~1.6–3.4k | **~75–110 ms** | ~78 ms/token | **~4.0 s** (direct) / ~6.6 s (prod pipeline: tall 1280×2400 viewport + perception block) |
| qwen2.5vl:7b (read/report) | ~1.6–3.2k | ~200 ms | ~210 ms/token | **~13.5 s** |
| qwen3-vl:2b | ~1.4k | ~20 ms | ~18 ms/token | unusable (1–2.7k-token thinking block even with `/no_think`; capping truncates the JSON) |
| minicpm-v4.6:1b | ~1.7k | ~23 s (cold) | ~7 ms/token | unusable (non-spec JSON schema: `{"action":"input"}`) |
| moondream | ~1.7k | ~6 s (cold) | ~31 ms/token | unusable (returns bbox coordinates) |

Takeaway: **prefill is nearly free; decode (generation) dominates and is hardware-bound.**

### Production per-step waterfall (real harness, qwen2.5vl:3b, fresh page → first step)

| Phase | ms/step |
|---|---|
| capture | 58 |
| serialize | 2 |
| sanitize | 116 |
| vision (faces+OCR+ViT) | 1729 (first step only; **cached → 0** on visually unchanged later steps) |
| upload = VLM (`/act`) | 6622 |
| execute | 1272 (includes navigation of the clicked "Continue") |
| rethink | 0 |
| **First-step E2E** | **~9.8 s** |

Steady-state later steps: on-device overhead ≈ 0.4 s (capture+serialize+sanitize+execute), vision cached, VLM ~4–6.6 s.

> Note: `dashboard.json` currently shows `latency_e2e_7b_ms_per_step ≈ 21.2 s` and `latency_routed_ms_per_step ≈ 13.0 s`. Those are **cold/full-suite artifacts** (model loads inside the timed run, tallest-viewport captures, and a failed read task). They are being replaced by steady-state figures; the waterfall above is the current measured truth.

## 2. Resulting facts

- Every "obvious" lever is a dead end on this machine:
  - **Prompt length** (full vs compact system, ±40 DOM entries, vs no DOM): saves only ~30–100 ms of prefill. Not the bottleneck.
  - **Image size**: server already caps at `IMAGE_MAX_SIDE=800` (JPEG q80); Qwen2.5-VL image-token floor ~1.3k tokens. Minor prefill only.
  - **Faster small models**: all three candidates fail on output spec/safety (see table).
- Generation budget is decode-bound: replies are 55–90 tokens (budget "≤45"); at 78 ms/token (3b) that is 4.3–7 s of decode.

## 3. Judge-GPU projection

Assumption: decode is bandwidth-bound and scales with the dGPU. Conservative judge-class reference decode rates (FP16/QS quant, single active request): 3B ≈ 100–150 tok/s, 7B ≈ 45–70 tok/s (midrange dGPU; far higher on A100-class).

| Route | Prefill | Decode (tokens @ rate) | On-device overhead (steady step) | **Projected p50/step** |
|---|---|---|---|---|
| Interactive (3b) | 0.1 s | 60 tok @ 100 tok/s ≈ 0.6 s | ~0.4 s | **~1.1–1.5 s** |
| Read/report (7b) | 0.2 s | 65 tok @ 50 tok/s ≈ 1.3 s | ~0.4 s | **~1.9–3.0 s** |
| Routed (3b/7b mix) | — | — | — | **well under 5 s** |

First-step caveats (one-off, not p50): on-device vision pass ~1.7 s; model cold-load once, amortized/pre-warmed via the existing `/warm` endpoint. Neither affects p50 across a task.

Config already shipping that keeps the judge machine at these numbers: `num_ctx=4096` with prefix caching, `max_tokens=128` (`VLM_MAX_TOKENS`), `keep_alive` on the Ollama side, perception-cached vision (no re-run of faces/OCR/ViT on unchanged visual state), and server-side image downscale to 800 px.

## 4. Verification on the judge machine

```bash
# warm the default model once (avoids cold-load inflation)
curl "http://127.0.0.1:8000/warm?model=qwen2.5vl:3b"

# interactive slice (3b), 3 runs
BENCH_ONLY=flight-booking BENCH_MODEL=qwen2.5vl:3b node benchmarks/vlm-bench.mjs

# read/report slice (7b)
BENCH_ONLY=pii-in-the-wild BENCH_MODEL=qwen2.5vl:7b node benchmarks/vlm-bench.mjs

# routed end-to-end (server perception routing)
BENCH_ROUTE=perception node benchmarks/vlm-bench.mjs
```

Pass criteria: `upload`(=VLM) + `execute` waterfall p50 per route above, and `latency_routed_ms_per_step < 5000`.

## 5. Living doc

Update this section after a judge-machine run: replace the projected rows with measured p50, and link the `benchmarks/results/dashboard.json` latency fields once regenerated (requires `aggregate.mjs` over a fresh full suite on that machine).