import { serializeDOM } from "../../extension/core/dom-serializer";
import { detectPii } from "../../extension/core/pii-rules";
import { sanitizeForUpload, sweepDocumentPii } from "../../extension/core/sanitizer";
import { scanForLeaks, scanSanitizedImage } from "../../extension/core/zero-leak";
import { executeAction } from "../../extension/core/executor";
import { forEachElement, collectImageRegions, indexOfElement } from "../../extension/core/dom-common";
import { runVision, setModelBase } from "../../extension/core/vision";
import { perceiveScreen, setModelBase as setPerceptionModelBase, _abTest } from "../../extension/core/perception";
import * as guards from "../../extension/core/action-guards";
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
      perceiveScreen: typeof perceiveScreen;
      collectImageRegions: typeof collectImageRegions;
      elementCount: () => number;
      indexOfElement: typeof indexOfElement;
      setPerceptionModelBase: typeof setPerceptionModelBase;
      _abTest: typeof _abTest;
      guards: typeof guards;
    };
  }
}

// Models are served same-origin under /models/ (by the bench's embedded
// static server or the FastAPI app). On a non-http page (file://) module
// import + workers are blocked, so vision degrades to "skipped" gracefully.
const ORIGIN = window.location.origin;
const BF = ORIGIN.startsWith("http") ? `${ORIGIN}/models/` : "/models/";
setModelBase(BF);
setPerceptionModelBase(BF);

window.__sih = {
  serializeDOM,
  detectPii,
  sanitizeForUpload,
  sweepDocumentPii,
  scanForLeaks,
  scanSanitizedImage,
  executeAction,
  runVision,
  perceiveScreen,
  collectImageRegions,
  elementCount: () => {
    let n = 0;
    forEachElement(() => n++);
    return n;
  },
  setPerceptionModelBase,
  _abTest,
  guards,
  indexOfElement,
};
export type { AgentAction };
