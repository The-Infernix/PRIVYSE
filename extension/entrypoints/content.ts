import { executeAction } from "@/core/executor";
import { serializeDOM } from "@/core/dom-serializer";
import { sweepDocumentPii, type RedactionLogEntry } from "@/core/sanitizer";
import { collectImageRegions } from "@/core/dom-common";
import { cursor } from "@/core/virtual-cursor";
import { spotlight } from "@/core/spotlight";
import type { AgentAction } from "@/core/protocol";

const STORAGE_CURSOR = "sihCursorEnabled";

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    browser.runtime.onMessage.addListener((raw: unknown) => {
      const msg = raw as { type?: string; action?: AgentAction; enabled?: boolean };
      if (msg?.type === "serialize-dom") {
        // Serialize FIRST so element bboxes are measured before the sweep
        // rewrites any prose (tokens are shorter than the PII, so rewriting
        // mid-measure reflows the page and shifts later boxes). The raw values
        // in this snapshot are tokenized in the service worker's sanitizer.
        const dom = serializeDOM();
        // Regions BEFORE the sweep — the screenshot is pre-rewrite, so every
        // box (elements, prose, image regions) must be measured on the same
        // layout the pixels show. Post-sweep collection shifts boxes ~40px.
        const imageRegions = collectImageRegions();
        const proseRedactions: RedactionLogEntry[] = [];
        sweepDocumentPii((r) => proseRedactions.push(r));
        return Promise.resolve({
          dom,
          imageRegions,
          proseRedactions: proseRedactions.map((r) => ({
            type: r.type,
            tier: r.tier,
            token: r.token,
            bbox: r.bbox,
            source: r.source,
          })),
        });
      }
      if (msg?.type === "execute-action" && msg.action) {
        return Promise.resolve(executeAction(msg.action));
      }
      if (msg?.type === "cursor-hide") {
        cursor.setVisible(false);
        return Promise.resolve(true);
      }
      if (msg?.type === "cursor-show") {
        cursor.setVisible(true);
        return Promise.resolve(true);
      }
      if (msg?.type === "cursor-toggle" && msg.enabled !== undefined) {
        cursor.setEnabled(msg.enabled);
        return Promise.resolve(true);
      }
      if (msg?.type === "spotlight") {
        console.log("[spotlight] content script received message");
        void spotlight.open(cursor.getPosition() ?? undefined).then(() => {
          console.log("[spotlight] overlay opened", cursor.getPosition());
        });
        return Promise.resolve(true);
      }
    });

    // Restore the agent-cursor preference from shared storage. When enabled,
    // the cursor is shown immediately (and follows the mouse) so it's present
    // even before any loop runs.
    browser.storage.local
      .get(STORAGE_CURSOR)
      .then((r) => {
        const enabled = r[STORAGE_CURSOR] !== false;
        cursor.setEnabled(enabled);
        if (enabled) cursor.ensure();
      })
      .catch(() => {});
  },
});