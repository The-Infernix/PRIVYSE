// Phase 2 — on-device visual PII detection (build plan §2).
//
// Env-agnostic module: runs in any DOM context where WASM is allowed —
// the Chrome offscreen document (extension path) or a regular page
// (benchmark path). Weights are bundled under public/models/ and NEVER
// fetched from a CDN (manifest.json lists byte sizes for the resource meter).
//
//   Face  — MediaPipe BlazeFace short-range (tflite, ~0.2 MB), CPU delegate.
//   OCR   — Tesseract.js (WASM, eng fast) restricted to image/canvas/video
//           regions so DOM text is never re-OCR'd; hard budget with skip.
//
// All boxes are in RAW screenshot pixel space (the caller scales them like
// every other redaction box).

import { detectPii } from "./pii-rules";
import {
  perceiveScreen,
  warmPerception,
  setModelBase as setPerceptionModelBase,
  type ScreenPerception,
} from "./perception";

export type Box = [number, number, number, number];

export interface OcrHit {
  type: string;
  value: string;
  bbox: Box;
  /** The image/canvas region the hit came from (Phase 2 taint policy: the
   * sanitizer redacts the WHOLE region once it contains PII). */
  region?: Box;
}

export interface VisionStats {
  faceMs: number;
  ocrMs: number;
  zeroLeakOcrMs?: number;
  modelsMB: number;
  facesFound: number;
  ocrRegions: number;
  ocrHits: number;
  skipped: string[];
}

export interface VisionResult {
  faces: Box[];
  ocr: OcrHit[];
  stats: VisionStats;
  /** On-device MobileViT screen perception (PS §1: local ViT reads the screen). */
  perception?: ScreenPerception;
}

export interface ZeroLeakHit {
  type: string;
  value: string;
  bbox: Box;
}

export interface VisionInput {
  imageDataUrl: string;
  imageRegions?: Box[];
  /** Same-page perception cache key prefix (see perception.ts). OPT-IN. */
  pageUrl?: string;
}

// -- model base resolution ---------------------------------------------------

let modelBase: string | null = null;

export function setModelBase(url: string): void {
  modelBase = url.replace(/\/$/, "") + "/";
  setPerceptionModelBase(modelBase);
}

export function getModelBase(): string | null {
  return modelBase;
}

// -- lazy model singletons ---------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
let faceDetector: any = null;
let faceInit: Promise<any> | null = null;
let tessWorker: any = null;
let tessInit: Promise<any> | null = null;
let modelsMB: number | null = null;

async function loadMediapipe(): Promise<any> {
  if (!modelBase) throw new Error("vision: model base not set");
  // Native dynamic import of a runtime URL — bundlers must leave it alone
  // (esbuild/Vite keep non-literal specifiers as-is).
  const url = modelBase + "vision_bundle.mjs";
  return await import(/* @vite-ignore */ url);
}

async function getFaceDetector(): Promise<any> {
  if (faceDetector) return faceDetector;
  if (!faceInit) {
    faceInit = (async () => {
      const mp = await loadMediapipe();
      const fileset = await mp.FilesetResolver.forVisionTasks(modelBase! + "mp/");
      faceDetector = await mp.FaceDetector.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: modelBase! + "face/detector_short.tflite",
          delegate: "CPU",
        },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.4,
      });
      return faceDetector;
    })().catch((e) => {
      faceInit = null;
      throw e;
    });
  }
  return faceInit;
}

async function getTesseract(): Promise<any> {
  if (tessWorker) return tessWorker;
  if (!tessInit) {
    tessInit = (async () => {
      const w = window as unknown as { Tesseract?: any };
      if (!w.Tesseract) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement("script");
          s.src = modelBase! + "tesseract/tesseract.min.js";
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("tesseract.min.js failed to load"));
          document.head.appendChild(s);
        });
      }
      if (!w.Tesseract) throw new Error("Tesseract global missing after load");
      const worker = await w.Tesseract.createWorker("eng", 1, {
        workerPath: modelBase! + "tesseract/worker.min.js",
        corePath: modelBase! + "tesseract-core",
        langPath: modelBase! + "tesseract-lang",
        cacheMethod: "none",
      });
      tessWorker = worker;
      return worker;
    })().catch((e) => {
      tessInit = null;
      throw e;
    });
  }
  return tessInit;
}

/** Sum of bundled asset bytes from manifest.json (resource-meter number). */
export async function getModelsMB(): Promise<number> {
  if (modelsMB != null) return modelsMB;
  try {
    const r = await fetch(modelBase! + "manifest.json");
    const m = (await r.json()) as { totalBytes?: number };
    modelsMB = (m.totalBytes ?? 0) / (1024 * 1024);
  } catch {
    modelsMB = 0;
  }
  return modelsMB;
}

/** Explicitly initialize ALL model stacks (face + OCR + ViT perception) so a
 * later runVision call doesn't pay the cold load. Runs the three stacks in
 * PARALLEL — the warm completes in max(face, OCR, perception), not their sum,
 * so a host that needs 60-90s to cold-load recovers mid-run instead of only
 * after the first session. Perception is best-effort: a failure there never
 * blocks faces/OCR from becoming ready. */
export async function warmVision(): Promise<void> {
  await Promise.all([
    getFaceDetector(),
    getTesseract(),
    warmPerception().catch(() => {
      /* perception is best-effort; faces/OCR are the privacy-critical cores */
    }),
  ]);
}

export async function terminateVision(): Promise<void> {
  try {
    await tessWorker?.terminate?.();
  } catch {
    /* ignore */
  }
  try {
    faceDetector?.close?.();
  } catch {
    /* ignore */
  }
  tessWorker = null;
  tessInit = null;
  faceDetector = null;
  faceInit = null;
}

// -- helpers -----------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataUrl;
  });
  return img;
}

interface OcrBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface OcrWord {
  text: string;
  bbox: OcrBbox;
}
interface OcrLine {
  text?: string;
  words?: OcrWord[];
  bbox?: OcrBbox;
}

/** Normalize v5 (data.lines) and v6+ ({blocks:true} output) shapes. */
function walkLines(data: any): OcrLine[] {
  const lines: OcrLine[] = [];
  if (Array.isArray(data?.blocks)) {
    for (const b of data.blocks) {
      for (const p of b?.paragraphs ?? []) {
        for (const l of p?.lines ?? []) lines.push(l);
      }
    }
  } else if (Array.isArray(data?.lines)) {
    lines.push(...data.lines);
  }
  return lines.filter((l) => Array.isArray(l?.words) && l.words.length > 0);
}

/** Union bbox of the words whose text occurs in the matched value. */
function unionOfMatch(line: OcrLine, value: string): OcrBbox | null {
  const toks = value.split(/\s+/).filter(Boolean);
  const words = (line.words ?? []).filter((w) => {
    const t = w.text.replace(/^[^\w]+|[^\w]+$/g, "");
    return t && toks.some((tok) => tok.includes(t) || t.includes(tok));
  });
  if (words.length === 0) return line.bbox ?? null;
  return {
    x0: Math.min(...words.map((w) => w.bbox.x0)),
    y0: Math.min(...words.map((w) => w.bbox.y0)),
    x1: Math.max(...words.map((w) => w.bbox.x1)),
    y1: Math.max(...words.map((w) => w.bbox.y1)),
  };
}

function boxRound(b: OcrBbox): Box {
  return [
    Math.round(b.x0),
    Math.round(b.y0),
    Math.round(b.x1 - b.x0),
    Math.round(b.y1 - b.y0),
  ];
}

function dedupeByBox(hits: OcrHit[]): OcrHit[] {
  const out: OcrHit[] = [];
  for (const h of hits) {
    const dup = out.some(
      (o) =>
        o.type === h.type &&
        Math.abs(o.bbox[0] - h.bbox[0]) <= 2 &&
        Math.abs(o.bbox[1] - h.bbox[1]) <= 2,
    );
    if (!dup) out.push(h);
  }
  return out;
}

/** PII hits from OCR'd words+lines; bboxes mapped back to source px. */
function piiFromLines(lines: OcrLine[], toSource: (b: OcrBbox) => OcrBbox): OcrHit[] {
  const hits: OcrHit[] = [];
  for (const line of lines) {
    // word-level: catches single-token PII (PAN, EB-CA989766, email)
    for (const w of line.words ?? []) {
      for (const m of detectPii(w.text, { ocr: true })) {
        hits.push({ type: m.type, value: m.value, bbox: boxRound(toSource(w.bbox)) });
      }
    }
    // line-level: catches PII split across words ("+91 99887 76655")
    const lineText = (line.text ?? (line.words ?? []).map((w) => w.text).join(" ")) || "";
    for (const m of detectPii(lineText, { ocr: true })) {
      const u = unionOfMatch(line, m.value);
      if (u) hits.push({ type: m.type, value: m.value, bbox: boxRound(toSource(u)) });
    }
  }
  return dedupeByBox(hits);
}

// -- face detection ----------------------------------------------------------

async function getDetectorOn(
  source: CanvasImageSource,
  w: number,
  h: number,
): Promise<{ boxes: Box[]; scale: number }> {
  const det = await getFaceDetector();
  // Upscale small crops — BlazeFace short-range needs the face reasonably
  // large in frame; a 96px avatar in a full-page screenshot won't register.
  const scale = Math.max(1, 256 / Math.min(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const cx = c.getContext("2d");
  if (!cx) return { boxes: [], scale };
  cx.imageSmoothingEnabled = true;
  cx.drawImage(source, 0, 0, c.width, c.height);
  const out = det.detect(c);
  const pad = 0.15;
  const boxes: Box[] = [];
  for (const d of out?.detections ?? []) {
    const b = d?.boundingBox;
    if (!b) continue;
    // back to source px (pad applied in source space)
    const x = b.originX / scale;
    const y = b.originY / scale;
    const bw = b.width / scale;
    const bh = b.height / scale;
    boxes.push([
      Math.max(0, Math.round(x - bw * pad)),
      Math.max(0, Math.round(y - bh * pad)),
      Math.round(bw * (1 + 2 * pad)),
      Math.round(bh * (1 + 2 * pad)),
    ]);
  }
  return { boxes, scale };
}

/**
 * Detect faces per image region (crop → upscale → detect → map back), which
 * finds small faces a full-screenshot pass misses. Falls back to whole-image
 * detection when no regions are given.
 */
export async function detectFaces(
  imageDataUrl: string,
  regions?: Box[],
): Promise<{ faces: Box[]; ms: number }> {
  const t0 = performance.now();
  const det = await getFaceDetector();
  void det;
  const img = await loadImage(imageDataUrl);
  const imgW = img.naturalWidth;
  const imgH = img.naturalHeight;
  const faces: Box[] = [];

  if (regions && regions.length > 0) {
    for (const [rx, ry, rw, rh] of regions) {
      if (rw < 24 || rh < 24) continue;
      // clamp region to the image
      const cx0 = Math.max(0, Math.min(rx, imgW));
      const cy0 = Math.max(0, Math.min(ry, imgH));
      const cw = Math.max(0, Math.min(rw, imgW - cx0));
      const ch = Math.max(0, Math.min(rh, imgH - cy0));
      if (cw < 24 || ch < 24) continue;
      const c = document.createElement("canvas");
      c.width = cw;
      c.height = ch;
      const cx = c.getContext("2d");
      if (!cx) continue;
      cx.drawImage(img, cx0, cy0, cw, ch, 0, 0, cw, ch);
      const { boxes } = await getDetectorOn(c, cw, ch);
      for (const [fx, fy, fw, fh] of boxes) {
        faces.push([
          Math.min(imgW, cx0 + fx),
          Math.min(imgH, cy0 + fy),
          Math.min(imgW - (cx0 + fx), fw),
          Math.min(imgH - (cy0 + fy), fh),
        ]);
      }
    }
  } else {
    const { boxes } = await getDetectorOn(img, imgW, imgH);
    faces.push(...boxes);
  }
  return { faces, ms: performance.now() - t0 };
}

// -- region OCR --------------------------------------------------------------

export async function ocrRegionsPii(
  imageDataUrl: string,
  regions: Box[],
  budgetMs = 2500,
): Promise<{ hits: OcrHit[]; ms: number; skipped: string[] }> {
  const t0 = performance.now();
  const skipped: string[] = [];
  const hits: OcrHit[] = [];
  const worker = await getTesseract();
  const img = await loadImage(imageDataUrl);

  // Largest regions first so the budget skips decorative leftovers.
  const sorted = [...regions].sort((a, b) => b[2] * b[3] - a[2] * a[3]).slice(0, 24);
  for (const region of sorted) {
    const [rx, ry, rw, rh] = region;
    if (performance.now() - t0 > budgetMs) {
      skipped.push("ocr-budget");
      break;
    }
    if (rw < 8 || rh < 8) continue;
    const scale = 2; // upscale small regions for recognition accuracy
    const c = document.createElement("canvas");
    c.width = Math.round(rw * scale);
    c.height = Math.round(rh * scale);
    const cx = c.getContext("2d");
    if (!cx) continue;
    cx.imageSmoothingEnabled = true;
    cx.drawImage(img, rx, ry, rw, rh, 0, 0, c.width, c.height);
    try {
      const { data } = await worker.recognize(c, {}, { blocks: true, text: true });
      const toSource = (b: OcrBbox): OcrBbox => ({
        x0: rx + b.x0 / scale,
        y0: ry + b.y0 / scale,
        x1: rx + b.x1 / scale,
        y1: ry + b.y1 / scale,
      });
      for (const h of piiFromLines(walkLines(data), toSource)) {
        hits.push({ ...h, region });
      }
    } catch {
      skipped.push("region-failed");
    }
  }
  return { hits, ms: performance.now() - t0, skipped };
}

// -- zero-leak OCR (sanitized image gate) -------------------------------------

export async function ocrFindPii(
  imageDataUrl: string,
): Promise<{ hits: ZeroLeakHit[]; ms: number }> {
  const t0 = performance.now();
  const worker = await getTesseract();
  const img = await loadImage(imageDataUrl);
  const scale = Math.min(1, 1600 / (img.naturalWidth || 1));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const cx = c.getContext("2d");
  if (!cx) return { hits: [], ms: performance.now() - t0 };
  cx.drawImage(img, 0, 0, c.width, c.height);
  const { data } = await worker.recognize(c, {}, { blocks: true, text: true });
  const toSource = (b: OcrBbox): OcrBbox => ({
    x0: b.x0 / scale,
    y0: b.y0 / scale,
    x1: b.x1 / scale,
    y1: b.y1 / scale,
  });
  const hits = piiFromLines(walkLines(data), toSource).map((h) => ({
    type: h.type,
    value: h.value,
    bbox: h.bbox,
  }));
  return { hits, ms: performance.now() - t0 };
}

/** The region containing the box's center, if any. */
function containingRegion(box: Box, regions: Box[]): Box | null {
  const cx = box[0] + box[2] / 2;
  const cy = box[1] + box[3] / 2;
  for (const r of regions) {
    if (cx >= r[0] && cx <= r[0] + r[2] && cy >= r[1] && cy <= r[1] + r[3]) {
      return r;
    }
  }
  return null;
}

// -- provider entry point ----------------------------------------------------

export async function runVision(input: VisionInput): Promise<VisionResult | null> {
  if (!modelBase || typeof document === "undefined") return null;
  const stats: VisionStats = {
    faceMs: 0,
    ocrMs: 0,
    modelsMB: 0,
    facesFound: 0,
    ocrRegions: 0,
    ocrHits: 0,
    skipped: [],
  };
  const out: VisionResult = { faces: [], ocr: [], stats, perception: undefined };

  // The three on-device passes are INDEPENDENT — run them concurrently so the
  // wall-clock vision cost is max(face, OCR, perception), not their sum. Every
  // pass is individually bounded (own timeout) AND best-effort: a failure of
  // any one must never starve or block the others (see the fail-closed audit).
  const statsMB = getModelsMB().catch(() => 0);
  const regions = input.imageRegions ?? [];
  const pass = {
    perception: (async () => {
      try {
        const p = await withTimeout(
          perceiveScreen({
            imageDataUrl: input.imageDataUrl,
            imageRegions: input.imageRegions,
            budgetMs: 2500,
            maxTiles: 6,
            pageUrl: input.pageUrl,
          }),
          7000,
          "perception-timeout",
        );
            out.perception = p;
        if (p.enabled) {
          const verb = p.cached ? "cached-map" : "ok";
          stats.skipped.push(
            `perception: ${verb} (${p.ms}ms, ${Object.entries(p.summary)
              .map(([t, n]) => `${t}=${n}`)
              .join(" ")})`,
          );
        }
      } catch (e) {
        stats.skipped.push("perception:" + errMsg(e));
      }
    })(),
    faces: (async () => {
      try {
        const f = await withTimeout(
          detectFaces(input.imageDataUrl, input.imageRegions),
          10000,
          "face-timeout",
        );
        out.faces = f.faces;
        stats.faceMs = f.ms;
        stats.facesFound = f.faces.length;
        // Same taint policy as OCR: a non-DOM region holding a face is redacted
        // whole (the padded face box remains only for faces outside any region).
        if (input.imageRegions?.length) {
          out.faces = out.faces.map(
            (f2) => containingRegion(f2, input.imageRegions!) ?? f2,
          );
        }
      } catch (e) {
        stats.skipped.push("face:" + errMsg(e));
      }
    })(),
    ocr:
      regions.length > 0
        ? (async () => {
            stats.ocrRegions = regions.length;
            try {
              const o = await withTimeout(
                ocrRegionsPii(input.imageDataUrl, regions),
                12000,
                "ocr-timeout",
              );
              out.ocr = o.hits;
              stats.ocrMs = o.ms;
              stats.ocrHits = o.hits.length;
              stats.skipped.push(...o.skipped);
            } catch (e) {
              stats.skipped.push("ocr:" + errMsg(e));
            }
          })()
        : Promise.resolve(),
  };

  await Promise.all([statsMB, pass.perception, pass.faces, pass.ocr]);
  try {
    stats.modelsMB = await statsMB;
  } catch {
    stats.modelsMB = 0;
  }

  return out;
}
