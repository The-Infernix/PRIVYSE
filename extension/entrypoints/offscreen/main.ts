// Offscreen inference host (build plan §2). MV3 service workers have no DOM,
// but MediaPipe's WASM and Tesseract's worker both need one — this hidden
// document is the single vision host for the whole extension.
//
// Requests (from the background worker):
//   { type: "vision-run", imageDataUrl, imageRegions }  → faces + OCR PII hits
//   { type: "zero-leak-ocr", imageDataUrl }             → OCR gate verdict
// Responses are plain sendReply objects; all failures are reported in-band so
// the caller can fail closed.

import { runVision, setModelBase, getModelBase, warmVision, type VisionResult } from "@/core/vision";
import { scanSanitizedImage } from "@/core/zero-leak";

const w = globalThis as unknown as {
  chrome?: {
    runtime: {
      getURL: (p: string) => string;
      onMessage: {
        addListener: (
          cb: (
            raw: unknown,
            sender: unknown,
            sendReply: (resp: unknown) => void,
          ) => boolean | undefined,
        ) => void;
      };
    };
  };
};

// Capture the message bus FIRST, and register the listener immediately, so a
// model/base setup failure can never prevent us from answering the background
// (which would otherwise hang/timeout on an unresponsive offscreen doc).
const chromeApi = w.chrome;

// Defer to keep listener registration synchronous-ish; report fatal init
// errors in-band so the background sees a clear failure instead of a timeout.
let initError: string | null = null;
try {
  if (!chromeApi?.runtime?.onMessage) throw new Error("chrome.runtime.onMessage missing in offscreen doc");
  setModelBase(chromeApi.runtime.getURL("models/"));
} catch (e) {
  initError = e instanceof Error ? e.message : String(e);
}

interface VisionRunMsg {
  type: "vision-run";
  requestId: number;
  imageDataUrl: string;
  imageRegions?: [number, number, number, number][];
  /** Same-page perception cache key prefix (tab URL). OPT-IN — pixels shared
   * across tabs never collide because the URL is part of the key. */
  pageUrl?: string;
}
interface ZeroLeakMsg {
  type: "zero-leak-ocr";
  requestId: number;
  imageDataUrl: string;
}
interface VisionWarmMsg {
  type: "vision-warm";
  requestId: number;
  imageDataUrl: string;
}

chromeApi!.runtime.onMessage.addListener((raw: unknown, _sender: unknown, sendReply: (resp: unknown) => void) => {
  const msg = raw as VisionRunMsg | ZeroLeakMsg | VisionWarmMsg;
  if (msg?.type !== "vision-run" && msg?.type !== "zero-leak-ocr" && msg?.type !== "vision-warm") return;
  if (initError) {
    sendReply({ type: msg.type + "-result", requestId: msg.requestId, error: initError });
    return;
  }

  (async () => {
    if (msg.type === "vision-warm") {
      // Preload both model stacks (face detector + Tesseract worker) so the
      // first real runVision call doesn't pay the multi-second cold load.
      // Report per-stage status so a slow/failed init isn't a silent hang.
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
        imageDataUrl: msg.imageDataUrl,
        imageRegions: msg.imageRegions ?? [],
        pageUrl: msg.pageUrl,
      });
      return {
        type: "vision-run-result",
        requestId: msg.requestId,
        result,
      };
    }
    const gate = await scanSanitizedImage(msg.imageDataUrl);
    return { type: "zero-leak-ocr-result", requestId: msg.requestId, gate };
  })()
    .then(sendReply)
    .catch((e) =>
      sendReply({
        type: msg.type + "-result",
        requestId: (msg as { requestId: number }).requestId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );

  return true; // async sendReply
});
