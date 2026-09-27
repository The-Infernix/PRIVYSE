// Offscreen inference host (build plan §2). MV3 service workers have no DOM,
// but MediaPipe's WASM and Tesseract's worker both need one — this hidden
// document is the Chrome vision host for the whole extension.
//
// The actual request handling lives in core/vision-host.ts so the Firefox
// background page can reuse the exact same logic in-process. This file only
// wires that handler to the runtime message bus.
//
// Requests (from the background worker):
//   { type: "vision-run", imageDataUrl, imageRegions, pageUrl } → faces + OCR + ViT
//   { type: "zero-leak-ocr", imageDataUrl }                     → OCR gate verdict
//   { type: "vision-warm", imageDataUrl }                       → preload models

import { registerVisionHost } from "@/core/vision-host";

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

// Capture the message bus FIRST and register the listener immediately, so a
// model/base setup failure can never prevent us from answering the background
// (which would otherwise hang/timeout on an unresponsive offscreen doc).
const chromeApi = w.chrome;

if (chromeApi?.runtime?.onMessage) {
  registerVisionHost(chromeApi.runtime);
} else {
  console.error("PRIVYSE: chrome.runtime.onMessage missing in offscreen doc");
}
