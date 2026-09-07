// Zero-leak gate (build plan §1b). Before any payload leaves the device we
// re-scan for surviving PII:
//   1. DOM scan  — regex over the outbound JSON text/values (runs anywhere,
//      including the MV3 service worker).
//   2. Image OCR — Tesseract over the SANITIZED screenshot pixels (Phase 2;
//      needs a DOM context, so it runs in the vision host: the offscreen
//      document in the extension, or the page itself in the benchmark).
// A failure in layer 2 blocks the send just like layer 1 — fail-closed.

import { detectPii } from "./pii-rules";
import { ocrFindPii, type ZeroLeakHit } from "./vision";
import type { ServerActRequest } from "./protocol";

/**
 * Scan a built request body for any surviving PII in the DOM text/values.
 * Returns the list of leaks found. Empty array ⇒ safe to send.
 */
export function scanForLeaks(body: ServerActRequest): {
  elementId: number;
  type: string;
  value: string;
}[] {
  const leaks: { elementId: number; type: string; value: string }[] = [];
  for (const el of body.dom) {
    for (const field of [el.text, el.value]) {
      if (!field) continue;
      for (const m of detectPii(field)) {
        leaks.push({ elementId: el.id, type: m.type, value: m.value });
      }
    }
  }
  return leaks;
}

/**
 * Fail-closed send guard. Returns true if safe, false to block. When leaks
 * exist the caller is expected NOT to send and to surface the problem.
 */
export function assertNoLeaks(body: ServerActRequest): boolean {
  return scanForLeaks(body).length === 0;
}

export type { ZeroLeakHit };

/**
 * OCR the sanitized screenshot and report surviving PII. Runs in a DOM
 * context only (vision host). The model never saw this image yet — this is
 * the last pixel-level check before upload.
 */
export async function scanSanitizedImage(
  sanitizedDataUrl: string,
): Promise<{ pass: boolean; hits: ZeroLeakHit[]; ms: number; error?: string }> {
  try {
    const { hits, ms } = await ocrFindPii(sanitizedDataUrl);
    return { pass: hits.length === 0, hits, ms };
  } catch (e) {
    // Fail-closed: an OCR gate that cannot run must not silently approve.
    return {
      pass: false,
      hits: [],
      ms: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
