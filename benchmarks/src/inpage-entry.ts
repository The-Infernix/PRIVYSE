import { serializeDOM } from "../../extension/core/dom-serializer";
import { detectPii } from "../../extension/core/pii-rules";
import { sanitizeForUpload, sweepDocumentPii } from "../../extension/core/sanitizer";
import { scanForLeaks, scanSanitizedImage } from "../../extension/core/zero-leak";
import { executeAction } from "../../extension/core/executor";
import { forEachElement, collectImageRegions } from "../../extension/core/dom-common";
import { runVision, setModelBase } from "../../extension/core/vision";
import type { AgentAction } from "../../extension/core/protocol";

// Expose the REAL production sanitizer internals to the benchmark runner so we
// measure exactly what ships in the extension (not a test double). The vision
// host here is the page itself — same code the offscreen document runs.
declare global {
  interface Window {
    __sih: {
      serializeDOM: typeof serializeDOM;
      detectPii: typeof detectPii;
      sanitizeForUpload: typeof sanitizeForUpload;
      sweepDocumentPii: typeof sweepDocumentPii;
      scanForLeaks: typeof scanForLeaks;
      scanSanitizedImage: typeof scanSanitizedImage;
      executeAction: typeof executeAction;
      runVision: typeof runVision;
      collectImageRegions: typeof collectImageRegions;
      elementCount: () => number;
    };
  }
}

// Models are served same-origin under /models/ (by the bench's embedded
// static server or the FastAPI app). On a non-http page (file://) module
// import + workers are blocked, so vision degrades to "skipped" gracefully.
const ORIGIN = window.location.origin;
setModelBase(ORIGIN.startsWith("http") ? `${ORIGIN}/models/` : "/models/");

window.__sih = {
  serializeDOM,
  detectPii,
  sanitizeForUpload,
  sweepDocumentPii,
  scanForLeaks,
  scanSanitizedImage,
  executeAction,
  runVision,
  collectImageRegions,
  elementCount: () => {
    let n = 0;
    forEachElement(() => n++);
    return n;
  },
};
export type { AgentAction };
