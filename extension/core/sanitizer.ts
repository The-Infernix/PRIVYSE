// Sanitizer v2 — the privacy gate. This module is the ONLY code allowed to
// build an outbound /act body. Everything the server sees passes through here.
//
// Redaction strategy (see build plan §1b):
//   Tier A — password/hidden/secret fields: solid black box, no text.
//   Tier B — PII (email/phone/aadhaar/pan/card/name/address): black box +
//            a drawn placeholder token like [EMAIL_1]. Same raw value ⇒ same
//            token, so the VLM keeps continuity across steps.
//   Tier C — faces: Gaussian blur via stacked downscale/upscale (Phase 2,
//            MediaPipe on-device). OCR hits inside image/canvas regions are
//            redacted like Tier B but without drawn tokens (non-DOM source).
//
// The sanitized screenshot is drawn onto an OffscreenCanvas and re-encoded to
// JPEG so it works from a service worker (no DOM).

import {
  detectPii,
  sensitiveFieldName,
  type PiiMatch,
} from "./pii-rules";
import { drawSoMOverlay } from "./som-overlay";
import type { ScreenPerception } from "./perception";
import type { DomElement, HistoryStep, ServerActRequest } from "./protocol";

/** Max screenshot width in px before downscaling (keeps vision tokens low). */
const MAX_IMG_W = 1280;

/** Maps raw PII value → stable token (e.g. "alice@x.com" → "[EMAIL_1]"). */
const tokenMap = new Map<string, string>();
/** Per-type counter to keep tokens readable. */
const typeCount = new Map<string, number>();

export interface RedactionLogEntry {
  type: string;
  tier: "A" | "B" | "C";
  token?: string;
  bbox: [number, number, number, number];
  source: "dom" | "text" | "vision" | "perception";
  /** Partially-masked display of the raw value (ON-DEVICE only, for the
   * stable-token card). e.g. "jes***@gmail.com". Absent for face blurs. */
  masked?: string;
}

/** On-device vision output (Phase 2), produced by core/vision.ts. */
export interface VisionFindings {
  faces: [number, number, number, number][];
  ocr: {
    type: string;
    value: string;
    bbox: [number, number, number, number];
    region?: [number, number, number, number];
  }[];
  /** On-device MobileViT screen perception (Phase 4: "local ViT reads the
   * screen"). Drives region escalation + is shipped to the server as a compact
   * semantic map so the VLM reasons from locally-observed structure. */
  perception?: ScreenPerception;
  stats?: Record<string, unknown>;
}

export interface SanitizedPayload extends ServerActRequest {
  redactions: RedactionLogEntry[];
  /** Per-stage vision timings/counters when on-device models ran. */
  visionStats?: Record<string, unknown>;
}

function tokenFor(type: string, value: string): string {
  const existing = tokenMap.get(value);
  if (existing) return existing;
  const n = (typeCount.get(type) ?? 0) + 1;
  typeCount.set(type, n);
  const token = `[${type.toUpperCase()}_${n}]`;
  tokenMap.set(value, token);
  return token;
}

/** Partially-masked display of a raw PII value — enough to be meaningful on
 * the panel's stable-token card, never the raw value itself. */
function maskPiiValue(value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (v.includes("@")) {
    const i = v.indexOf("@");
    const local = v.slice(0, i);
    const host = v.slice(i);
    const ml =
      local.length <= 2
        ? (local[0] ?? "").padEnd(3, "*")
        : `${local.slice(0, 3)}***`;
    return ml + host;
  }
  const digitAt: number[] = [];
  for (let k = 0; k < v.length; k++) if (/[0-9]/.test(v[k])) digitAt.push(k);
  if (digitAt.length >= 4) {
    const keep = new Set(digitAt.slice(-4));
    let out = "";
    for (let k = 0; k < v.length; k++) {
      out += keep.has(k) ? v[k] : /[0-9]/.test(v[k]) ? "X" : v[k];
    }
    return out;
  }
  return `${v.slice(0, 2)}…`;
}

/** Replace PII within a text string with stable tokens. */
export function tokenizeText(text: string): {
  text: string;
  redactions: { type: string; token: string; value: string; start: number; end: number }[];
} {
  const matches = detectPii(text);
  if (matches.length === 0) return { text, redactions: [] };

  const redactions: { type: string; token: string; value: string; start: number; end: number }[] = [];
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start);
    const token = tokenFor(m.type, m.value);
    out += token;
    redactions.push({ type: m.type, token, value: m.value, start: m.start, end: m.end });
    cursor = m.end;
  }
  out += text.slice(cursor);
  return { text: out, redactions };
}

function drawTokenText(
  ctx: CanvasRenderingContext2D,
  token: string,
  bbox: [number, number, number, number],
) {
  const [x, y, w, h] = bbox;
  ctx.save();
  ctx.fillStyle = "#000000";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = `bold ${Math.max(11, Math.min(14, h * 0.5))}px monospace`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(token, x + w / 2, y + h / 2);
  ctx.restore();
}

function drawBlackBox(
  ctx: CanvasRenderingContext2D,
  bbox: [number, number, number, number],
) {
  const [x, y, w, h] = bbox;
  ctx.save();
  ctx.fillStyle = "#000000";
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/** Gaussian-ish blur: crush the region through a tiny buffer, then smooth
 * back up. Iterated so identity features (FaceNet-matchable edges) are gone,
 * not merely softened — mirrors the zero-leak OCR check that must fail to
 * read anything back out of a blurred face region. */
function blurRegion(
  ctx: CanvasRenderingContext2D,
  bbox: [number, number, number, number],
) {
  const [x, y, w, h] = bbox;
  if (w <= 0 || h <= 0) return;
  ctx.save();
  const down = 24;
  const smallW = Math.max(1, Math.round(w / down));
  const smallH = Math.max(1, Math.round(h / down));
  const tmp = new OffscreenCanvas(smallW, smallH);
  const tctx = tmp.getContext("2d") as CanvasRenderingContext2D | null;
  if (tctx) {
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, smallW, smallH);
    ctx.imageSmoothingEnabled = true;
    for (let i = 0; i < 2; i++) {
      ctx.drawImage(tmp, 0, 0, smallW, smallH, x, y, w, h);
    }
  } else {
    ctx.fillStyle = "#000000";
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
}

/**
 * Sweep the whole visible document (not just interactive elements) for PII in
 * text nodes. Returns redactions so the screenshot can be masked; also rewrites
 * the live text nodes with tokens so the DOM snapshot the VLM receives carries
 * no raw secrets in prose / tables / labels.
 *
 * Must run in a DOM context (not a service worker) — hence it is invoked from
 * sanitizeForUpload only when `document` is available, and guarded by try/catch
 * so the pass degrades gracefully to DOM-only tokenization elsewhere.
 */
export function sweepDocumentPii(
  collect: (r: RedactionLogEntry) => void,
): void {
  if (typeof document === "undefined") return;

  let node: Text | null;
  const dpr = window.devicePixelRatio || 1;
  const scaled = (rect: { left: number; top: number; width: number; height: number }) =>
    [
      Math.round(rect.left * dpr),
      Math.round(rect.top * dpr),
      Math.round(rect.width * dpr),
      Math.round(rect.height * dpr),
    ] as [number, number, number, number];
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

  // Two passes: first deteact + measure EVERY match while layout is stable
  // (rewriting any node mid-walk reflows the page and shifts later boxes);
  // then rewrite all matched text nodes to tokens.
  const toRewrite: { node: Text; clean: string }[] = [];
  const walk2 = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const n = node as Text;
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = n.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.tagName === "SCRIPT" || parent.tagName === "STYLE") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  // -- Pass 1: measure ------------------------------------------------
  while ((node = walk2.nextNode() as Text | null)) {
    if (!node) break;
    const n3: Text = node;
    const text = n3.nodeValue || "";
    const { text: clean, redactions: r } = tokenizeText(text);
    if (r.length === 0) continue;
    if (clean === text) continue;
    toRewrite.push({ node: n3, clean });

    // Per-match bbox. Preferred: the parent element's box (matches how GT
    // boxes are authored); else a range over the matched span; else the whole
    // node; else the parent.
    const boxFor = (value: string, start: number, end: number) => {
      const parent = n3.parentElement;
      try {
        if (parent) {
          const pt = normalize(parent.textContent || "");
          const nv = normalize(value);
          if (pt && nv && Math.abs(pt.length - nv.length) <= 2 && pt.includes(nv)) {
            const rect = parent.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return scaled(rect);
          }
        }
        if (document.createRange) {
          const rng = document.createRange();
          rng.setStart(n3, start);
          rng.setEnd(n3, Math.min(end, n3.length));
          const rect = rng.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return scaled(rect);
        }
        if (document.createRange) {
          const rng2 = document.createRange();
          rng2.selectNodeContents(n3);
          const rect = rng2.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return scaled(rect);
        }
        if (parent) {
          const rect = parent.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return scaled(rect);
        }
      } catch {
        /* ignore bbox failure */
      }
      return null;
    };

    const seen = new Set<string>();
    for (const rr of r) {
      const key = `${rr.type}:${rr.token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bbox = boxFor(rr.value, rr.start, rr.end) ?? [0, 0, 0, 0];
      collect({
        type: rr.type,
        tier: "B",
        token: rr.token,
        bbox,
        source: "text",
        masked: maskPiiValue(rr.value),
      });
    }
  }

  // -- Address blocks --------------------------------------------------
  // HTML <address> = contact information: treat the whole element as PII and
  // mask its full box (no regex NER needed; the element itself is the signal).
  const addressList: { el: HTMLElement; token: string }[] = [];
  const addrs = Array.from(document.getElementsByTagName("address") as HTMLCollectionOf<HTMLElement>);
  for (const el of addrs) {
    const raw = (el.textContent || "").trim();
    if (!raw) continue;
    const token = tokenFor("address", raw);
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      collect({
        type: "address",
        tier: "B",
        token,
        bbox: scaled(rect),
        source: "text",
        masked: maskPiiValue(raw),
      });
    }
    addressList.push({ el, token });
  }

  // -- Pass 2: rewrite the live text nodes ----------------------------
  for (const { node: n2, clean } of toRewrite) {
    try {
      n2.nodeValue = clean;
    } catch {
      /* read-only node (e.g. xmp) — skip rewrite */
    }
  }
  for (const { el, token } of addressList) {
    try {
      if (el.textContent !== token) el.replaceChildren(document.createTextNode(token));
    } catch {
      /* ignore rewrite failure */
    }
  }
}

/**
 * Convert a Blob to a base64 data-URL without relying on FileReader, which is
 * NOT available in a Chrome MV3 service worker (where this sanitizer runs).
 * For non-integer byte counts / large buffers use raw base64 encoding.
 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || "image/jpeg"};base64,${btoa(bin)}`;
}

export async function sanitizeForUpload(
  screenshotDataUrl: string,
  dom: DomElement[],
  task = "",
  history: HistoryStep[] = [],
  proseRedactions: RedactionLogEntry[] = [],
  vision?: VisionFindings,
): Promise<SanitizedPayload> {
  // Reset per-upload state only in the background import context. We keep the
  // token map across an agent run for continuity; reset on a fresh task.
  const redactions: RedactionLogEntry[] = [...proseRedactions];

  // 0) Tier C — on-device vision findings (faces + OCR PII in image regions).
  //    Faces blur; OCR values also enter the token map so a value that later
  //    surfaces in the DOM gets the SAME token (cross-source continuity).
  const visionFaces = vision?.faces ?? [];
  const visionOcr = vision?.ocr ?? [];
  for (const f of visionFaces) {
    redactions.push({ type: "face", tier: "C", bbox: f, source: "vision" });
  }
  for (const h of visionOcr) {
    // Taint policy: a non-DOM region that contains PII is redacted whole —
    // OCR word boxes are too tight to trust, and the token can't be drawn
    // meaningfully over pixels the DOM can't re-render.
    redactions.push({
      type: h.type,
      tier: "B",
      token: tokenFor(h.type, h.value),
      bbox: h.region ?? h.bbox,
      source: "vision",
      masked: maskPiiValue(h.value),
    });
  }

  // 0b) PHASE 4 — perception-driven escalation (on-device ViT decisions).
  //     Non-DOM image regions the local MobileViT reads as photographic /
  //     screen-capture / doc-like (or low-confidence graphics) are blurred
  //     whole: identity imagery never leaves even when BlazeFace finds no face
  //     and OCR finds no plain text. Fails toward redaction, never toward leak.
  const perceptionEscalate = vision?.perception?.decisions.escalate ?? [];
  for (const d of perceptionEscalate) {
    const already = redactions.some(
      (r) =>
        r.source !== "perception" &&
        Math.abs(r.bbox[0] - d.region[0]) <= 4 &&
        Math.abs(r.bbox[1] - d.region[1]) <= 4 &&
        Math.abs(r.bbox[2] - d.region[2]) <= 4 &&
        Math.abs(r.bbox[3] - d.region[3]) <= 4,
    );
    if (already) continue;
    redactions.push({
      type: "graphics",
      tier: "C",
      bbox: d.region,
      source: "perception",
    });
  }

  // 1) Tokenize sensitive values inside the DOM snapshot so no PII text is
  //    sent in the JSON body.
  const sanitizedDom = dom.map((el) => {
    let text = el.text;
    let value = el.value;
    const elRedactions: RedactionLogEntry[] = [];

    // Check the field's label for sensitivity (even if value is empty).
    const fieldName = el.label || el.text;
    const fieldCheck = sensitiveFieldName(fieldName);
    if (fieldCheck?.tier === "A") {
      value = "[SECRET]";
      text = "[SECRET]"; // inputs mirror value into text; clear both
      elRedactions.push({
        type: fieldCheck.type,
        tier: "A",
        bbox: el.bbox,
        source: "dom",
      });
    } else if (fieldCheck?.tier === "B" && el.value) {
      const { text: tok, redactions: r } = tokenizeText(el.value);
      if (r.length > 0) {
        value = tok;
        for (const rr of r) {
          elRedactions.push({
            type: rr.type,
            tier: "B",
            token: rr.token,
            bbox: el.bbox,
            source: "dom",
            masked: maskPiiValue(rr.value),
          });
        }
      } else {
        // No regex match (e.g. a name/address value) but the LABEL says this
        // field is sensitive — tokenize the whole value so it never leaks.
        const token = tokenFor(fieldCheck.type, el.value);
        value = token;
        text = token; // also fix el.text which mirrors el.value for inputs
        elRedactions.push({
          type: fieldCheck.type,
          tier: "B",
          token,
          bbox: el.bbox,
          source: "dom",
          masked: maskPiiValue(el.value),
        });
      }
    }

    // Also scan the element's own visible text.
    const pii = detectPii(text);
    if (pii.length > 0) {
      const { text: tokText, redactions: r } = tokenizeText(text);
      text = tokText;
      for (const rr of r) {
        if (!elRedactions.some((x) => x.type === rr.type)) {
          elRedactions.push({
            type: rr.type,
            tier: "B",
            token: rr.token,
            bbox: el.bbox,
            source: "text",
            masked: maskPiiValue(rr.value),
          });
        }
      }
    }

    redactions.push(...elRedactions);
    return { ...el, text, value };
  });

  // 2) Process screenshot through canvas: PII redaction + SoM overlay.
  //    SoM tags are drawn LAST so they sit on top of redaction marks and
  //    are always visible to the VLM.
  //    The image is downscaled to at most MAX_IMG_W so vision-token cost and
  //    upload size stay low (Qwen-VL tokens scale with image area).
  let sanitizedDataUrl = screenshotDataUrl;
  if (redactions.length > 0 || sanitizedDom.length > 0) {
    try {
      const res = await fetch(screenshotDataUrl);
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, MAX_IMG_W / bmp.width);
      const canvas = new OffscreenCanvas(
        Math.round(bmp.width * scale),
        Math.round(bmp.height * scale),
      );
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
      if (ctx) {
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        const sc = ([x, y, w, h]: number[]): [number, number, number, number] => [
          Math.round(x * scale),
          Math.round(y * scale),
          Math.round(w * scale),
          Math.round(h * scale),
        ];

        // Tier A/B redactions + Tier C face blurs (below the tags).
        // Vision-sourced boxes get a plain black box: OCR boxes are sized to
        // the text runs found in pixels, too tight to draw a token into.
        for (const r of redactions) {
          const bbox = sc(r.bbox as [number, number, number, number]);
          if (r.tier === "C") blurRegion(ctx, bbox);
          else if (r.tier === "A" || r.source === "vision") drawBlackBox(ctx, bbox);
          else if (r.token) drawTokenText(ctx, r.token, bbox);
        }

        // Set-of-Marks overlay on top of everything (bboxes in scaled space)
        if (sanitizedDom.length > 0) {
          const scaledDom = sanitizedDom.map((el) => ({
            ...el,
            bbox: sc(el.bbox as [number, number, number, number]),
          }));
          drawSoMOverlay(ctx, scaledDom, canvas.width, canvas.height);
        }

        const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
        sanitizedDataUrl = await blobToDataUrl(outBlob);
      }
      bmp.close();
    } catch (err) {
      console.warn("sanitizer: canvas redaction/overlay failed, sending DOM tokens only", err);
    }
  }

  const body: ServerActRequest = {
    task,
    history,
    screenshot_b64: sanitizedDataUrl.replace(/^data:image\/\w+;base64,/, ""),
    dom: sanitizedDom,
    // Compact on-device semantic map → the server's redaction-aware prompt.
    screenPerception: vision?.perception,
  };

  return { ...body, redactions, visionStats: vision?.stats };
}
