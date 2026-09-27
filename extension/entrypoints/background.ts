// Background service worker — the agent orchestrator.
// Runs the capture → serialize → sanitize → /act → execute loop
// with ≥700 ms throttle (captureVisibleTab is rate-limited to ~2/sec in Chrome).

import { getServerUrl } from "@/core/config";
import { sanitizeForUpload, type VisionFindings } from "@/core/sanitizer";
import { assertNoLeaks } from "@/core/zero-leak";
import {
  initVisionHost,
  handleVisionHostRequest,
  type VisionHostRequest,
} from "@/core/vision-host";
import { isSensitivePage } from "@/core/sensitive-pages";
import { resetVerifiedTargets, getVerifiedTargets, resetClickedTypeables, isKnownTypeable, describeKnownTypeable } from "@/core/executor";
import type {
  AgentAction,
  AgentStage,
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

// A content-script listener (or its message channel) torn down mid-flight —
// Chrome's signature for sendMessage crossing a navigating/reloading document.
// These are RACES, not action failures: right after a navigate/reload the page
// can still be settling, so we retry instead of poisoning lesson memory.
const LISTENER_REJECT = /listener['’]s promise rejected|message channel closed|Receiving end does not exist|Could not establish connection/i;
/** Cap on redaction records mirrored to the side-panel exhibit (per step). */
const REDACTIONS_PANEL_CAP = 60;
const DEFAULT_MODEL = "qwen2.5vl:3b";
const STORAGE_MODEL = "sihModel";
const STORAGE_LESSONS = "sihLessons";
const STORAGE_MAX_STEPS = "sihMaxSteps";
const STORAGE_SHOT_QUALITY = "sihShotQuality";
const STORAGE_CONFIRM = "sihConfirmRisky";

// How long a human-in-the-loop question stays open before the loop auto-skips.
// Short enough that an unattended run never looks frozen; long enough that a
// watching user can answer. Answering in the panel/banner resolves instantly.
const ASK_TIMEOUT_MS = 25000;
const DEFAULT_MAX_STEPS = 50;
const DEFAULT_SHOT_QUALITY = 50;
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
    closeDocument?: () => Promise<void>;
  };
}
const chromeApi = (globalThis as unknown as { chrome?: ChromeOffscreenApi }).chrome;

async function ensureVisionHost(): Promise<void> {
  if (!chromeApi?.offscreen) {
    // Firefox MV2: no offscreen document exists — the background page is a real
    // DOM page and runs the shared vision host IN-PROCESS (see visionHostRequest).
    return;
  }
  // A wedged offscreen doc (created but stopped answering — e.g. the MediaPipe
  // WASM thread pool deadlocked the page) is worse than none: every request
  // would burn its full timeout against the corpse. Recreate the document once
  // per recovery attempt so a dead host is replaced instead of re-used.
  if (visionHostTimedOut && chromeApi.offscreen.closeDocument) {
    try {
      await chromeApi.offscreen.closeDocument();
    } catch {
      /* already closed — fine */
    }
    visionHostTimedOut = false;
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

// Firefox MV2 host: the background page itself computes the vision passes, so
// requests never cross the message bus. Model base resolution needs getURL(),
// which is only available in a live extension context — set it lazily on first
// request (the offscreen doc does the equivalent in its own entrypoint).
let localVisionHostReady = false;
function ensureLocalVisionHost(): void {
  if (localVisionHostReady) return;
  initVisionHost(
    (p) => (browser.runtime.getURL as (path: string) => string)(p),
  );
  localVisionHostReady = true;
}

async function visionHostRequest<T>(msg: Record<string, unknown>, timeoutMs = 90000): Promise<T> {
  if (!chromeApi?.offscreen) {
    // Firefox: compute in-process. A watchdog still guards a hung model load.
    ensureLocalVisionHost();
    return (await withTimeout(
      handleVisionHostRequest({ ...msg, requestId: ++visionReqSeq } as unknown as VisionHostRequest),
      timeoutMs,
      "vision host timeout",
    )) as T;
  }
  await ensureVisionHost();
  const requestId = ++visionReqSeq;
  const expected = `${msg.type}-result`;
  return await new Promise<T>((resolve, reject) => {
    const listener = (raw: unknown) => {
      const m = raw as { type?: string; requestId?: number; error?: string };
      if (m?.type !== expected || m?.requestId !== requestId) return;
      cleanup();
      if (m.error) {
        visionHostTimedOut = false;
        reject(new Error(m.error));
      } else {
        visionHostTimedOut = false;
        resolve(m as T);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      // Host existing-but-silent: mark it so the NEXT ensureVisionHost() call
      // recreates the document instead of trusting a wedged corpse.
      visionHostTimedOut = true;
      reject(new Error(`vision host (${msg.type}) did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
    // MV3 keep-alive gotcha: plain setTimeout/setInterval are NOT counted as
    // service-worker activity, so after ~30s of idle await Chrome suspends the
    // worker — killing this pending promise (and with it the whole step) while
    // a cold model load (60-90s) is still running. Poke a real extension API
    // on a 12s cadence until the request settles to hold the worker open.
    const keepAliveTimer = setInterval(() => {
      browser.runtime
        .getPlatformInfo()
        .then(() => {})
        .catch(() => {});
    }, 12_000);
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(keepAliveTimer);
      chromeApi!.runtime.onMessage.removeListener(listener);
    };
    chromeApi!.runtime.onMessage.addListener(listener);
    chromeApi!.runtime
      .sendMessage({ ...msg, requestId })
      .catch((e) => {
        cleanup();
        // Send failed → the doc is absent/unreachable; next ensure recreates it.
        visionHostTimedOut = true;
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

// Fail-fast on-device vision degradation (Phase 2). When a vision request can't
// complete — models still cold-loading (60-90s on a laptop) or the offscreen doc
// unreachable — we must NOT burn a ~40s budget on EVERY step (the previous
// behaviour made each step wait for vision + again for the OCR gate, then
// degrade anyway). After one failure we cool down for a SHORT gap, re-attempt
// the next step, and keep background warm retries landing; as soon as the host
// is ready a later step gets full OCR/face redaction and the zero-leak OCR gate
// again — recovery DURING the run.
//
// The old 3-minute block meant a host that took 60-90s to cold-load never came
// back mid-session, and a warm success racing a step-timeout was stomped by the
// stale down-flag. Now availability is driven purely by a retry gap, so it
// self-corrects: every ~18s we give the host one more in-run attempt.
const VISION_WARM_TIMEOUT_MS = 150_000; // cold load can legitimately take 60-90s+
const VISION_TRY_GAP_MS = 18_000; // min spacing between per-step vision attempts
let visionTryStamp = 0; // last time a vision request was attempted (or its cooldown set)
let visionDownLoggedAt = 0;
// Set when an existing offscreen vision host exists but doesn't answer a request
// within its budget (wedged host). Cleared once the doc is recreated/responds.
let visionHostTimedOut = false;

/** Should the next step attempt on-device vision? (At most 1 attempt per gap.) */
function visionHostAvailable(): boolean {
  return Date.now() - visionTryStamp >= VISION_TRY_GAP_MS;
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
  visionTryStamp = Date.now(); // cooldown — no more attempts until the gap lapses
  if (Date.now() - visionDownLoggedAt > 30_000) {
    visionDownLoggedAt = Date.now();
    void moduleLog(
      "info",
      `${prefix}On-device vision not ready (${err}) — DOM-only redaction; retrying vision on a later step + in the background…`,
    );
  }
}

async function warmVisionModels(retries = 5): Promise<boolean> {
  if (visionWarmStarted) return false;
  visionWarmStarted = true;
  try {
    const r = await visionHostRequest<{ loaded?: boolean }>(
      { type: "vision-warm", imageDataUrl: WARM_IMAGE, imageRegions: [] },
      VISION_WARM_TIMEOUT_MS,
    );
    visionTryStamp = 0; // host ready — make the very next step attempt vision again
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

// ── Cross-browser panel open ─────────────────────────────────────────────
// Chrome uses the side panel; Firefox uses a sidebar_action. Both are guarded
// so neither API's absence can break the other browser.

function openSidePanelSync(): void {
  const b = browser as unknown as {
    sidePanel?: { open: (o: { windowId?: number }) => Promise<void> };
    sidebarAction?: { open: () => Promise<void> | void };
    windows?: { WINDOW_ID_CURRENT: number };
  };
  if (b.sidePanel?.open) {
    void b.sidePanel
      .open({ windowId: b.windows?.WINDOW_ID_CURRENT })
      .catch(() => {});
    return;
  }
  if (b.sidebarAction?.open) {
    void Promise.resolve(b.sidebarAction.open()).catch(() => {});
  }
}

async function openSidePanel(): Promise<void> {
  const b = browser as unknown as {
    sidePanel?: { open: (o: { windowId?: number }) => Promise<void> };
    sidebarAction?: { open: () => Promise<void> | void };
  };
  try {
    if (b.sidebarAction?.open) {
      await Promise.resolve(b.sidebarAction.open());
      return;
    }
    if (b.sidePanel?.open) {
      const win = await browser.windows.getLastFocused({ populate: false });
      if (win?.id) await b.sidePanel.open({ windowId: win.id });
    }
  } catch (err) {
    console.warn("open panel failed:", err);
  }
}

export default defineBackground(() => {
  // Chrome: side panel opens on the toolbar action. Firefox has no sidePanel
  // API — the sidebar_action defined in the manifest is toggled by the browser
  // button, so this is a no-op there (guarded).
  if (browser.sidePanel?.setPanelBehavior) {
    browser.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
  }

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
      // Release a loop waiting on a user question — it observes loopAbort next
      // iteration and exits cleanly instead of hanging forever.
      resolvePendingAsk("");
    }
    if (msg?.type === "cursor-toggle") {
      forwardCursorToggle(msg.enabled);
    }
    if (msg?.type === "open-panel") {
      openAgentPanel();
    }
    // Human-in-the-loop: the user answered / skipped a surfaced question.
    if (msg?.type === "ask-answer") {
      resolvePendingAsk(msg.answer);
    }
    if (msg?.type === "ask-skip") {
      resolvePendingAsk("");
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
    openSidePanelSync();
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
    await openSidePanel();
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

  async function status(step: number, max: number = MAX_STEPS) {
    await browser.runtime
      .sendMessage({
        type: "loop-status",
        running: loopRunning,
        step,
        maxSteps: max,
      } satisfies ExtMessage)
      .catch(() => {});
  }

  // Live phase broadcast → side panel header status + pipeline strip.
  async function stage(s: AgentStage, text?: string) {
    await browser.runtime
      .sendMessage({ type: "agent-stage", stage: s, text } satisfies ExtMessage)
      .catch(() => {});
  }

  function actionLabel(a: AgentAction): string {
    switch (a.type) {
      case "click":
        return `CLICK(#${a.target})`;
      case "type":
        return `TYPE(#${a.target}, "${a.text}")`;
      case "press":
        return `PRESS(${a.key})`;
      case "scroll":
        return `SCROLL(${a.direction})`;
      case "navigate":
        return `NAVIGATE(${a.url})`;
      case "wait":
        return `WAIT(${a.ms}ms)`;
      case "extract":
        return `EXTRACT("${a.text}")`;
      case "done":
        return `DONE${a.answer ? `: "${a.answer}"` : ""}`;
      case "ask":
        return `ASK("${(a.question ?? "").slice(0, 28)}")`;
      default:
        return JSON.stringify(a);
    }
  }

  // ── Human-in-the-loop (ask) ─────────────────────────────────────────────
  // The VLM can pause the loop with an `ask` action (and the deterministic
  // safety gate confirms before irreversible actions). The background surfaces
  // the question to the side panel + page banner, then waits for the user's
  // answer (or a skip) before the loop continues. The answer is fed back into
  // the VLM context as the step result.

  let pendingAskResolve: ((answer: string) => void) | null = null;
  let askSeqCounter = 0;
  const pendingAskTimers: ReturnType<typeof setTimeout>[] = [];

  /** Resolve a pending ask ("" = skipped) from any listener path. */
  function resolvePendingAsk(answer: string): void {
    if (pendingAskResolve) {
      const r = pendingAskResolve;
      pendingAskResolve = null;
      askSeqCounter += 1;
      for (const t of pendingAskTimers.splice(0)) clearTimeout(t);
      hideBanner();
      r(answer);
    }
  }

  /** Fire-and-forget dismiss of the in-page ask banner (active tab only). */
  function hideBanner(): void {
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        const tab = tabs[0];
        if (tab?.id) {
          return browser.tabs.sendMessage(tab.id, { type: "ask-hide" } satisfies ExtMessage).catch(() => {});
        }
      })
      .catch(() => {});
  }

  /** Surface a question and block until the user answers or skips. */
  async function askUser(
    question: string,
    options: string[],
    kind: "decide" | "confirm",
  ): Promise<string> {
    await log(
      "info",
      `❓ Asking you: ${question}${options.length ? ` — ${options.join(" / ")}` : ""}`,
    );
    const answer = await new Promise<string>((resolve) => {
      pendingAskResolve = resolve;
      const askSeq = ++askSeqCounter;
      // Broadcast to the side panel (runtime). Content scripts ignore the
      // viaPanel variant so the banner never appears on every tab.
      browser.runtime
        .sendMessage({ type: "ask-user", question, options, kind, viaPanel: true } satisfies ExtMessage)
        .catch(() => {});
      // Targeted delivery to the ACTIVE tab's banner — the only surface that
      // should show this question on the page.
      browser.tabs
        .query({ active: true, currentWindow: true })
        .then((tabs) => {
          const tab = tabs[0];
          if (tab?.id) {
            return browser.tabs
              .sendMessage(tab.id, { type: "ask-user", question, options, kind } satisfies ExtMessage)
              .catch(() => {});
          }
        })
        .catch(() => {});
      // Safety net: if neither surface is reachable (no panel, no banner),
      // auto-skip after a short grace period so the loop can't stall forever.
      // 25s is long enough for a human watching to answer, short enough that an
      // unattended run never looks frozen for minutes on end. The sequence guard
      // keeps a stale timer from skipping a NEWER question.
      const timer = setTimeout(() => {
        if (askSeq === askSeqCounter) resolvePendingAsk("");
      }, ASK_TIMEOUT_MS);
      pendingAskTimers.push(timer);
    });
    if (answer) {
      await log("success", `👤 You answered: ${answer}`);
    } else {
      await log("info", `⏭ Skipped question — no answer given.`);
    }
    return answer;
  }

  /** Read the persisted "confirm before risky actions" toggle (default on). */
  async function readConfirmEnabled(): Promise<boolean> {
    try {
      const { [STORAGE_CONFIRM]: v } = (await browser.storage.local.get(STORAGE_CONFIRM)) as {
        [STORAGE_CONFIRM]?: boolean;
      };
      return v !== false;
    } catch {
      return true;
    }
  }

  /**
   * Deterministic safety gate — decide whether an action is irreversible /
   * high-risk enough to confirm with the user before executing. Returns the
   * question to ask, or null when the action may proceed without confirmation.
   *
   * Deliberately NARROW: only task-complete (`done`) and navigating off-site.
   * Pressing Enter is how the agent drives almost every flow (form submit,
   * search, dialog accept) — gating every Enter makes the loop constantly
   * stall on a human prompt, which reads as "the agent is frozen". The leave-
   * and-finish moments are the only ones worth an explicit Proceed/Cancel.
   */
  async function confirmQuestion(
    action: AgentAction,
    pageUrl: string | undefined,
  ): Promise<{ question: string } | null> {
    if (action.type === "done") {
      return { question: `Mark the task as complete and stop?` };
    }
    if (action.type === "navigate") {
      let leaving = true;
      try {
        const cur = new URL(pageUrl ?? "");
        const next = new URL(action.url, pageUrl);
        leaving = next.origin !== cur.origin;
      } catch {
        leaving = true;
      }
      if (leaving) {
        return { question: `Navigate to ${action.url}? (leaving the current site)` };
      }
    }
    return null;
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

  async function readMaxSteps(): Promise<number> {
    try {
      const { [STORAGE_MAX_STEPS]: v } = (await browser.storage.local.get(STORAGE_MAX_STEPS)) as {
        [STORAGE_MAX_STEPS]?: number;
      };
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 && n <= 200 ? Math.floor(n) : DEFAULT_MAX_STEPS;
    } catch {
      return DEFAULT_MAX_STEPS;
    }
  }

  async function readShotQuality(): Promise<number> {
    try {
      const { [STORAGE_SHOT_QUALITY]: v } = (await browser.storage.local.get(
        STORAGE_SHOT_QUALITY,
      )) as { [STORAGE_SHOT_QUALITY]?: number };
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 && n <= 100 ? Math.floor(n) : DEFAULT_SHOT_QUALITY;
    } catch {
      return DEFAULT_SHOT_QUALITY;
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
    const base = await getServerUrl();
    try {
      const res = await fetch(`${base}${streamPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) throw new Error(`Server responded ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // MV3 keep-alive: same suspension risk while streaming from a cold/slow
      // VLM. Poke a real API on a 12s cadence until the stream settles.
      const keepAliveTimer = setInterval(() => {
        browser.runtime
          .getPlatformInfo()
          .then(() => {})
          .catch(() => {});
      }, 12_000);
      try {
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
      } finally {
        clearInterval(keepAliveTimer);
      }
    } catch (err) {
      // Fallback: classic non-streamed POST (kept for robustness).
      const res = await fetch(`${base}${postPath}`, {
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
    await stage("capturing", `Capturing "${tab.title}"…`);
    await log("info", `${prefix}Capturing screenshot of "${tab.title}"…`);
    const sinceCapture = Date.now() - lastCaptureAt;
    if (sinceCapture < CAPTURE_MIN_GAP_MS) {
      await new Promise((r) => setTimeout(r, CAPTURE_MIN_GAP_MS - sinceCapture));
    }
    // Hide the agent cursor first so it never appears in the VLM's screenshot.
    await browser.tabs
      .sendMessage(tab.id, { type: "cursor-hide" } satisfies ExtMessage)
      .catch(() => {});
    lastCaptureAt = Date.now();
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: await readShotQuality(),
    });
    await browser.tabs
      .sendMessage(tab.id, { type: "cursor-show" } satisfies ExtMessage)
      .catch(() => {});
    const kb = Math.round(
      (dataUrl.replace(/^data:image\/\w+;base64,/, "").length * 3) / 4 / 1024,
    );
    await log("info", `${prefix}Screenshot captured (${kb} KB)`);

    // 2) Serialize DOM — inject content script if not already present. Retried a
    //    few times with widening delays: right after a navigate/reload the
    //    document is mid-load and the listener can be absent or reject while an
    //    SPA re-renders. A bounded retry absorbs that transient instead of
    //    failing the whole step (steps 9/10 in the field regression did exactly this).
    let dom: DomElement[] = [];
    let proseRedactions = [];
    let imageRegions: [number, number, number, number][] = [];
    let serializeErr = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await browser.tabs.sendMessage(tab.id, { type: "serialize-dom" });
        dom = Array.isArray(res?.dom) ? res.dom : [];
        proseRedactions = Array.isArray(res?.proseRedactions) ? res.proseRedactions : [];
        imageRegions = Array.isArray(res?.imageRegions) ? res.imageRegions : [];
        break;
      } catch (err) {
        serializeErr = err instanceof Error ? err.message : String(err);
        if (attempt === 1) {
          await log("info", `${prefix}Injecting content script…`);
          try {
            await (browser as any).scripting.executeScript({
              target: { tabId: tab.id },
              files: ["content-scripts/content.js"],
            });
          } catch {
            /* already injected or page still loading */
          }
        }
        // Widening backoff so an mid-load SPA gets time to settle its listeners.
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
    if (dom.length === 0) {
      const friendly = LISTENER_REJECT.test(serializeErr)
        ? "the page was still loading or navigating (content-script listener rejected while the page changed)"
        : serializeErr;
      await log("error", `${prefix}DOM serialize failed: ${friendly}`);
      throw new Error(
        `DOM serialization failed (${friendly}) — cannot proceed without a DOM snapshot (privacy gate requires it).`,
      );
    }
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

    // 3) Sanitize + SoM overlay (the privacy gate)
    await stage("sanitizing", "Protecting your data before anything leaves this device…");
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
    const VISION_STEP_TIMEOUT_MS = 40000;
    let vision: VisionFindings | undefined;
    if (visionHostAvailable()) {
      try {
        const hasImages = (imageRegions?.length ?? 0) > 0;
        await log("info", `${prefix}Running on-device vision (face + OCR)…`);
        const tVision = Date.now();
        const vr = await withTimeout(
visionHostRequest<{
              result: VisionFindings | null;
            }>({ type: "vision-run", imageDataUrl: dataUrl, imageRegions, pageUrl: tab?.url }),
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
          const perc = vision.perception;
          const percMs = perc?.ms ? `, perception ${perc.ms}ms` : "";
          const percTags = perc?.enabled
            ? ` [${Object.entries(perc.summary).map(([t, n]) => `${t}:${n}`).join(" ")}]`
            : "";
          await log(
            "info",
            `${prefix}Vision: ${vision.faces.length} face(s) blurred, ${vision.ocr.length} OCR PII hit(s)${percMs}${percTags}`,
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
    // zeroLeak summarises the gate outcome for the side panel privacy card.
    await stage("verifying", "Running zero-leak verification on the sanitized payload…");
    let zeroLeak: boolean | null = imageRegions.length === 0;
    if (imageRegions.length > 0 && visionHostAvailable()) {
      const tGate = Date.now();
      await log("info", `${prefix}Running zero-leak OCR gate on sanitized image…`);
      let gate: { gate?: { pass: boolean; hits: { type: string; value: string }[]; error?: string } };
      try {
        gate = await withTimeout(
          visionHostRequest<{
            gate: { pass: boolean; hits: { type: string; value: string }[]; error?: string };
          }>({ type: "zero-leak-ocr", imageDataUrl: `data:${payload.imageMime};base64,` + payload.screenshot_b64 }),
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
      zeroLeak = true;
      const gateDur = Math.round((Date.now() - tGate) / 100) / 10;
      await log("info", `${prefix}Zero-leak gate done in ${gateDur}s`);
    } else if (imageRegions.length > 0) {
      zeroLeak = null;
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

    // Structured privacy summary → hero card (all device-local metrics).
    const typeCounts = new Map<string, number>();
    for (const r of payload.redactions) {
      const k = r.source === "vision" ? "image" : r.type;
      typeCounts.set(k, (typeCounts.get(k) ?? 0) + 1);
    }
    const faces = Array.isArray(vision?.faces) ? vision.faces.length : 0;

    // Stable-token map for the hero card (masked value → [TOKEN_n]). Built
    // from the on-device redaction log; only the masked form reaches this panel.
    const seenTokens = new Set<string>();
    const tokens: { type: string; masked: string; token: string }[] = [];
    for (const r of payload.redactions) {
      if (r.token && r.masked && !seenTokens.has(r.token)) {
        seenTokens.add(r.token);
        tokens.push({ type: r.type, masked: r.masked, token: r.token });
      }
    }

    // Before/after proof — the ORIGINAL capture renders only inside this
    // extension panel (never uploaded); the sanitized one is what the VLM sees.
    const sanitizedPreview = `data:${payload.imageMime};base64,` + payload.screenshot_b64;
    const payloadKb = Math.round(
      (payload.screenshot_b64.length * 3) / 4 / 1024,
    );
    await browser.runtime
      .sendMessage({
        type: "capture-preview",
        original: dataUrl,
        sanitized: sanitizedPreview,
        payloadKb,
        protected: payload.redactions?.length ?? 0,
      } satisfies ExtMessage)
      .catch(() => {});

    await browser.runtime
      .sendMessage({
        type: "privacy",
        detected: (payload.redactions?.length ?? 0) + faces,
        redacted: payload.redactions?.length ?? 0,
        faces,
        facesBlurred: faces,
        zeroLeak,
        gate: zeroLeak === true ? "pass" : zeroLeak === null ? "skip" : "block",
        rawValuesSent: 0,
        byType: [...typeCounts.entries()].map(([type, count]) => ({ type, count })),
        tokens,
        // On-device ViT screen-perception summary for the privacy card.
        perception: vision?.perception && vision.perception.enabled
          ? {
              enabled: true,
              ms: vision.perception.ms,
              summary: vision.perception.summary,
              escalate: vision.perception.decisions.escalate.length,
              backend: vision.perception.backend,
            }
          : { enabled: false, ms: 0, summary: {}, escalate: 0 },
        // Per-region audit log for the interactive exhibit. Device-local only
        // (this message never crosses the network); masked form, never raw.
        redactions: (payload.redactions ?? [])
          .slice(0, REDACTIONS_PANEL_CAP)
          .map((r) => ({
            type: r.type,
            tier: r.tier,
            token: r.token,
            bbox: r.bbox,
            source: r.source,
            masked: r.masked,
          })),
      } satisfies ExtMessage)
      .catch(() => {});

    // 4) Send to server (streamed so we relay the model's thinking live)
    const label = mode === "rethink" ? "Asking for an alternative plan" : "Sending to VLM";
    await log("info", `${prefix}${label} (${body.dom.length} DOM elements, ${kb} KB screenshot)…`);
    await stage("reasoning", `Reasoning over ${body.dom.length} sanitized elements…`);
    browser.runtime.sendMessage({ type: "think-start" }).catch(() => {});
    const data = await callActStream(body, (delta) => {
      thinkBuf += delta;
      if (!thinkTimer) thinkTimer = setTimeout(flushThink, 60);
    }, mode);
    flushThink();
    await log("info", `${prefix}🧠 VLM thought: ${data.thought}`);
    browser.runtime.sendMessage({ type: "think-end", thought: data.thought }).catch(() => {});
    // Show the SANITIZED screenshot (what the VLM saw): overlay + redactions.
    await log("info", `${prefix}→ Action: ${JSON.stringify(data.action)}`, sanitizedPreview);
    await stage("acting", "Executing on the page…");

    // Structured decision trace → "Agent decision" card.
    const targetEl = (body.dom ?? []).find(
      (d) => d.id === (data.action as { target?: number }).target,
    );
    await browser.runtime
      .sendMessage({
        type: "decision",
        observed: body.dom.length,
        protected: payload.redactions?.length ?? 0,
        subgoal: data.subgoal,
        thought: data.thought,
        action: actionLabel(data.action),
        target: targetEl
          ? { id: targetEl.id, desc: targetEl.label || targetEl.text?.slice(0, 40) }
          : undefined,
      } satisfies ExtMessage)
      .catch(() => {});

    // 5) Execute action in the tab — unless the agent paused to ask the user.
    //
    // Human-in-the-loop: an `ask` action is NEVER dispatched to the page. The
    // background surfaces it to the side panel + page banner, waits for the
    // user's answer, and returns it as the step result so the VLM continues
    // with the answer in context next step.
    if (data.action.type === "ask") {
      await stage("acting", "Waiting for your input…");
      const answer = await askUser(data.action.question, data.action.options ?? [], "decide");
      await browser.runtime
        .sendMessage({ type: "decision-result", result: answer } satisfies ExtMessage)
        .catch(() => {});
      return {
        ok: true,
        done: false,
        result: answer ? `USER ANSWER: ${answer}` : "USER SKIPPED the question.",
        action: data.action,
        subgoal: data.subgoal,
        blocked: false,
        // Distinct fingerprint: the user's answer changed the decision context,
        // so the no-progress detector must not treat this as a stalled page.
        domFingerprint: `ASK:${data.action.question}`,
      };
    }

    // Deterministic safety confirmation (toggle-gated, default on): before
    // irreversible / high-risk actions — form submit (Enter), task-complete
    // (done), or navigating away to a different origin — ask the user first.
    if (await readConfirmEnabled()) {
      const confirm = await confirmQuestion(data.action, tab.url);
      if (confirm) {
        const answer = await askUser(confirm.question, ["Proceed", "Cancel"], "confirm");
        if (!answer || answer.trim().toLowerCase().startsWith("cancel")) {
          const result = "USER CANCELED: " + actionLabel(data.action);
          await log("error", `${prefix}${result}`);
          pushWarning(
            warnings,
            `The user canceled ${JSON.stringify(data.action)} — do NOT attempt it again; pick a different approach.`,
          );
          await browser.runtime
            .sendMessage({ type: "decision-result", result: "⛔ Canceled by you" } satisfies ExtMessage)
            .catch(() => {});
          return {
            ok: true,
            done: false,
            result,
            action: data.action,
            subgoal: data.subgoal,
            blocked: true,
            domFingerprint: `CANCELED:${data.action.type}`,
          };
        }
        await log("success", `${prefix}Confirmed by user: ${actionLabel(data.action)}`);
      }
    }

    // 6) Execute action in the tab
    await log("info", `${prefix}Executing ${data.action.type}…`);
    let result: string;
    try {
      result = (await browser.tabs.sendMessage(tab.id, {
        type: "execute-action",
        action: data.action,
      } satisfies ExecuteActionMsg)) as string;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      (err as Error & { agentAction?: AgentAction }).agentAction = data.action;
      if (LISTENER_REJECT.test(msg)) {
        // Content-script teardown race — the page navigated/reloaded while the
        // action was being dispatched, so the landing is unknowable and the
        // action very likely never completed. Give the settled page ONE
        // deterministic re-drive before declaring a failure.
        await log(
          "info",
          `${prefix}Page changed mid-execution (${msg}) — retrying ${data.action.type} once on the settled page…`,
        );
        await new Promise((r) => setTimeout(r, 1200));
        try {
          result = (await browser.tabs.sendMessage(tab.id, {
            type: "execute-action",
            action: data.action,
          } satisfies ExecuteActionMsg)) as string;
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          (err2 as Error & { agentAction?: AgentAction }).agentAction = data.action;
          // If the SECOND attempt also dies on a torn-down listener, the page is
          // genuinely still settling — flag it transient so the run loop knows
          // this is NOT a bad action (no lesson memory, no stuck-counter poison).
          (err2 as Error & { transient?: boolean }).transient = LISTENER_REJECT.test(msg2);
          throw err2;
        }
      } else {
        throw err;
      }
    }
    await log("success", `${prefix}Done: ${result}`);

    // Post-execution result row for the decision card.
    await browser.runtime
      .sendMessage({ type: "decision-result", result } satisfies ExtMessage)
      .catch(() => {});

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
    const maxSteps = await readMaxSteps();
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
      subgoal: string | undefined,
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
      `Adaptive loop started (budget ${maxSteps} steps; auto-recovers when stuck or blocked)`,
    );
    await status(0, maxSteps);
    thinkBuf = "";

    for (let step = 0; step < maxSteps; step++) {
      if (loopAbort) {
        await log("info", `Loop stopped by user at step ${step}.`);
        break;
      }

      await status(step + 1, maxSteps);

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
            if (step < maxSteps - 1 && !loopAbort) {
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
        const transient = !!(err as Error & { transient?: boolean }).transient;
        await log("error", `Step ${step + 1} failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${errMsg}`);
        const failedAction = (err as Error & { agentAction?: AgentAction }).agentAction;

        // Transient failure: the content script was torn down mid-action by a
        // page navigate/reload. The ACTION was never proven wrong — so clear the
        // failure counter, skip lesson/warning poisoning, and just note the page
        // change for the next step so the model re-plans against the new DOM.
        if (transient) {
          if (failedAction) {
            history.push({
              action: failedAction,
              result: `TRANSIENT: page was navigating/reloading during execution — ${errMsg}.`,
              blocked: false,
            });
            await log(
              "info",
              `Page change during action (no failure counted): ${JSON.stringify(failedAction)} → ${errMsg}`,
            );
          }
          consecutiveFailures = 0;
          continue;
        }

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
      if (step < maxSteps - 1 && !loopAbort) {
        await log("info", `Waiting 750ms before next step…`);
        await new Promise((r) => setTimeout(r, THROTTLE_MS));
      }
    }

    loopRunning = false;
    await status(0, maxSteps);
    await log("info", "Loop finished.");
  }
});
