// Background service worker — the agent orchestrator.
// Runs the capture → serialize → sanitize → /act → execute loop
// with ≥700 ms throttle (captureVisibleTab is rate-limited to ~2/sec in Chrome).

import { SERVER_URL } from "@/core/config";
import { sanitizeForUpload, type VisionFindings } from "@/core/sanitizer";
import { assertNoLeaks } from "@/core/zero-leak";
import { isSensitivePage } from "@/core/sensitive-pages";
import { resetVerifiedTargets, getVerifiedTargets, resetClickedTypeables, isKnownTypeable, describeKnownTypeable } from "@/core/executor";
import type {
  AgentAction,
  DomElement,
  ExtMessage,
  ExecuteActionMsg,
  HistoryStep,
  ServerActRequest,
  ServerActResponse,
} from "@/core/protocol";

// Adaptive budget: the loop no longer stops at a fixed "15 steps". It runs
// until the VLM reports done, recovering via /rethink when stuck or blocked.
// MAX_STEPS is only a safety net so a runaway loop can't spin forever.
const MAX_STEPS = 50;
const THROTTLE_MS = 750;
const MAX_CONSECUTIVE_FAILURES = 2;
const STUCK_REPEAT = 3; // same action repeated N times → force a rethink
const MAX_CONSECUTIVE_BLOCKED = 3; // N blocked steps in a row → force a rethink
const MAX_RETHINK_ATTEMPTS = 3; // give up only if rethink keeps failing to change the plan
const DEFAULT_MODEL = "qwen2.5vl:3b";
const STORAGE_MODEL = "sihModel";
const STORAGE_LESSONS = "sihLessons";
const RESTRICTED_URL_RE =
  /^(chrome:|about:|edge:|devtools:|view-source:|chrome-extension:|moz-extension:)/i;

type LessonMap = Record<string, string[]>;

// Some pages can never be captured by extensions (Chrome's built-in pages,
// the Web Store, etc.). Returns a friendly message so the "activeTab not in
// effect" error gets replaced with something a judge can act on.
function restrictedPageError(url: string | undefined): string | null {
  if (!url) return null;
  if (RESTRICTED_URL_RE.test(url)) {
    return "Chrome's built-in pages (new tab, settings, etc.) can't be captured — open a normal website first.";
  }
  if (/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/.test(url)) {
    return "The Chrome Web Store blocks extensions — open a normal website first.";
  }
  return null;
}

let loopRunning = false;
let loopAbort = false;

// ---------------------------------------------------------------------------
// Vision host client — the offscreen document runs MediaPipe + Tesseract
// (service workers have no DOM). Requests are correlated by requestId so the
// shared runtime bus never crosses wires with the sidepanel/content listeners.
// ---------------------------------------------------------------------------

let visionReqSeq = 0;

// Chrome-only namespace (offscreen + getContexts are not in the polyfill), so
// reach it through globalThis with a narrow structural type.
interface ChromeOffscreenApi {
  runtime: {
    getContexts?: (f: Record<string, unknown>) => Promise<unknown[]>;
    getURL: (p: string) => string;
    onMessage: {
      addListener: (cb: (raw: unknown) => void) => void;
      removeListener: (cb: (raw: unknown) => void) => void;
    };
    sendMessage: (msg: Record<string, unknown>) => Promise<unknown>;
  };
  offscreen: {
    createDocument: (p: {
      url: string;
      reasons: string[];
      justification: string;
    }) => Promise<void>;
  };
}
const chromeApi = (globalThis as unknown as { chrome?: ChromeOffscreenApi }).chrome;

async function ensureVisionHost(): Promise<void> {
  if (!chromeApi?.offscreen) {
    throw new Error("chrome.offscreen unavailable (Firefox needs the sidebar as vision host)");
  }
  if (chromeApi.runtime.getContexts) {
    const ctx = await chromeApi.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (ctx.length > 0) return;
  }
  await chromeApi.offscreen.createDocument({
    url: chromeApi.runtime.getURL("offscreen.html"),
    reasons: ["WORKERS"],
    justification:
      "On-device vision models (face detection + OCR for PII redaction) need a DOM with Web Workers; MV3 service workers have none.",
  });
}

async function visionHostRequest<T>(msg: Record<string, unknown>, timeoutMs = 90000): Promise<T> {
  await ensureVisionHost();
  const requestId = ++visionReqSeq;
  const expected = `${msg.type}-result`;
  return await new Promise<T>((resolve, reject) => {
    const listener = (raw: unknown) => {
      const m = raw as { type?: string; requestId?: number; error?: string };
      if (m?.type !== expected || m?.requestId !== requestId) return;
      cleanup();
      if (m.error) reject(new Error(m.error));
      else resolve(m as T);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("vision host timeout"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      chromeApi!.runtime.onMessage.removeListener(listener);
    };
    chromeApi!.runtime.onMessage.addListener(listener);
    chromeApi!.runtime
      .sendMessage({ ...msg, requestId })
      .catch((e) => {
        cleanup();
        reject(e);
      });
  });
}

// Chrome caps captureVisibleTab at ~2 calls/sec. The recovery (rethink) path
// re-captures immediately after two failed steps, which can trip the quota —
// so we enforce a 1s minimum gap between captures.
const CAPTURE_MIN_GAP_MS = 1000;
let lastCaptureAt = 0;

/** Resolve with `p` or reject after `ms` — a watchdog for infra (vision host,
 * network) that might otherwise hang the loop forever. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

// Preload the on-device vision models on extension startup so the first real
// step doesn't pay the multi-second (sometimes 60-90s on a laptop) model load.
// A tiny blank snapshot keeps the offscreen host warm; it scans nothing real.
// Best-effort: any failure is ignored and the first step will load lazily.
const WARM_IMAGE =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
let visionWarmStarted = false;

// Fail-fast on-device vision degradation (Phase 2). When the vision host can't
// answer a step — models still cold-loading (60-90s on a laptop) or the
// offscreen doc unreachable — we must NOT burn a ~30s budget on EVERY step
// (the previous behaviour made each step wait for vision + again for the OCR
// gate, then degrade anyway). After one failure we stop attempting vision for
// a couple of minutes and let background warm retries land; when the host is
// ready the flag clears automatically and later steps get full OCR redaction.
const VISION_DOWN_MS = 3 * 60 * 1000;
const VISION_WARM_TIMEOUT_MS = 150_000; // cold load can legitimately take 60-90s+
let visionDownUntil = 0;
let visionDownLoggedAt = 0;

function visionHostAvailable(): boolean {
  return Date.now() >= visionDownUntil;
}

// Module-scope logger for off-callback helpers (vision warm/degrade). The
// callback-local `log` only exists inside defineBackground, so calling it from
// here throws "log is not defined" — this is the module-scope twin.
async function moduleLog(
  level: "info" | "error" | "success",
  text: string,
  screenshot?: string,
) {
  await browser.runtime
    .sendMessage({ type: "agent-log", level, text, screenshot } satisfies ExtMessage)
    .catch(() => {});
}

function markVisionHostDown(prefix: string, err: string): void {
  visionDownUntil = Date.now() + VISION_DOWN_MS;
  if (Date.now() - visionDownLoggedAt > 30_000) {
    visionDownLoggedAt = Date.now();
    void moduleLog(
      "info",
      `${prefix}On-device vision down for a while (${err}) — using DOM-only redaction; warming in background…`,
    );
  }
}

async function warmVisionModels(retries = 5): Promise<boolean> {
  if (visionWarmStarted) return false;
  if (!chromeApi?.offscreen) return false; // Firefox: no offscreen — skip warm
  visionWarmStarted = true;
  try {
    const r = await visionHostRequest<{ loaded?: boolean }>(
      { type: "vision-warm", imageDataUrl: WARM_IMAGE, imageRegions: [] },
      VISION_WARM_TIMEOUT_MS,
    );
    visionDownUntil = 0; // host is ready again — re-enable per-step vision
    return !!r?.loaded;
  } catch {
    // Cold load can outrun the first budget; keep retrying in the background
    // so the flag clears as soon as the host is ready while the loop stays
    // fast (DOM-only) in the meantime.
    if (retries > 0) setTimeout(() => void warmVisionModels(retries - 1), 20_000);
    return false;
  } finally {
    visionWarmStarted = false;
  }
}

export default defineBackground(() => {
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});

  // Fire-and-forget: preload models in the background, don't block startup.
  // Retried until it lands; success clears the vision-down flag.
  void (async () => {
    await log("info", "Preloading on-device vision models (face + OCR)…");
    const ok = await warmVisionModels(5);
    if (ok) await log("success", "Vision models ready (face + OCR preloaded).");
  })();

  browser.runtime.onMessage.addListener((raw: unknown) => {
    const msg = raw as ExtMessage;
    if (msg?.type === "run-step") {
      return runSingleStep(msg.task);
    }
    if (msg?.type === "start-loop" && !loopRunning) {
      loopRunning = true;
      loopAbort = false;
      runLoop(msg.task);
    }
    if (msg?.type === "stop-loop") {
      loopAbort = true;
    }
    if (msg?.type === "cursor-toggle") {
      forwardCursorToggle(msg.enabled);
    }
    if (msg?.type === "open-panel") {
      openAgentPanel();
    }
  });

  // ── Logging helpers ───────────────────────────────────────────────────

  // Browser-wide spotlight. Alt+K pops the command palette beside the blue
  // cursor in the CURRENT tab. Restricted pages (chrome:// etc.) can't run
  // content scripts — fall back to the side panel there.
  //
  // NOTE: sidePanel.open() needs a live user gesture. `chrome.commands` IS a
  // valid gesture, but ONLY if the call is synchronous — any `await` between
  // the keypress and open() expires it. So we cache the active tab and call
  // the panel sync via WINDOW_ID_CURRENT when we know we can't inject.
  let cachedActiveTab: { id: number; url?: string } | null = null;

  browser.tabs.onActivated.addListener(({ tabId }) => {
    cachedActiveTab = { ...(cachedActiveTab || {}), id: tabId };
  });
  browser.tabs.onUpdated.addListener((tabId, _info, tab) => {
    if (tab.active) cachedActiveTab = { id: tabId, url: tab.url };
    else if (cachedActiveTab?.id === tabId) cachedActiveTab = { ...cachedActiveTab, url: tab.url };
  });

  const openPanelSync = () => {
    void (browser as any)
      .sidePanel.open({ windowId: (browser as any).windows.WINDOW_ID_CURRENT })
      .catch(() => {});
  };

  browser.commands.onCommand.addListener(async (command) => {
    if (command !== "open-spotlight") return;
    console.log("[spotlight] command fired", cachedActiveTab);

    if (cachedActiveTab?.url && restrictedPageError(cachedActiveTab.url)) {
      console.log("[spotlight] restricted page — opening side panel");
      openPanelSync();
      return;
    }

    const tabId =
      cachedActiveTab?.id ??
      (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (!tabId) return;
    try {
      await browser.tabs.sendMessage(tabId, { type: "spotlight" } satisfies ExtMessage);
      console.log("[spotlight] delivered to existing content script");
      return;
    } catch (err) {
      console.log("[spotlight] content script missing, injecting…", err);
    }
    try {
      await (browser as any).scripting.executeScript({
        target: { tabId },
        files: ["content-scripts/content.js"],
      });
      await browser.tabs.sendMessage(tabId, { type: "spotlight" } satisfies ExtMessage);
      console.log("[spotlight] injected + delivered");
    } catch (err) {
      console.log("[spotlight] injection failed — opening side panel", err);
      openPanelSync();
    }
  });

  async function openAgentPanel() {
    try {
      const win = await browser.windows.getLastFocused({ populate: false });
      if (win?.id) await browser.sidePanel.open({ windowId: win.id });
    } catch (err) {
      console.warn("sidePanel.open failed:", err);
    }
  }

  async function forwardCursorToggle(enabled: boolean) {
    const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id) return;
    await browser.tabs
      .sendMessage(tab.id, { type: "cursor-toggle", enabled } satisfies ExtMessage)
      .catch(() => {});
  }

  async function log(
    level: "info" | "error" | "success",
    text: string,
    screenshot?: string,
  ) {
    await browser.runtime
      .sendMessage({ type: "agent-log", level, text, screenshot } satisfies ExtMessage)
      .catch(() => {});
  }

  async function status(step: number) {
    await browser.runtime
      .sendMessage({
        type: "loop-status",
        running: loopRunning,
        step,
        maxSteps: MAX_STEPS,
      } satisfies ExtMessage)
      .catch(() => {});
  }

  // ── Model selection (shared via chrome.storage.local: "sihModel") ─────

  async function readModel(): Promise<string> {
    try {
      const { [STORAGE_MODEL]: m } = (await browser.storage.local.get(STORAGE_MODEL)) as {
        [STORAGE_MODEL]?: string;
      };
      return typeof m === "string" && m ? m : DEFAULT_MODEL;
    } catch {
      return DEFAULT_MODEL;
    }
  }

  // ── Cross-run lesson memory ────────────────────────────────────────────
  // Verified corrections are stored per hostname and injected into the prompt
  // on future runs so the learner never repeats the same mispick.

  async function getHost(): Promise<string> {
    try {
      const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
      if (tab?.url) return new URL(tab.url).hostname;
    } catch {
      /* ignore */
    }
    return "unknown";
  }

  async function readLessons(host: string): Promise<string[]> {
    try {
      const { [STORAGE_LESSONS]: map } = (await browser.storage.local.get(STORAGE_LESSONS)) as {
        [STORAGE_LESSONS]?: LessonMap;
      };
      return map?.[host] ?? [];
    } catch {
      return [];
    }
  }

  async function writeLesson(host: string, text: string) {
    try {
      const { [STORAGE_LESSONS]: map } = (await browser.storage.local.get(STORAGE_LESSONS)) as {
        [STORAGE_LESSONS]?: LessonMap;
      };
      const m: LessonMap = map && typeof map === "object" ? map : {};
      const arr = (m[host] ?? []).filter((l) => l !== text);
      arr.push(text);
      m[host] = arr.slice(-8);
      await browser.storage.local.set({ [STORAGE_LESSONS]: m });
    } catch {
      /* ignore storage errors */
    }
  }

  // ── Streaming act call + live thinking forwarding ─────────────────────
  // Post to /act/stream (SSE). Token deltas are batched and forwarded to the
  // side panel as think-delta messages so the model can be watched in real
  // time. Falls back to the classic /act POST if streaming fails.

  let thinkBuf = "";
  let thinkTimer: ReturnType<typeof setTimeout> | undefined;

  function flushThink() {
    thinkTimer = undefined;
    if (thinkBuf) {
      const t = thinkBuf;
      thinkBuf = "";
      browser.runtime.sendMessage({ type: "think-delta", text: t }).catch(() => {});
    }
  }

  async function callActStream(
    body: ServerActRequest,
    onToken: (delta: string) => void,
    path: "act" | "rethink" = "act",
  ): Promise<ServerActResponse> {
    const streamPath = path === "rethink" ? "/rethink/stream" : "/act/stream";
    const postPath = path === "rethink" ? "/rethink" : "/act";
    try {
      const res = await fetch(`${SERVER_URL}${streamPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) throw new Error(`Server responded ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let pendingEvent = "";
      let lastError = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n/);
        buffer = frames.pop() ?? "";
        for (const line of frames) {
          if (line.startsWith("event: ")) pendingEvent = line.slice(7).trim();
          else if (line.startsWith("data: ") && pendingEvent) {
            try {
              const data = JSON.parse(line.slice(6)) as unknown;
              if (pendingEvent === "thought" && data) {
                onToken((data as { delta?: string }).delta ?? "");
              } else if (pendingEvent === "action" && data) {
                return data as ServerActResponse;
              } else if (pendingEvent === "error" && data) {
                lastError = (data as { message?: string }).message ?? String(data);
              }
            } catch {
              /* skip malformed frame */
            }
            pendingEvent = "";
          }
        }
      }
      throw new Error(lastError || "stream ended without an action");
    } catch (err) {
      // Fallback: classic non-streamed POST (kept for robustness).
      const res = await fetch(`${SERVER_URL}${postPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      return (await res.json()) as ServerActResponse;
    }
  }

  // ── Single-step core (capture → sanitize → send → execute) ────────────
  // mode "rethink" hits /rethink(/,stream) instead of /act — the model is
  // forced to pick a DIFFERENT action than the stuck/blocked history.

  async function executeStep(
    task: string,
    history: HistoryStep[],
    stepNum?: number,
    mode: "act" | "rethink" = "act",
    warnings: string[] = [],
  ): Promise<{
    ok: boolean;
    done: boolean;
    result?: string;
    action?: AgentAction;
    subgoal?: string;
    blocked?: boolean;
    domFingerprint?: string;
  }> {
    const prefix = stepNum !== undefined ? `[Step ${stepNum}] ` : "";
    const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id || tab.windowId === undefined) {
      throw new Error("No active tab to capture.");
    }

    // Friendly guard: restricted pages (new tab, chrome://, Web Store, etc.)
    // can never be captured, no matter the permission — tell the user clearly.
    const restricted = restrictedPageError(tab.url);
    if (restricted) {
      throw new Error(restricted);
    }

    // Privacy guard (borrowed from clicky-windows): if the page is a banking /
    // password / government-ID page, skip the screenshot entirely — the raw
    // pixels never reach the VLM. Belt-and-suspenders on top of the sanitizer.
    const sensitive = tab.url ? isSensitivePage(tab.url, tab.title ?? "") : null;
    if (sensitive) {
      const reason = `Sensitive page (${sensitive.reason} in ${sensitive.source}: "${sensitive.matched}") — screenshot skipped for privacy.`;
      throw new Error(reason);
    }

    // 1) Capture screenshot (lower quality for speed). Chrome's captureVisibleTab
    // is rate-limited (~2 calls/sec), and rethink re-captures right after a
    // failure — enforce a 1s gap so the quota error can't abort the recovery.
    await log("info", `${prefix}Capturing screenshot of "${tab.title}"…`);
    const sinceCapture = Date.now() - lastCaptureAt;
    if (sinceCapture >= 0 && sinceCapture < CAPTURE_MIN_GAP_MS) {
      await new Promise((r) => setTimeout(r, CAPTURE_MIN_GAP_MS - sinceCapture));
    }
    // Hide the agent cursor first so it never appears in the VLM's screenshot.
    await browser.tabs
      .sendMessage(tab.id, { type: "cursor-hide" } satisfies ExtMessage)
      .catch(() => {});
    lastCaptureAt = Date.now();
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 50,
    });
    await browser.tabs
      .sendMessage(tab.id, { type: "cursor-show" } satisfies ExtMessage)
      .catch(() => {});
    const kb = Math.round(
      (dataUrl.replace(/^data:image\/\w+;base64,/, "").length * 3) / 4 / 1024,
    );
    await log("info", `${prefix}Screenshot captured (${kb} KB)`);

    // 2) Serialize DOM — inject content script if not already present
    let dom: DomElement[] = [];
    let proseRedactions = [];
    let imageRegions: [number, number, number, number][] = [];
    try {
      const res = await browser.tabs.sendMessage(tab.id, { type: "serialize-dom" });
      dom = Array.isArray(res?.dom) ? res.dom : [];
      proseRedactions = Array.isArray(res?.proseRedactions) ? res.proseRedactions : [];
      imageRegions = Array.isArray(res?.imageRegions) ? res.imageRegions : [];
      await log("info", `${prefix}DOM serialized: ${dom.length} interactive elements`);
      if (dom.length > 0) {
        const preview = dom
          .slice(0, 20)
          .map(
            (el) =>
              `${el.id}:<${el.tag}>[${el.role}]"${(el.label || el.text || "").slice(0, 24)}"`,
          )
          .join("  ");
        await log("info", `${prefix}DOM: ${preview}`);
      }
    } catch {
      // Content script not injected — inject it and retry
      try {
        await log("info", `${prefix}Injecting content script…`);
        await (browser as any).scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content-scripts/content.js"],
        });
        // Small delay for the script to initialize
        await new Promise((r) => setTimeout(r, 100));
        const res = await browser.tabs.sendMessage(tab.id, { type: "serialize-dom" });
        dom = Array.isArray(res?.dom) ? res.dom : [];
        proseRedactions = Array.isArray(res?.proseRedactions) ? res.proseRedactions : [];
        imageRegions = Array.isArray(res?.imageRegions) ? res.imageRegions : [];
        await log("info", `${prefix}DOM serialized: ${dom.length} interactive elements`);
      } catch (e2) {
        await log("info", `${prefix}DOM serialize failed: ${e2}`);
      }
    }

    // 3) Sanitize + SoM overlay (the privacy gate)
    await log("info", `${prefix}Sanitizing PII + drawing SoM overlay…`);

    // 3a) On-device vision (Phase 2): face detection always runs; OCR only on
    //     non-DOM surfaces (canvas/img/video) — text-only pages never pay the
    //     Tesseract cost. Failure degrades to DOM-only redaction; the OCR
    //     zero-leak gate below still fails closed.
    //
    // HARD WATCHDOG: if the on-device vision host can't initialize (dynamic
    // wasm/worker load hanging, offscreen doc missing, CSP blocking a worker),
    // vision — including the zero-leak OCR gate further down — must NEVER block
    // the agent loop. We give the whole on-device pipeline a short, bounded
    // budget and fall back to DOM-only redaction on any failure/timeout.
    const VISION_STEP_TIMEOUT_MS = 30000;
    let vision: VisionFindings | undefined;
    if (visionHostAvailable()) {
      try {
        const hasImages = (imageRegions?.length ?? 0) > 0;
        await log("info", `${prefix}Running on-device vision (face + OCR)…`);
        const tVision = Date.now();
        const vr = await withTimeout(
          visionHostRequest<{
            result: VisionFindings | null;
          }>({ type: "vision-run", imageDataUrl: dataUrl, imageRegions }),
          VISION_STEP_TIMEOUT_MS,
          `on-device vision step timed out after ${VISION_STEP_TIMEOUT_MS / 1000}s`,
        );
        const visionDur = Math.round((Date.now() - tVision) / 100) / 10;
        await log(
          "info",
          `${prefix}Vision ready in ${visionDur}s (${hasImages ? "face + OCR" : "face only"}) — analyzing…`,
        );
        vision = vr?.result ?? undefined;
        if (vision) {
          await log(
            "info",
            `${prefix}Vision: ${vision.faces.length} face(s) blurred, ${vision.ocr.length} OCR PII hit(s) in image regions`,
          );
        }
      } catch (e) {
        // First failure is the signal, not a reason to stall every step:
        // degrade fast and keep warming in the background.
        markVisionHostDown(prefix, String(e));
        void warmVisionModels(4);
        await log("info", `${prefix}Vision host unavailable (${e}); continuing with DOM-only redaction`);
      }
    } else {
      await log(
        "info",
        `${prefix}Vision host warming in background — DOM-only redaction this step.`,
      );
    }

    const payload = await sanitizeForUpload(dataUrl, dom, task, history, proseRedactions, vision);
    const stepsHost = await getHost();
    const lessons = await readLessons(stepsHost);
    const body: ServerActRequest = {
      ...payload,
      model: await readModel(),
      lessons,
      warnings,
    };

    // Deterministic element findings from the executor (auto-descended inputs,
    // confirmed working targets). Injected into the prompt so the VLM uses the
    // known-good element id instead of re-guessing a wrapper.
    const verified = getVerifiedTargets();
    if (verified.length > 0) body.verifiedTargets = verified;

    if (!assertNoLeaks(body)) {
      throw new Error("Blocked: PII detected in outbound payload.");
    }

    // Zero-leak layer 2 (Phase 2): OCR the sanitized pixels — what would
    // actually be uploaded. Only pages with non-DOM surfaces pay the OCR cost
    // (DOM-covered text is already covered by the layer-1 scan). Fail-closed:
    // if the gate cannot run, the step is blocked, never sent unsanitized.
    if (imageRegions.length > 0 && visionHostAvailable()) {
      const tGate = Date.now();
      await log("info", `${prefix}Running zero-leak OCR gate on sanitized image…`);
      let gate: { gate?: { pass: boolean; hits: { type: string; value: string }[]; error?: string } };
      try {
        gate = await withTimeout(
          visionHostRequest<{
            gate: { pass: boolean; hits: { type: string; value: string }[]; error?: string };
          }>({ type: "zero-leak-ocr", imageDataUrl: "data:image/jpeg;base64," + payload.screenshot_b64 }),
          VISION_STEP_TIMEOUT_MS,
          `zero-leak OCR gate timed out after ${VISION_STEP_TIMEOUT_MS / 1000}s`,
        );
      } catch (e) {
        // The OCR pixel gate only works when the on-device vision host is up.
        // When it is unavailable (host down / init failure), we DEGRADE GRACEFULLY
        // (skip the image-level gate and rely on the mandatory DOM-layer
        // assertNoLeaks above, which already failed closed on any text PII) —
        // rather than blocking every image-heavy page indefinitely. The DOM
        // layer-1 check is still the hard gate; this layer-2 adds OCR depth when
        // available.
        await log("info", `${prefix}Zero-leak image gate unavailable (${e}); relying on DOM-layer gate.`);
        gate = {} as never;
      }
      const g = gate?.gate;
      if (g && !g.pass) {
        const why = g.error ?? (g.hits ?? []).map((h) => h.type).join(", ");
        throw new Error(`Blocked: zero-leak image gate failed (${why || "unknown"})`);
      }
      const gateDur = Math.round((Date.now() - tGate) / 100) / 10;
      await log("info", `${prefix}Zero-leak gate done in ${gateDur}s`);
    } else if (imageRegions.length > 0) {
      await log(
        "info",
        `${prefix}Zero-leak OCR gate skipped (vision host down) — DOM-layer gate still enforced.`,
      );
    }

    if (payload.redactions.length > 0) {
      await log(
        "info",
        `${prefix}Redacted ${payload.redactions.length} PII region(s): ` +
          payload.redactions
            .map((r) => `${r.type}${r.token ? ` → ${r.token}` : ""}`)
            .join(", "),
      );
    } else {
      await log("info", `${prefix}No PII detected`);
    }

    // 4) Send to server (streamed so we relay the model's thinking live)
    const label = mode === "rethink" ? "Asking for an alternative plan" : "Sending to VLM";
    await log("info", `${prefix}${label} (${body.dom.length} DOM elements, ${kb} KB screenshot)…`);
    browser.runtime.sendMessage({ type: "think-start" }).catch(() => {});
    const data = await callActStream(body, (delta) => {
      thinkBuf += delta;
      if (!thinkTimer) thinkTimer = setTimeout(flushThink, 60);
    }, mode);
    flushThink();
    await log("info", `${prefix}🧠 VLM thought: ${data.thought}`);
    browser.runtime.sendMessage({ type: "think-end", thought: data.thought }).catch(() => {});
    // Show the SANITIZED screenshot (what the VLM saw): overlay + redactions.
    const sanitizedPreview = "data:image/jpeg;base64," + payload.screenshot_b64;
    await log("info", `${prefix}→ Action: ${JSON.stringify(data.action)}`, sanitizedPreview);

    // 5) Execute action in the tab
    await log("info", `${prefix}Executing ${data.action.type}…`);
    let result: string;
    try {
      result = (await browser.tabs.sendMessage(tab.id, {
        type: "execute-action",
        action: data.action,
      } satisfies ExecuteActionMsg)) as string;
    } catch (err) {
      // Attach the action that failed so the learner can feed a precise,
      // contextual error back to the VLM on the next step.
      (err as Error & { agentAction?: AgentAction }).agentAction = data.action;
      throw err;
    }
    await log("success", `${prefix}Done: ${result}`);

    // Progress fingerprint: cheap signature of the current visible DOM state.
    // Used by runLoop to detect "page hasn't changed" even when the action
    // text varies (clicking a button that does nothing still "succeeds").
    const domFingerprint = dom
      .slice(0, 80)
      .map((el) => `${el.id}:${el.tag}:${el.label}:${el.text.slice(0, 12)}`)
      .join("|");

    return {
      ok: true,
      done: data.done,
      result,
      action: data.action,
      subgoal: data.subgoal,
      blocked: data.blocked,
      domFingerprint,
    };
  }

  // ── Single-step (button click) ────────────────────────────────────────

  async function runSingleStep(task: string) {
    try {
      await log("info", "Running single step…");
      await executeStep(task, []);
    } catch (err) {
      await log("error", `Failed: ${err}`);
    }
  }

  // ── Multi-step loop (auto) ────────────────────────────────────────────
  // Runs until the VLM reports done. When a step is blocked, an action repeats
  // itself, or too many steps fail in a row, the loop hits /rethink and the
  // model is forced to propose a DIFFERENT plan — so the agent recovers and
  // keeps going instead of stopping after a fixed number of steps.

  // Persistent, deduped within-run memory of actions that did NOT work. This is
  // what stops the "keep clicking the same button" loop: once the model sees an
  // action on this list, it is told to never fire it again.
  function pushWarning(warnings: string[], text: string) {
    if (!warnings.includes(text)) warnings.push(text);
    if (warnings.length > 12) warnings.shift();
  }

  async function runRethink(
    task: string,
    history: HistoryStep[],
    stepNum: number,
    warnings: string[],
  ): Promise<AgentAction | undefined> {
    try {
      const { ok, done, result, action, subgoal, blocked } = await executeStep(
        task,
        history,
        stepNum,
        "rethink",
        warnings,
      );
      if (ok && result && action) {
        history.push({ action, result, subgoal, blocked });
        if (action.type === "wait") {
          await log("error", `Rethink proposed a bare wait (${action.ms}ms) — that's not a plan. Keeping the stuck signal.`);
        } else {
          await log("success", `New plan after rethink: ${JSON.stringify(action)} → ${result}`);
        }
        return action;
      }
    } catch (err) {
      await log("error", `Rethink step failed: ${err}`);
    }
    return undefined;
  }

  async function runLoop(task: string) {
    const history: HistoryStep[] = [];
    let consecutiveFailures = 0;
    const recentActions: string[] = []; // for stuck detection
    const warnings: string[] = []; // persistent do-not-repeat memory
    let pendingLesson: { host: string; text: string } | null = null;
    let consecutiveBlocked = 0;
    let rethinks = 0;
    let lastFingerprint = "";
    let noProgressSteps = 0;

    // Fresh executor memory for this run.
    resetVerifiedTargets();
    resetClickedTypeables();

    let lastClickTypeableId: number | null = null; // for the "forgot to type" guard
    let lastActionType: string | null = null;

    // ── Deterministic auto-type escalator ──────────────────────────────
    // The executor knows when a click landed on a real text field. If the VLM
    // keeps re-clicking it instead of emitting `type` (common on small models),
    // we derive a phrase from the task and inject the type ourselves — breaking
    // the click-loop deterministically rather than waiting for the model to
    // change its mind after 3+ wasted steps.
    function deriveTypePhrase(task: string): string {
      const t = task.trim();
      const quoted = /"([^"]{1,50})"/.exec(t);
      if (quoted) return quoted[1];
      const m = /search\s+(?:for\s+)?(.+)$/i.exec(t);
      if (m) {
        const phrase = m[1]
          .replace(/\s+(on|in|at|via|using|to|page|website|site)\s+\S+.*$/i, "")
          .trim();
        if (phrase) return phrase.slice(0, 50);
      }
      const stripped = t
        .replace(/^(please|i need to|can you|go to)\s+/i, "")
        .replace(/\s+(so that|and|please).*$/i, "")
        .trim();
      return stripped.slice(0, 40);
    }

    async function executeActionOnActiveTab(action: AgentAction): Promise<string> {
      const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab?.id) throw new Error("no active tab to auto-type into");
      return (await browser.tabs.sendMessage(tab.id, {
        type: "execute-action",
        action,
      } satisfies ExecuteActionMsg)) as string;
    }

    async function tryAutoType(
      action: AgentAction,
      task: string,
      history: HistoryStep[],
      subgoal: string,
      warnings: string[],
    ): Promise<boolean> {
      if (action.type !== "click" || !isKnownTypeable(action.target)) return false;
      const phrase = deriveTypePhrase(task);
      if (!phrase) return false;
      const typeableId = action.target;
      await log(
        "error",
        `Recovering — VLM keeps clicking the text field #${typeableId} without typing. Auto-typing "${phrase}"…`,
      );
      try {
        const typeNote = await executeActionOnActiveTab({
          type: "type",
          target: typeableId,
          text: phrase,
        });
        // The small model almost never submits on its own after typing — press
        // Enter deterministically (executor's press-Enter path requestSubmit()s
        // the enclosing form, which IS a real submission).
        let pressNote = "";
        try {
          pressNote = await executeActionOnActiveTab({ type: "press", key: "enter" });
        } catch {
          // conventional fields without a tabbable default — harmless.
        }
        const note = [typeNote, pressNote && `then ${pressNote}`].filter(Boolean).join("; ");
        history.push({
          action: { type: "type", target: typeableId, text: phrase },
          result: note,
          subgoal,
          blocked: false,
        });
        recentActions.length = 0;
        consecutiveBlocked = 0;
        noProgressSteps = 0;
        lastClickTypeableId = null;
        lastActionType = "type";
        pushWarning(
          warnings,
          `While stuck you auto-typed "${phrase}" into <field> #${typeableId} and pressed Enter — a search/submit should have happened. Continue from the results.`,
        );
        return true;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        pushWarning(
          warnings,
          `Auto-typed into target #${typeableId} failed: ${errMsg.slice(0, 80)}. Do NOT re-click it.`,
        );
        return false;
      }
    }

    await log(
      "info",
      `Adaptive loop started (budget ${MAX_STEPS} steps; auto-recovers when stuck or blocked)`,
    );
    await status(0);
    thinkBuf = "";

    for (let step = 0; step < MAX_STEPS; step++) {
      if (loopAbort) {
        await log("info", `Loop stopped by user at step ${step}.`);
        break;
      }

      await status(step + 1);

      try {
        const { ok, done, result, action, subgoal, blocked, domFingerprint } = await executeStep(
          task,
          history,
          step + 1,
          "act",
          warnings,
        );

        if (ok && result && action) {
          history.push({ action, result, subgoal, blocked });
          consecutiveFailures = 0;

          if (blocked) consecutiveBlocked++;
          else consecutiveBlocked = 0;

          // No-progress detection: the DOM hasn't changed in N steps even
          // though actions "succeeded" — e.g. clicking a search button that
          // doesn't navigate.
          if (domFingerprint) {
            if (domFingerprint === lastFingerprint) noProgressSteps++;
            else {
              lastFingerprint = domFingerprint;
              noProgressSteps = 0;
            }
          }

          // ── Learner: a previously-failed type target just succeeded →
          //    verify the lesson and persist it across runs for this site.
          if (pendingLesson) {
            await writeLesson(pendingLesson.host, pendingLesson.text);
            await log("info", `Learned: ${pendingLesson.text}`);
            pendingLesson = null;
          }

          // ── Learner: the executor auto-descended to the real input —
          //    the VLM picked a non-typeable wrapper, store the correction.
          const descMatch = /auto-descended from (\S+)/.exec(result);
          if (descMatch) {
            const hostNow = await getHost();
            const text =
              `On ${hostNow}, a 'type' action must target the actual <input>/<textarea>/` +
              `<select> — ${descMatch[1]} could not receive text, so the inner input was used.`;
            await writeLesson(hostNow, text);
            await log("info", `Learned: ${text}`);
          }

          // Stuck detection — same action repeated N times, or the page hasn't
          // changed in N steps. Either way we don't stop; we force a rethink.
          //
          // ── "forgot to type" guard — deterministic, from the executor: if the
          //    VLM clicked a real text field (input/textarea/select) and then
          //    clicks the SAME field again without ever typing, a click alone
          //    does nothing. Catch it on the SECOND repeat with an explicit
          //    "type now" hint instead of waiting for the generic 3x recovery.
          let forgotToType = false;
          if (action.type === "click" && isKnownTypeable(action.target)) {
            if (lastClickTypeableId === action.target && lastActionType === "click") {
              forgotToType = true;
            }
            lastClickTypeableId = action.target;
          }
          lastActionType = action.type;
          if (action.type === "type") lastClickTypeableId = null;

          const actionStr = JSON.stringify(action);
          recentActions.push(actionStr);
          if (recentActions.length > STUCK_REPEAT) recentActions.shift();
          const stuckOnSame =
            recentActions.length >= STUCK_REPEAT &&
            recentActions.every((a) => a === recentActions[0]);
          const noProgress = noProgressSteps >= 4;

          if (done) {
            const answer = action.type === "done" && action.answer ? ` Answer: ${action.answer}` : "";
            await log("success", `Task complete at step ${step + 1}.${answer}`);
            break;
          }

          if (forgotToType) {
            const typeableId = action.type === "click" ? action.target : -1;
            if (
              typeableId >= 0 &&
              (await tryAutoType(action, task, history, subgoal, warnings))
            ) {
              await log("info", `Waiting 750ms before next step…`);
              await new Promise((r) => setTimeout(r, THROTTLE_MS));
              continue;
            }
            await log(
              "error",
              `Recovering — clicked the text field target #${typeableId} twice without typing. Steering toward a 'type' action…`,
            );
            pushWarning(
              warnings,
              `You clicked the text field ${describeKnownTypeable(typeableId)} (target #${typeableId}) but never typed into it — a click alone does nothing there. ` +
                `Your very next action MUST be {"type","target":${typeableId},"text":"<a short phrase from the task>"} into that same field.`,
            );
            lastClickTypeableId = null;
            lastActionType = null;
          } else if (stuckOnSame) {
            if (await tryAutoType(action, task, history, subgoal, warnings)) {
              await log("info", `Waiting 750ms before next step…`);
              await new Promise((r) => setTimeout(r, THROTTLE_MS));
              continue;
            }
            await log(
              "error",
              `Recovering — same action ${STUCK_REPEAT} times in a row (${actionStr}). Asking for a different plan…`,
            );
            pushWarning(
              warnings,
              `You already fired ${actionStr} ${STUCK_REPEAT} times in a row and it did NOT complete the task. Pick a different target/element — never use this exact action again.`,
            );
          } else if (noProgress) {
            if (await tryAutoType(action, task, history, subgoal, warnings)) {
              await log("info", `Waiting 750ms before next step…`);
              await new Promise((r) => setTimeout(r, THROTTLE_MS));
              continue;
            }
            await log(
              "error",
              `Recovering — page unchanged for ${noProgressSteps} steps (last: ${actionStr}). Asking for a different plan…`,
            );
            pushWarning(
              warnings,
              `The page did not change after ${actionStr}. A different element or approach is needed — never just re-fire it.`,
            );
          } else if (consecutiveBlocked >= MAX_CONSECUTIVE_BLOCKED) {
            await log(
              "error",
              `Recovering — ${MAX_CONSECUTIVE_BLOCKED} consecutive blocked steps (last: ${actionStr}). Asking for a different plan…`,
            );
            pushWarning(
              warnings,
              `${actionStr} was blocked ${MAX_CONSECUTIVE_BLOCKED} times in a row. Choose a different strategy (new URL, different element, search instead).`,
            );
          } else {
            // Normal step — nothing to recover from.
            if (step < MAX_STEPS - 1 && !loopAbort) {
              await log("info", `Waiting 750ms before next step…`);
              await new Promise((r) => setTimeout(r, THROTTLE_MS));
            }
            continue;
          }

          // Recovery path — the model must come back with a REAL new plan.
          rethinks++;
          if (rethinks > MAX_RETHINK_ATTEMPTS) {
            await log(
              "error",
              `Recovery fired ${MAX_RETHINK_ATTEMPTS} times without completing the task — stopping.`,
            );
            break;
          }
          const rethinkAction = await runRethink(task, history, step + 1, warnings);
          // A recovery only "worked" if it produced a concrete, non-repeated
          // action. A bare wait, or another instance of a warned/stuck action,
          // counts as NO progress and keeps the stuck signal alive.
          const rethinkStr = rethinkAction ? JSON.stringify(rethinkAction) : "";
          const repeatsWarned =
            rethinkAction && warnings.some((w) => w.includes(rethinkStr));
          const realNewPlan =
            rethinkAction && rethinkAction.type !== "wait" && !repeatsWarned;
          if (realNewPlan) {
            recentActions.length = 0;
            consecutiveBlocked = 0;
            noProgressSteps = 0;
          } else {
            pushWarning(
              warnings,
              rethinkAction
                ? `The model proposed ${rethinkStr} to recover but it is already known to fail or is not a real plan. Next step it MUST navigate or click a NEW target.`
                : `The recovery step produced no action. Next step it MUST navigate or click a concrete NEW target.`,
            );
          }
        }
      } catch (err) {
        consecutiveFailures++;
        const errMsg = err instanceof Error ? err.message : String(err);
        await log("error", `Step ${step + 1} failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${errMsg}`);
        const failedAction = (err as Error & { agentAction?: AgentAction }).agentAction;

        // ── Within-run feedback: the model must SEE its mistake next step.
        if (failedAction) {
          history.push({ action: failedAction, result: `ERROR: ${errMsg}`, blocked: true });
          await log("info", `Fed failure back to context: ${JSON.stringify(failedAction)} → ${errMsg}`);
          // ── Memory: never retry this exact action again in this run.
          pushWarning(
            warnings,
            `${JSON.stringify(failedAction)} FAILED with error: ${errMsg.slice(0, 80)}. Do NOT repeat this action.`,
          );
        }

        // ── Learner: an untypeable target was chosen — stage a lesson that
        //    becomes durable only if the NEXT step on this host succeeds.
        const typeFail = /type failed: (.+?) is not typeable/.exec(errMsg);
        if (typeFail) {
          const hostNow = await getHost();
          pendingLesson = {
            host: hostNow,
            text: `On ${hostNow}, a 'type' action must target the real <input>/<textarea>/<select> directly — ${typeFail[1]} is not typeable.`,
          };
        }

        // ── Adaptive: don't hard-stop on failures — ask for a new approach.
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          rethinks++;
          if (rethinks > MAX_RETHINK_ATTEMPTS) {
            await log(
              "error",
              `Recovery fired ${MAX_RETHINK_ATTEMPTS} times without completing the task — stopping.`,
            );
            break;
          }
          await log("error", `Recovering after ${MAX_CONSECUTIVE_FAILURES} failures — asking for a different plan…`);
          const rethinkAction = await runRethink(task, history, step + 1, warnings);
          const rethinkStr = rethinkAction ? JSON.stringify(rethinkAction) : "";
          const realNewPlan =
            rethinkAction &&
            rethinkAction.type !== "wait" &&
            !warnings.some((w) => w.includes(rethinkStr));
          if (realNewPlan) {
            recentActions.length = 0;
            noProgressSteps = 0;
          }
        }
      }

      // Throttle — respect Chrome's captureVisibleTab rate limit
      if (step < MAX_STEPS - 1 && !loopAbort) {
        await log("info", `Waiting 750ms before next step…`);
        await new Promise((r) => setTimeout(r, THROTTLE_MS));
      }
    }

    loopRunning = false;
    await status(0);
    await log("info", "Loop finished.");
  }
});
