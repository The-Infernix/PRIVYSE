// Shared on-device vision host (build plan §2/§4).
//
// This is the COMPUTE side of the vision bus: it answers "vision-run",
// "zero-leak-ocr" and "vision-warm" requests. It is deliberately
// environment-agnostic so two very different hosts can reuse it:
//
//   • Chrome MV3 — the hidden OFFSCREEN DOCUMENT (service workers have no DOM,
//     but MediaPipe WASM + the Tesseract worker both need one). The host page
//     registers `registerVisionHost(getURL)` and answers over runtime messages.
//   • Firefox MV2 — the background page IS a real DOM page, so it runs this
//     same logic IN-PROCESS (no offscreen document exists in Firefox). The
//     background calls `handleVisionHostRequest()` directly — no IPC, works
//     whether or not the sidebar is open.
//
// All failures are reported in-band (an `error` field) so the caller can fail
// closed instead of hanging on an unresponsive host.

import {
  runVision,
  setModelBase,
  getModelBase,
  warmVision,
  type VisionResult,
} from "./vision";
import { scanSanitizedImage } from "./zero-leak";

export type VisionBox = [number, number, number, number];

export interface VisionHostRequest {
  type: "vision-run" | "zero-leak-ocr" | "vision-warm";
  requestId: number;
  imageDataUrl?: string;
  imageRegions?: VisionBox[];
  /** Same-page perception cache key prefix (tab URL). OPT-IN (see perception.ts). */
  pageUrl?: string;
}

/** Initialize the host for an environment where bundled models live at `getURL("models/")`. */
export function initVisionHost(getURL: (path: string) => string): void {
  setModelBase(getURL("models/"));
}

/**
 * Run one vision request locally and return the reply the background expects.
 * Never throws — an unexpected error becomes an in-band `error` field.
 */
export async function handleVisionHostRequest(
  msg: VisionHostRequest,
): Promise<Record<string, unknown>> {
  try {
    if (msg.type === "vision-warm") {
      // Preload both model stacks (face detector + Tesseract worker + ViT) so
      // the first real runVision call doesn't pay the multi-second cold load.
      const report: Record<string, unknown> = { modelBase: getModelBase() };
      try {
        await warmVision();
        report.face = "ok";
        report.ocr = "ok";
      } catch (e) {
        report.error = e instanceof Error ? e.message : String(e);
      }
      return {
        type: "vision-warm-result",
        requestId: msg.requestId,
        loaded: !report.error,
        report,
      };
    }

    if (msg.type === "vision-run") {
      const result: VisionResult | null = await runVision({
        imageDataUrl: msg.imageDataUrl ?? "",
        imageRegions: msg.imageRegions ?? [],
        pageUrl: msg.pageUrl,
      });
      return { type: "vision-run-result", requestId: msg.requestId, result };
    }

    // zero-leak-ocr
    const gate = await scanSanitizedImage(msg.imageDataUrl ?? "");
    return { type: "zero-leak-ocr-result", requestId: msg.requestId, gate };
  } catch (e) {
    return {
      type: msg.type + "-result",
      requestId: msg.requestId,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Register the message-bus listener for a host page (Chrome offscreen). Returns
 * true from the listener for async sendReply, mirroring the previous behaviour.
 */
export function registerVisionHost(
  runtime: {
    onMessage: {
      addListener: (
        cb: (
          raw: unknown,
          sender: unknown,
          sendReply: (resp: unknown) => void,
        ) => boolean | undefined,
      ) => void;
    };
    getURL: (path: string) => string;
  },
): void {
  initVisionHost(runtime.getURL);
  runtime.onMessage.addListener((raw, _sender, sendReply) => {
    const msg = raw as VisionHostRequest;
    if (
      msg?.type !== "vision-run" &&
      msg?.type !== "zero-leak-ocr" &&
      msg?.type !== "vision-warm"
    ) {
      return;
    }
    void handleVisionHostRequest(msg).then(sendReply);
    return true; // async sendReply
  });
}
