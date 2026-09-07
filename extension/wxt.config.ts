import { defineConfig } from "wxt";

// Phase 0 scaffold — SIH 26171 privacy-preserving browser agent.
// Firefox note: WXT rebuilds as MV2 for firefox; the `sidePanel` permission
// is Chrome-only and will emit a warning there. Handled properly in Phase 4.
export default defineConfig({
  manifest: {
    name: "Privacy Browser Agent — SIH 26171",
    description:
      "On-device visual perception with client-side PII redaction; only sanitized context reaches the server.",
    permissions: ["activeTab", "tabs", "sidePanel", "offscreen", "scripting", "storage"],
    host_permissions: ["<all_urls>"],
    minimum_chrome_version: "116",
    commands: {
      "open-spotlight": {
        suggested_key: {
          default: "Alt+K",
        },
        description: "Open the agent command palette (spotlight)",
      },
    },
  },
});
