import { defineConfig } from "wxt";

// SIH 26171 privacy-preserving browser agent.
//
// Cross-browser (PS requires Chrome AND Firefox). WXT rebuilds this as
// Chrome MV3 and Firefox MV2; the manifest factory below keeps each side's
// APIs honest:
//   • Chrome  — side panel + offscreen document (the vision host).
//   • Firefox — no sidePanel/offscreen APIs: the background page IS the DOM
//               host (see core/vision-host.ts) and the UI is a sidebar_action.
export default defineConfig({
  suppressWarnings: {
    firefoxDataCollection: true,
  },
  manifest: (env) => {
    const isFirefox = env.browser === "firefox";

    const chromeExtras = {
      permissions: ["activeTab", "tabs", "sidePanel", "offscreen", "scripting", "storage"],
      minimum_chrome_version: "116",
      commands: {
        "open-spotlight": {
          suggested_key: { default: "Alt+K" },
          description: "Open the agent command palette (spotlight)",
        },
      },
    };

    const firefoxExtras = {
      permissions: ["activeTab", "tabs", "scripting", "storage"],
      sidebar_action: {
        default_title: "PRIVYSE",
        default_panel: "sidepanel.html",
      },
      browser_specific_settings: {
        gecko: {
          id: "privyse@sih26171.in",
          strict_min_version: "109.0",
        },
      },
      commands: {
        "open-spotlight": {
          suggested_key: { default: "Alt+K" },
          description: "Open the agent command palette (spotlight)",
        },
      },
    };

    return {
      name: "Privacy Browser Agent — SIH 26171",
      description:
        "On-device visual perception with client-side PII redaction; only sanitized context reaches the server.",
      host_permissions: ["<all_urls>"],
      ...(isFirefox ? firefoxExtras : chromeExtras),
    };
  },
});
