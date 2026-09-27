import { executeAction } from "@/core/executor";
import { serializeDOM } from "@/core/dom-serializer";
import { sweepDocumentPii, type RedactionLogEntry } from "@/core/sanitizer";
import { collectImageRegions } from "@/core/dom-common";
import { cursor } from "@/core/virtual-cursor";
import { spotlight } from "@/core/spotlight";
import { orb } from "@/core/orb";
import { lens } from "@/core/privacy-lens";
import { aiView } from "@/core/ai-view";
import { askBanner } from "@/core/ask-banner";
import type { AgentAction, AgentStage } from "@/core/protocol";

const STORAGE_CURSOR = "sihCursorEnabled";
const STORAGE_ORB = "sihOrbEnabled";
const STORAGE_LENS = "sihLens";
const STORAGE_AI_VIEW = "sihAiView";

function applyPrefs(changes: Record<string, { newValue?: unknown }>, area: string) {
  if (area !== "local") return;
  if (STORAGE_ORB in changes) {
    orb.setEnabled(changes[STORAGE_ORB].newValue !== false);
  }
  if (STORAGE_LENS in changes) {
    if (changes[STORAGE_LENS].newValue === true) lens.show();
    else lens.hide();
  }
  if (STORAGE_AI_VIEW in changes) {
    if (changes[STORAGE_AI_VIEW].newValue === true) aiView.enter();
    else aiView.exit();
  }
}

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
        orb.setVisible(false);
        lens.setVisible(false);
        aiView.setVisible(false);
        askBanner.setVisible(false);
        return Promise.resolve(true);
      }
      if (msg?.type === "cursor-show") {
        cursor.setVisible(true);
        orb.setVisible(true);
        lens.setVisible(true);
        aiView.setVisible(true);
        askBanner.setVisible(true);
        return Promise.resolve(true);
      }
      if (msg?.type === "cursor-toggle" && msg.enabled !== undefined) {
        cursor.setEnabled(msg.enabled);
        return Promise.resolve(true);
      }
      if (msg?.type === "spotlight") {
        void spotlight.open(cursor.getPosition() ?? undefined).then(() => {
          // no-op: overlay opened
        });
        return Promise.resolve(true);
      }
      // Live agent-status broadcasts (also consumed by the side panel) drive
      // the floating orb on the page.
      if (msg?.type === "loop-status") {
        orb.setLoop(
          (msg as { running?: boolean }).running === true,
          (msg as { step?: number }).step ?? 0,
          (msg as { maxSteps?: number }).maxSteps ?? 0,
        );
      }
      if (msg?.type === "agent-stage") {
        orb.setStage((msg as { stage?: AgentStage }).stage ?? "ready");
      }
      if (msg?.type === "privacy") {
        orb.setGate((msg as { gate?: "pass" | "block" | "skip" }).gate ?? "skip");
      }
      if (msg?.type === "ask-user") {
        const as = msg as {
          question?: string;
          options?: string[];
          kind?: "decide" | "confirm";
          viaPanel?: boolean;
        };
        // Runtime broadcasts destined for the side panel only — the banner gets
        // its own targeted tabs.sendMessage, so skip these here.
        if (as.viaPanel) return;
        if (as.question) {
          askBanner.setVisible(true);
          askBanner.show(as.question, as.options ?? [], as.kind ?? "decide");
        }
      }
      if (msg?.type === "ask-hide") {
        askBanner.hide();
      }
    });

    // Survivability overlays: the orb lives from page load (it's how the agent
    // is re-opened once the side panel is closed).
    orb.ensure();
    askBanner.ensure();

    // Restore persisted preferences from shared storage. The orb defaults to
    // ON (unlike the cursor it's the only page-side control when the panel
    // is closed); the lens and AI View only restore when the judge enabled
    // them in the side panel.
    browser.storage.local
      .get([STORAGE_CURSOR, STORAGE_ORB, STORAGE_LENS, STORAGE_AI_VIEW])
      .then((r) => {
        const cursorEnabled = r[STORAGE_CURSOR] !== false;
        cursor.setEnabled(cursorEnabled);
        if (cursorEnabled) cursor.ensure();

        orb.setEnabled(r[STORAGE_ORB] !== false);
        if (r[STORAGE_LENS] === true) lens.show();
        if (r[STORAGE_AI_VIEW] === true) aiView.enter();
      })
      .catch(() => {});

    browser.storage.onChanged.addListener(applyPrefs);
  },
});