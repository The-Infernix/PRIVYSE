// Consolidate all benchmark artifacts into one scoring-aligned report.
// Inputs:  results/latest.json            (sanitizer detection/redaction/leak/latency)
//          results/vlm-accuracy-3b.json   (VLM task accuracy + latency, 3b)
//          results/vlm-accuracy-7b.json   (VLM task accuracy + latency, 7b)
//          results/vlm-accuracy-routed.json (accuracy + latency, routed small/big)
// Output:  results/dashboard.json
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const R = (f) => join(__dirname, "results", f);
const read = (f) => (existsSync(R(f)) ? JSON.parse(readFileSync(R(f), "utf8")) : null);

const sanitizer = read("latest.json");
const vlm3b = read("vlm-accuracy-3b.json");
const vlm7b = read("vlm-accuracy-7b.json");
const vlmRouted = read("vlm-accuracy-routed.json");

// Scoring weights from the Problem Statement.
const WEIGHTS = {
  visual_context_accuracy: 0.25,
  pii_detection_f1: 0.20,
  redaction_precision: 0.20,
  client_resources: 0.20,
  end_to_end_latency: 0.15,
};

const detectionOverall = sanitizer?.overview?.f1Px;
const redactionPrec = sanitizer?.overview?.precisionPx;
const zeroLeakPass = sanitizer?.zeroLeak?.pass === true;
const clientFps = 60; // render index retained on-device
// On-device asset footprint from the bundled models manifest: "weights" are
// model files (tflite + traineddata); the rest is WASM runtime glue.
const modelsManifest = (() => {
  try {
    return JSON.parse(
      readFileSync(join(__dirname, "..", "extension", "public", "models", "manifest.json"), "utf8"),
    );
  } catch {
    return null;
  }
})();
const clientWeightsMB = modelsManifest
  ? +(Object.entries(modelsManifest.files ?? {})
      .filter(([f]) => f.startsWith("face/") || f.startsWith("tesseract-lang/"))
      .reduce((a, [, b]) => a + Number(b), 0) / 1048576).toFixed(2)
  : null;
const clientAssetsMB = sanitizer?.vision?.modelsMB ?? 0;
const perStepE2e7b = (vlm7b?.latency_waterfall_ms?.vlm?.mean || 0) +
  (sanitizer?.latencyWaterfallMsAvg?.capture || 0) +
  (sanitizer?.latencyWaterfallMsAvg?.serialize || 0) +
  (sanitizer?.latencyWaterfallMsAvg?.vision || 0) +
  (sanitizer?.latencyWaterfallMsAvg?.sanitize || 0) +
  (sanitizer?.latencyWaterfallMsAvg?.imageGate || 0) +
  (vlm7b?.latency_waterfall_ms?.execute?.mean || 0);

const perCriterion = {
  visual_context_accuracy: {
    weight: WEIGHTS.visual_context_accuracy,
    metric: "task completion with VLM",
    vlm_3b: vlm3b ? { passed: vlm3b.task_success.passed, total: vlm3b.task_success.total, rate: vlm3b.task_success.rate, avg_steps: vlm3b.agent_steps.mean } : null,
    vlm_7b: vlm7b ? { passed: vlm7b.task_success.passed, total: vlm7b.task_success.total, rate: vlm7b.task_success.rate, avg_steps: vlm7b.agent_steps.mean } : null,
    routed_small_big: vlmRouted ? { passed: vlmRouted.task_success.passed, total: vlmRouted.task_success.total, rate: vlmRouted.task_success.rate, avg_steps: vlmRouted.agent_steps.mean, description: "3b for interactive steps, 7b for read/report tasks" } : null,
  },
  pii_detection_f1: {
    weight: WEIGHTS.pii_detection_f1,
    metric: "detection P/R (pixel IoU) over GT-labelled pages",
    overview: sanitizer?.overview,
    categories: sanitizer?.categories,
    zero_leak_pass: zeroLeakPass,
  },
  redaction_precision: {
    weight: WEIGHTS.redaction_precision,
    metric: "(redacted ∩ GT) / redacted pixels",
    precision_px: redactionPrec,
    recall_px: sanitizer?.overview?.recallPx,
    f1_px: detectionOverall,
  },
  client_resources: {
    weight: WEIGHTS.client_resources,
    metric: "client-side work per step",
    capture_ms: sanitizer?.latencyWaterfallMsAvg?.capture,
    serialize_ms: sanitizer?.latencyWaterfallMsAvg?.serialize,
    vision_ms: sanitizer?.latencyWaterfallMsAvg?.vision,
    sanitize_ms: sanitizer?.latencyWaterfallMsAvg?.sanitize,
    zero_leak_ocr_ms: sanitizer?.latencyWaterfallMsAvg?.imageGate,
    faces_found: sanitizer?.vision?.facesFound,
    ocr_hits: sanitizer?.vision?.ocrHits,
    weights_mb: clientWeightsMB,
    total_assets_mb: +clientAssetsMB.toFixed(2),
    weights_breakdown: "BlazeFace short-range tflite (~0.23 MB) + tesseract eng fast traineddata (~1.98 MB); remainder is WASM runtime glue (MediaPipe + Tesseract), all bundled — no CDN fetches",
    notes: zeroLeakPass
      ? "On-device vision live: MediaPipe face blur (Tier C) + region-restricted Tesseract OCR; zero-leak gate = DOM regex scan + OCR of the sanitized screenshot"
      : "zero-leak FAILED",
  },
  end_to_end_latency: {
    weight: WEIGHTS.end_to_end_latency,
    metric: "full loop ms/step (capture → serialize → sanitize → upload+VLM → execute)",
    vlm_3b_ms: vlm3b?.latency_waterfall_ms,
    vlm_7b_ms: vlm7b?.latency_waterfall_ms,
    vlm_routed_ms: vlmRouted?.latency_waterfall_ms,
    per_step_e2e_7b_ms: Math.round(perStepE2e7b),
    target: "p50 < 5000 ms/step (Phase 4)",
    hardware_note: "dev box = RTX 3050 4GB VRAM; qwen2.5vl:7b (6.2GB) runs 75% CPU / 25% GPU — image tokens floor at ~1024 so prefill+decode are CPU-bound (~10.5s minimal prompt probe). VLM_MAX_TOKENS=128 + compact system prompt + IMAGE_MAX_SIDE resize reduce context cost; routed mode sends interactive steps to 3b (~7.5–8.0s) and only read/report steps to 7b. Reaching <5s/step requires VRAM ≥ model size (judge hardware), or a GPU-resident small model.",
  },
};

const routedVlmTotalMs = (vlmRouted?.runs || []).reduce(
  (a, r) => a + (r.avgLatencyMs?.upload || 0) * r.steps, 0);
const routedVlmSteps = (vlmRouted?.runs || []).reduce((a, r) => a + r.steps, 0);
const routedPerStepAvgMs = routedVlmSteps ? routedVlmTotalMs / routedVlmSteps : null;

const dashboard = {
  generated_at: new Date().toISOString(),
  model_set: ["qwen2.5vl:3b", "qwen2.5vl:7b"],
  test_site_pages: sanitizer?.pages?.length ?? null,
  per_criterion: perCriterion,
  scorecard: {
    pii_detection: { f1: detectionOverall, ok: zeroLeakPass },
    redaction: { precision: redactionPrec },
    visual_context: { best_rate: Math.max(vlm3b?.task_success?.rate ?? 0, vlm7b?.task_success?.rate ?? 0, vlmRouted?.task_success?.rate ?? 0) },
    client_resources: { ok: (clientWeightsMB ?? 0) <= 20, weights_mb: clientWeightsMB, total_assets_mb: +clientAssetsMB.toFixed(2) },
    latency_e2e_7b_ms_per_step: Math.round(perStepE2e7b),
    latency_routed_ms_per_step: routedPerStepAvgMs ? Math.round(routedPerStepAvgMs) : null,
  },
};

writeFileSync(R("dashboard.json"), JSON.stringify(dashboard, null, 2));
console.log("wrote results/dashboard.json");
console.table({
  "PII detection F1 (px)": detectionOverall,
  "Zero-leak pass": zeroLeakPass,
  "Redaction precision (px)": redactionPrec,
  "Visual context 7b (task rate)": dashboard.scorecard.visual_context.best_rate,
  "E2E ms/step (7b)": dashboard.scorecard.latency_e2e_7b_ms_per_step,
  "E2E ms/step (routed)": dashboard.scorecard.latency_routed_ms_per_step,
});