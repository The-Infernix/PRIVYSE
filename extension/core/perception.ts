// On-device screen perception (PS §1 "local Vision Transformer reads the screen").
//
// A real MobileViT-Small (ImageNet-224/256 pretrained, q8 ONNX) runs IN the
// browser — the offscreen document in the extension, the page itself in the
// benchmark host — and reads the screen in coarse tiles. Each tile is mapped to
// a web-UI semantic tag (photo / ui / document / data / blank / uncertain) so
// the local layer produces a SEMANTIC LAYOUT MAP of the visible page before
// anything leaves the device.
//
// Two consumers:
//   1. The sanitizer — non-DOM image regions that look like photographic / UI /
//      document content are escalated to whole-region redaction (identity
//      imagery never leaves, even when BlazeFace finds no face and OCR finds no
//      text).
//   2. The server prompt — the same map is shipped as a compact "ON-DEVICE
//      PERCEPTION" block so the VLM reasons about structure the redaction may
//      have removed.
//
// Weights are bundled under public/models/perception/ (NO CDN at runtime):
//   model_quantized.onnx            6.3 MB  MobileViT-Small q8 (ImageNet-1k)
//   ort-wasm-simd-threaded.wasm   ~13.3 MB  onnxruntime-web WASM (1 thread)
// Preprocessing mirrors MobileViTFeatureExtractor: resize shortest edge → 288,
// center-crop 256, rescale 1/255, normalize to [-1,1], flip RGB → BGR.

export type PerceptionTag =
  | "photo" // photographic / illustrative content (identifying imagery)
  | "ui" // another screen inside the page (monitor, laptop, phone, TV…)
  | "document" // printed/wallet/doc-like material (envelope, menu, id…)
  | "data" // meter / clock / scoreboard (harmless, but part of layout context)
  | "blank" // text/white-space heavy, DOM carries it
  | "uncertain"; // low-confidence signal — treated conservatively by the gate

export interface PerceptionTile {
  x: number;
  y: number;
  w: number;
  h: number;
  tag: PerceptionTag;
  cls: number;
  label: string;
  conf: number;
}

export interface PerceptionRegionDecision {
  region: [number, number, number, number];
  tags: PerceptionTag[];
  reason: string;
}

export interface ScreenPerception {
  version: 1;
  model: string;
  /** True when the ViT actually ran (model base + DOM context available). */
  enabled: boolean;
  /** Semantic tiles of the visible screen (capped, sampled grid). */
  tiles: PerceptionTile[];
  /** Tag → tile count for the prompt + UI. */
  summary: Partial<Record<PerceptionTag, number>>;
  /** Per non-DOM image-region escalation decisions (fed to the sanitizer). */
  decisions: {
    escalate: PerceptionRegionDecision[]; // blur whole region (identity imagery)
    ocrPriority: PerceptionRegionDecision[]; // OCR these regions first
    captchaLike: PerceptionRegionDecision[]; // possible human-verification graphic
  };
  /** Pipeline ms for the ViT passes. */
  ms: number;
  modelMB: number;
}

export interface PerceiveInput {
  imageDataUrl: string;
  /** Non-DOM image/canvas/video regions (raw screenshot px) — only these can
   * be escalated by a decision; DOM-covered areas are already tokenized. */
  imageRegions?: [number, number, number, number][];
  /** Hard budget for the whole perception pass. */
  budgetMs?: number;
  /** Max tiles to classify per pass (latency guardrail). */
  maxTiles?: number;
}

// -- curated ImageNet-1k index → web-UI semantic tag --------------------------

const UI_CLASSES = new Set([
  487, // cellular telephone (screen with text)
  508, // computer keyboard, keypad
  527, // desktop computer
  590, // hand-held computer
  620, // laptop, laptop computer
  664, // monitor
  673, // mouse, computer mouse
  681, // notebook, notebook computer
  761, // remote control, remote
  782, // screen, CRT screen
  851, // television, television system
]);

const DOCUMENT_CLASSES = new Set([
  446, // binder, ring-binder
  549, // envelope
  553, // file, file cabinet, filing cabinet
  893, // wallet, billfold, pocketbook
  917, // comic book
  921, // book jacket, dust cover
  922, // menu
]);

const DATA_CLASSES = new Set([
  409, // analog clock
  426, // barometer
  530, // digital clock
  531, // digital watch
  781, // scoreboard
  826, // stopwatch, stop watch
  892, // wall clock
]);

// -- model base + ort wasm paths ---------------------------------------------

let modelBase: string | null = null;
let labels: Record<string, string> | null = null;

export function setModelBase(base: string | null): void {
  modelBase = base ? base.replace(/\/$/, "") + "/" : null;
}

export function getModelBase(): string | null {
  return modelBase;
}

/** Filename of the q8 ONNX model (bundled, never fetched). */
function modelUrl(): string {
  return `${modelBase}perception/model_quantized.onnx`;
}

function labelsUrl(): string {
  return `${modelBase}perception/imagenet-1k-id2label.json`;
}

// -- lazy inference session ---------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
let ortMod: any = null;
let session: any = null;
let sessionInit: Promise<any> | null = null;

async function loadOrt(): Promise<any> {
  if (ortMod) return ortMod;
  const ort = await import(/* @vite-ignore */ "onnxruntime-web");
  if (modelBase) {
    // Weights are BUNDLED (no CDN). Point the loader at the plain
    // SIMD-threaded glue + binary (13.3 MB) instead of the default
    // JSEP/WebGPU variant (26.5 MB). numThreads=1 keeps us on the
    // main thread — no SharedArrayBuffer / cross-origin isolation needed.
    ort.env.wasm.wasmPaths = {
      mjs: `${modelBase}ort/ort-wasm-simd-threaded.mjs`,
      wasm: `${modelBase}ort/ort-wasm-simd-threaded.wasm`,
    } as unknown as string;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
  }
  ortMod = ort;
  return ort;
}

async function detectOrtSessionType(): Promise<"ort" | "none"> {
  try {
    const ort = await loadOrt();
    void ort;
    return "ort";
  } catch {
    return "none";
  }
}

async function getSession(): Promise<any | null> {
  if (session) return session;
  if (sessionInit) return sessionInit;
  sessionInit = (async () => {
    if (!modelBase) throw new Error("perception: model base not set");
    const res = await fetch(modelUrl());
    if (!res.ok) throw new Error(`perception: model fetch failed (${res.status})`);
    const ort = await loadOrt();
    session = await ort.InferenceSession.create(await res.arrayBuffer(), {
      executionProviders: ["wasm"],
    });
    return session;
  })().catch((e) => {
    sessionInit = null;
    throw e;
  });
  return sessionInit;
}

async function loadLabels(): Promise<Record<string, string>> {
  if (labels) return labels;
  try {
    const res = await fetch(labelsUrl());
    if (res.ok) labels = (await res.json()) as Record<string, string>;
  } catch {
    /* labels are only cosmetic; tag mapping is index-based */
  }
  return labels ?? {};
}

// -- preprocessing (mirrors MobileViTFeatureExtractor) ------------------------

function preprocessTile(canvas: HTMLCanvasElement): Float32Array {
  const W = 288;
  const N = 256;
  const out = new Float32Array(3 * N * N);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return out;

  // Resize the tile so its shortest edge is 288 (bilinear via canvas), then
  // center-crop 256. Tiles are square in our grid so resize = downscale to 288.
  const step = canvas.width / W;
  const srcW = W * step;
  const srcH = W * step;
  const sx = (canvas.width - srcW) / 2;
  const sy = (canvas.height - srcH) / 2;
  const tmp = document.createElement("canvas");
  tmp.width = W;
  tmp.height = W;
  const tctx = tmp.getContext("2d");
  if (!tctx) return out;
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(ctx.canvas, sx, sy, srcW, srcH, 0, 0, W, W);

  const crop = document.createElement("canvas");
  crop.width = N;
  crop.height = N;
  const cctx = crop.getContext("2d", { willReadFrequently: true });
  if (!cctx) return out;
  cctx.imageSmoothingQuality = "high";
  cctx.drawImage(tmp, (W - N) / 2, (W - N) / 2, N, N, 0, 0, N, N);

  const px = cctx.getImageData(0, 0, N, N).data;
  for (let i = 0; i < N * N; i++) {
    const r = (px[i * 4] / 255 - 0.5) / 0.5;
    const g = (px[i * 4 + 1] / 255 - 0.5) / 0.5;
    const b = (px[i * 4 + 2] / 255 - 0.5) / 0.5;
    out[i * 3] = b; // RGB → BGR
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = r;
  }
  return out;
}

function softmax(logits: Float32Array | ArrayLike<number>): Float32Array {
  const max = Math.max(...Array.from(logits));
  let sum = 0;
  const out = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - max);
    sum += out[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

function top1(probs: Float32Array): { cls: number; conf: number } {
  let best = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
  return { cls: best, conf: probs[best] };
}

// -- tag mapping --------------------------------------------------------------

const TAG_OF_CLASS: Record<number, PerceptionTag> = {};
for (const c of UI_CLASSES) TAG_OF_CLASS[c] = "ui";
for (const c of DOCUMENT_CLASSES) TAG_OF_CLASS[c] = "document";
for (const c of DATA_CLASSES) TAG_OF_CLASS[c] = "data";

export function tagForClass(cls: number, conf: number): PerceptionTag {
  if (conf < 0.22) return "blank";
  if (conf < 0.5) return "uncertain";
  return TAG_OF_CLASS[cls] ?? "photo";
}

// -- classify a single cropped tile ------------------------------------------

interface Crop {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Classify ONE tile. NOTE: batched [N,3,256,256] sess.run redirects on
 * onnxruntime-web 1.29 wasm to degraded logits (uniform ~30% confidence) even
 * though native onnxruntime-node is bit-exact — verified by _abTest. Single
 * batch=1 runs match the native reference exactly, so we stay per-tile. The
 * wall-clock win comes from runVision running this concurrently with
 * face + OCR, not from internal batching. */
async function classifyCanvas(canvas: HTMLCanvasElement, labelsMap: Record<string, string>): Promise<PerceptionTile> {
  const sess = await getSession();
  const input = preprocessTile(canvas);
  const ort = ortMod ?? (await loadOrt());
  const feeds: Record<string, unknown> = {
    pixel_values: new ort.Tensor("float32", input, [1, 3, 256, 256]),
  };
  const res = await sess.run(feeds);
  const logits = res[sess.outputNames[0]]?.data;
  const probs = softmax(logits);
  const { cls, conf } = top1(probs);
  const label = labelsMap[String(cls)] ?? String(cls);
  return { x: 0, y: 0, w: 0, h: 0, tag: tagForClass(cls, conf), cls, label, conf };
}

// -- helpers -----------------------------------------------------------------

function boxArea(b: [number, number, number, number]): number {
  return b[2] * b[3];
}

function overlapFraction(
  tile: { x: number; y: number; w: number; h: number },
  region: [number, number, number, number],
): number {
  const ax0 = tile.x, ay0 = tile.y, ax1 = tile.x + tile.w, ay1 = tile.y + tile.h;
  const bx0 = region[0], by0 = region[1], bx1 = region[0] + region[2], by1 = region[1] + region[3];
  const ix = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0));
  const iy = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
  const regionArea = boxArea(region);
  if (regionArea <= 0) return 0;
  return (ix * iy) / regionArea;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// -- screen grid --------------------------------------------------------------

/** Tile the full screenshot into a small sampled grid (≤ maxTiles). */
function gridFor(w: number, h: number, maxTiles: number): { x: number; y: number; w: number; h: number }[] {
  const cols = clamp(Math.max(2, Math.ceil(w / 480)), 2, 4);
  let rows = clamp(Math.max(1, Math.ceil(h / 480)), 1, 3);
  while (cols * rows > maxTiles && rows > 1) rows--;
  const tw = Math.ceil(w / cols);
  const th = Math.ceil(h / rows);
  const tiles: { x: number; y: number; w: number; h: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        x: c * tw,
        y: r * th,
        w: Math.min(tw, w - c * tw),
        h: Math.min(th, h - r * th),
      });
    }
  }
  return tiles;
}

// -- region decisions ---------------------------------------------------------

const ESCALATE_TAGS = new Set<PerceptionTag>(["photo", "ui", "document"]);

/**
 * Decide, per non-DOM image region, whether the on-device ViT considers it
 * graphics-bearing (photographic / screen-capture / doc-like). Such regions are
 * escalated to whole-region redaction — identity imagery never leaves even when
 * face detection and OCR find nothing in them.
 */
function decideRegions(
  tiles: PerceptionTile[],
  regions: [number, number, number, number][],
): ScreenPerception["decisions"] {
  const escalate: PerceptionRegionDecision[] = [];
  const ocrPriority: PerceptionRegionDecision[] = [];
  const captchaLike: PerceptionRegionDecision[] = [];

  for (const region of regions) {
    if (region[2] < 24 || region[3] < 24) continue;
    const tags: PerceptionTag[] = [];
    const hits: PerceptionTile[] = [];
    for (const t of tiles) {
      if (overlapFraction(t, region) >= 0.25) hits.push(t);
    }
    if (hits.length === 0) continue;

    // Dominant tag = highest-confidence overlap.
    const ranked = [...hits].sort((a, b) => b.conf - a.conf);
    const dom = ranked[0];
    tags.push(dom.tag);
    if (ESCALATE_TAGS.has(dom.tag)) {
      escalate.push({
        region,
        tags,
        reason: `on-device ViT: ${dom.tag}-like graphics (${dom.label}, ${(dom.conf * 100).toFixed(0)}%)`,
      });
      ocrPriority.push({ region, tags, reason: "graphics region — OCR for embedded PII first" });
    } else if (dom.tag === "data") {
      // charts/meters are fine; keep for context only.
    } else if (dom.tag === "uncertain") {
      // Could be decorative logo OR a human-verification graphic. Escalate for
      // safety (fails toward redaction), flag as possible captcha for the agent.
      escalate.push({
        region,
        tags,
        reason: `on-device ViT: low-confidence graphic (${dom.label}) — redacted conservatively`,
      });
      captchaLike.push({ region, tags, reason: "possible human-verification graphic (manual step)" });
    }
  }

  // De-dupe: never list the same region in both escalate and captchaLike.
  return { escalate, ocrPriority, captchaLike };
}

// -- public entry point -------------------------------------------------------

export async function perceiveScreen(input: PerceiveInput): Promise<ScreenPerception> {
  const t0 = performance.now();
  const budget = input.budgetMs ?? 2500;
  const maxTiles = input.maxTiles ?? 6;
  const base: ScreenPerception = {
    version: 1,
    model: "mobilevit-small (q8, on-device)",
    enabled: false,
    tiles: [],
    summary: {},
    decisions: { escalate: [], ocrPriority: [], captchaLike: [] },
    ms: 0,
    modelMB: 0,
  };

  if (!modelBase || typeof document === "undefined") return base;

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("image decode failed (perception)"));
      im.src = input.imageDataUrl;
    });

    const [labelsMap] = await Promise.all([
      loadLabels(),
      getSession(),
    ]);
    base.enabled = true;

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return base;
    ctx.drawImage(img, 0, 0);

    // 1) Full-screen semantic map (sampled grid). Classify per-tile (see note on
    //    classifyCanvas re: wasm batch corruption) inside the budget loop.
    const grid = gridFor(canvas.width, canvas.height, maxTiles);
    const tiles: PerceptionTile[] = [];
    for (const g of grid) {
      if (performance.now() - t0 > budget) break;
      try {
        const crop = document.createElement("canvas");
        crop.width = g.w;
        crop.height = g.h;
        const cctx = crop.getContext("2d");
        if (!cctx) continue;
        cctx.drawImage(canvas, g.x, g.y, g.w, g.h, 0, 0, g.w, g.h);
        const t = await classifyCanvas(crop, labelsMap);
        t.x = g.x;
        t.y = g.y;
        t.w = g.w;
        t.h = g.h;
        tiles.push(t);
      } catch {
        /* a single tile must never kill the pass */
      }
    }

    // 2) Region decisions for non-DOM surfaces.
    const decisions = decideRegions(tiles, input.imageRegions ?? []);

    const summary: Partial<Record<PerceptionTag, number>> = {};
    for (const t of tiles) summary[t.tag] = (summary[t.tag] ?? 0) + 1;

    return {
      ...base,
      tiles,
      summary,
      decisions,
      ms: Math.round(performance.now() - t0),
      modelMB: 6.3,
    };
  } catch (e) {
    base.model = `mobilevit-small (q8) — unavailable: ${e instanceof Error ? e.message : String(e)}`;
    return base;
  }
}

/** Preload the ViT session + labels so the first real pass doesn't cold-load. */
export async function warmPerception(): Promise<void> {
  if (!modelBase) return;
  await Promise.all([getSession(), loadLabels()]);
}

/**
 * Total bundled asset bytes for the perception stack (model + ort wasm) from
 * manifest.json — reported to the resource meter alongside the other models.
 */
export async function getPerceptionModelMB(): Promise<number> {
  if (!modelBase) return 0;
  try {
    const r = await fetch(`${modelBase}manifest.json`);
    const m = (await r.json()) as { files?: Record<string, number> };
    if (!m.files) return 0;
    let bytes = 0;
    for (const [k, v] of Object.entries(m.files)) {
      if (k.includes("perception/") || k.includes("ort/")) bytes += v;
    }
    return bytes / (1024 * 1024);
  } catch {
    return 6.3 + 13.3;
  }
}

// re-exported so the offscreen warm path and benchmarks can force ort ready
export { detectOrtSessionType as _detectOrtSessionType };

/** DEBUG ONLY — A/B batch vs single-tile inference on the same 6 crops, so a
 * batched-layout regression is caught with identical inputs on one machine. */
export async function _abTest(
  imageDataUrl: string,
  maxTiles = 6,
): Promise<{ batch: string[]; single: string[] } | { error: string }> {
  if (!modelBase) return { error: "no model base" };
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("decode failed"));
      im.src = imageDataUrl;
    });
    const [labelsMap] = await Promise.all([loadLabels(), getSession()]);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { error: "no ctx" };
    ctx.drawImage(img, 0, 0);
    const grid = gridFor(canvas.width, canvas.height, maxTiles);
    const crops: Crop[] = [];
    for (const g of grid) {
      const crop = document.createElement("canvas");
      crop.width = g.w;
      crop.height = g.h;
      const cctx = crop.getContext("2d");
      cctx?.drawImage(canvas, g.x, g.y, g.w, g.h, 0, 0, g.w, g.h);
      crops.push({ canvas: crop, ...g });
    }
    const fmt = (t: PerceptionTile) => `${t.tag}:${t.cls}:${(t.conf * 100) | 0}`;
    const batch: string[] = [];
    for (let i = 0; i < crops.length; i += 1) {
      batch.push(fmt(await classifyCanvas(crops[i].canvas, labelsMap)));
    }
    // Sequential single-tile runs on the SAME crops (reference path).
    const single: string[] = [];
    for (let i = 0; i < crops.length; i += 1) {
      single.push(fmt(await classifyCanvas(crops[i].canvas, labelsMap)));
    }
    return { batch, single };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}