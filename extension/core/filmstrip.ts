// SIH 26171 — Forensic Exhibit: step filmstrip.
//
// A scannable rail of per-step evidence frames (downscaled sanitized shots +
// gate verdicts) that replaces the wall-of-text loop history. Clicking a frame
// rehydrates the preview pair so any historical step can be audited.
//
// Frames are downscaled aggressively so persisting them in localStorage stays
// well within quota; the interactive redaction map renders from the archived
// redaction records, not the pixels.

import type { RedactionView } from "@/core/protocol";

export type FilmVerdict = "pass" | "block" | "skip";

export interface FilmFrame {
  step: number;
  verdict: FilmVerdict;
  /** Downscaled JPEG data URL of the sanitized screenshot. */
  shot: string;
  /** Downscaled JPEG data URL of the ORIGINAL capture (panel-only). */
  orig?: string;
  /** Redaction records for this step — rehydrate the audit map on click. */
  regions: RedactionView[];
}

const THUMB_MAX_W = 180;
const THUMB_QUALITY = 0.72;

/** Downscale a screenshot data URL to a small JPEG thumbnail (quota-safe). */
export function thumbFromImage(
  src: string,
  maxW = THUMB_MAX_W,
  quality = THUMB_QUALITY,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxW / img.naturalWidth);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch (err) {
        reject(err);
      } finally {
        img.onload = null;
        img.onerror = null;
      }
    };
    img.onerror = () => {
      img.onload = null;
      img.onerror = null;
      reject(new Error("thumb decode failed"));
    };
    img.src = src;
  });
}

/** Verdict colour marker + human label for a frame. */
export function verdictMeta(verdict: FilmVerdict): { cls: string; label: string } {
  switch (verdict) {
    case "pass":
      return { cls: "verdict-pass", label: "GATE PASSED" };
    case "block":
      return { cls: "verdict-block", label: "BLOCKED" };
    case "skip":
      return { cls: "verdict-skip", label: "IMAGE GATE SKIPPED" };
  }
}

/**
 * Render the filmstrip. `current` is the step index that should be highlighted
 * (0-based slot, or -1 for none). onSelect fires with the chosen frame.
 */
export function renderFilmstrip(
  container: HTMLElement,
  frames: FilmFrame[],
  current: number,
  onSelect: (frame: FilmFrame) => void,
): void {
  container.innerHTML = "";
  if (frames.length === 0) {
    const empty = document.createElement("p");
    empty.className = "film-empty";
    empty.textContent = "Step frames appear here as the agent runs.";
    container.appendChild(empty);
    return;
  }
  frames.forEach((f, i) => {
    const frame = document.createElement("button");
    frame.type = "button";
    frame.className = "film-frame";
    frame.classList.toggle("is-current", i === current);
    frame.setAttribute("aria-current", i === current ? "step" : "false");
    const meta = verdictMeta(f.verdict);

    const thumb = document.createElement("img");
    thumb.src = f.shot;
    thumb.alt = `Step ${f.step} sanitized capture`;
    thumb.loading = "lazy";

    const verdict = document.createElement("span");
    verdict.className = `film-verdict ${meta.cls}`;
    verdict.title = meta.label;
    verdict.textContent = String(f.step);

    const label = document.createElement("span");
    label.className = "film-label";
    label.textContent = `STEP ${f.step}`;

    frame.append(thumb, verdict, label);
    frame.addEventListener("click", () => onSelect(f));
    container.appendChild(frame);
  });
}