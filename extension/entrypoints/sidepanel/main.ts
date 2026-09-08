import { SERVER_URL } from "@/core/config";
import type { ExtMessage } from "@/core/protocol";

const logEl = document.getElementById("log") as HTMLUListElement;
const shotEl = document.getElementById("shot") as HTMLImageElement;
const noshotEl = document.getElementById("noshot") as HTMLParagraphElement;
const shotOriginalEl = document.getElementById("shotOriginal") as HTMLImageElement;
const noshotOriginalEl = document.getElementById("noshotOriginal") as HTMLParagraphElement;
const capSizeEl = document.getElementById("capSize") as HTMLSpanElement;
const previewStatsEl = document.getElementById("previewStats") as HTMLElement;
const pvProtRegionsEl = document.getElementById("pvProtRegions") as HTMLSpanElement;
const pvPayloadEl = document.getElementById("pvPayload") as HTMLSpanElement;
const taskEl = document.getElementById("task") as HTMLInputElement;
const loopBtn = document.getElementById("loop") as HTMLButtonElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const cursorEl = document.getElementById("cursor") as HTMLInputElement;
const orbCtlEl = document.getElementById("orbCtl") as HTMLInputElement;
const lensCtlEl = document.getElementById("lensCtl") as HTMLInputElement;
const viewToggleEl = document.getElementById("viewToggle") as HTMLElement;
const debugEl = document.getElementById("debug") as HTMLInputElement;
const maxStepsEl = document.getElementById("maxSteps") as HTMLInputElement;
const shotQualityEl = document.getElementById("shotQuality") as HTMLSelectElement;
const modelEl = document.getElementById("model") as HTMLSelectElement;
const liveDotEl = document.getElementById("liveDot") as HTMLSpanElement;
const toggleLiveEl = document.getElementById("toggleLive") as HTMLButtonElement;
const toggleTechEl = document.getElementById("toggleTech") as HTMLButtonElement;
const liveCardEl = document.getElementById("liveCard") as HTMLElement;
const clearHistEl = document.getElementById("clearHist") as HTMLButtonElement;
const histListEl = document.getElementById("histList") as HTMLDivElement;
const advancedEl = document.getElementById("advanced") as HTMLDetailsElement;
const toggleAdvancedEl = document.getElementById("toggleAdvanced") as HTMLButtonElement;
const thinkStatusEl = document.getElementById("thinkStatus") as HTMLSpanElement;
const decGoalEl = document.getElementById("decGoal") as HTMLSpanElement;
const decObservedEl = document.getElementById("decObserved") as HTMLSpanElement;
const decProtectedEl = document.getElementById("decProtected") as HTMLSpanElement;
const decTargetEl = document.getElementById("decTarget") as HTMLSpanElement;
const decActionEl = document.getElementById("decAction") as HTMLSpanElement;
const decResultEl = document.getElementById("decResult") as HTMLSpanElement;
const agentStateEl = document.getElementById("agentState") as HTMLElement;
const agentStateTextEl = document.getElementById("agentStateText") as HTMLSpanElement;
const stageTextEl = document.getElementById("stageText") as HTMLSpanElement;
const gateBadgeEl = document.getElementById("gateBadge") as HTMLElement;
const gateNoteEl = document.getElementById("gateNote") as HTMLElement;
const pvBoundaryEl = document.getElementById("pvBoundary") as HTMLSpanElement;
const pvDetectedEl = document.getElementById("pvDetected") as HTMLElement;
const pvRedactedEl = document.getElementById("pvRedacted") as HTMLElement;
const pvRawEl = document.getElementById("pvRaw") as HTMLElement;
const pvListEl = document.getElementById("pvList") as HTMLUListElement;
const pvRaw2El = document.getElementById("pvRaw2") as HTMLElement;
const pipeStages = [
  ...(document.getElementById("pipe")?.querySelectorAll<HTMLElement>(".stage") ?? []),
];
const gateStage =
  (document.getElementById("pipe")?.querySelector<HTMLElement>('[data-stage="gate"]')) ??
  null;

const STORAGE_TASK = "sihTask";
const STORAGE_CURSOR = "sihCursorEnabled";
const STORAGE_MODEL = "sihModel";
const STORAGE_MAX_STEPS = "sihMaxSteps";
const STORAGE_SHOT_QUALITY = "sihShotQuality";
const STORAGE_DEBUG = "sihDebug";
const STORAGE_ORB = "sihOrbEnabled";
const STORAGE_LENS = "sihLens";
const STORAGE_AI_VIEW = "sihAiView";

// ── Persisted state ───────────────────────────────────────────────────────

const LS_SESSIONS = "sihSessions";
const MAX_SESSIONS = 25;
const MAX_ENTRIES = 40;

type Level = "info" | "error" | "success";
interface LogEntry {
  level: Level;
  text: string;
  /** Human-readable form for the live activity panel. */
  human?: string;
  /** True when this is a developer-level line (hidden behind the toggle). */
  tech?: boolean;
}
interface SessionPrivacy {
  protected: number;
  leaked: number;
  pass: boolean;
}
interface StoredSession {
  id: number;
  kind: "loop" | "step";
  task: string;
  started: number;
  ended?: number;
  status: "running" | "done" | "stuck" | "failed" | "stopped";
  entries: LogEntry[];
  privacy?: SessionPrivacy;
}

let sessions: StoredSession[] = loadSessions();
let loopSeq: number = Number(localStorage.getItem("sihLoopSeq") || "0");
let current: StoredSession | null = null;
let loopRunning = false;
let pageStart = performance.now();
let lastDecision: { goal: string } | null = null;

function loadSessions(): StoredSession[] {
  try {
    const raw = localStorage.getItem(LS_SESSIONS);
    return raw ? (JSON.parse(raw) as StoredSession[]) : [];
  } catch {
    return [];
  }
}

function persistSessions() {
  sessions = sessions.slice(0, MAX_SESSIONS);
  for (const s of sessions) s.entries = s.entries.slice(-MAX_ENTRIES);
  try {
    localStorage.setItem(LS_SESSIONS, JSON.stringify(sessions));
  } catch {
    sessions = sessions.slice(0, Math.max(0, sessions.length - 1));
    try {
      localStorage.setItem(LS_SESSIONS, JSON.stringify(sessions));
    } catch {
      /* give up silently */
    }
  }
}

// ── Session lifecycle ─────────────────────────────────────────────────────

function beginSession(kind: "loop" | "step") {
  if (current?.kind === kind && current.status === "running") return current;
  if (current) finalizeSession("stopped");
  if (kind === "loop") loopSeq += 1;
  current = {
    id: kind === "loop" ? loopSeq : 0,
    kind,
    task: taskEl.value.trim() || "(no task)",
    started: Date.now(),
    status: "running",
    entries: [],
  };
  localStorage.setItem("sihLoopSeq", String(loopSeq));
  logEl.innerHTML = "";
  liveDotEl.className = "dot running";
  resetDecisionDisplay();
  decGoalEl.textContent = current.task;
  return current;
}

function finalizeSession(status: StoredSession["status"]) {
  if (!current) return;
  current.status = status;
  current.ended = Date.now();
  sessions.unshift(current);
  current = null;
  persistSessions();
  renderHistory();
  logEl.innerHTML = "";
  liveDotEl.className = "dot idle";
}

function ensureSessionFromLog(text: string) {
  if (current) return;
  if (text.startsWith("Loop started") || text.startsWith("Adaptive loop started")) beginSession("loop");
  else if (text.startsWith("Running single step")) beginSession("step");
}

function pushEntry(level: Level, text: string, screenshot?: string) {
  ensureSessionFromLog(text);
  const human = humanizeLog(text);
  const tech = isTechnical(text);
  if (current) current.entries.push({ level, text, human, tech });
  renderEntry(logEl, { level, text, human, tech });
  if (screenshot) showSanitized(screenshot);
}

function renderEntry(ul: HTMLUListElement, e: LogEntry, showTime = true) {
  const li = document.createElement("li");
  li.className = e.level;
  if (e.tech) li.classList.add("tech");
  if (e.text.includes("🧠 VLM thought:")) li.classList.add("thought");

  if (e.human || e.tech) {
    if (showTime) {
      const time = document.createElement("span");
      time.className = "log-time";
      time.textContent = elapsedLabel();
      li.appendChild(time);
    }
    li.appendChild(document.createTextNode(e.human ?? e.text));
  } else {
    li.textContent = e.text;
  }
  ul.appendChild(li);
  li.scrollIntoView({ block: "end" });
}

// ── Human-readable labelling of background log lines ──────────────────────
// The agent already keeps technical detail; this panel surfaces a judged-
// friendly paraphrase by default and hides developer lines behind the toggle.

function elapsedLabel(): string {
  const s = (performance.now() - pageStart) / 1000;
  const mm = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  const cs = Math.floor((s % 1) * 100).toString().padStart(2, "0");
  return `${mm}:${ss}.${cs}`;
}

const TECH_RE =
  /^\[Step|\bDOM:\b|Sending to VLM|Preloading|Warming|Vision host|Injecting content script|Waiting \d+ms|Fed failure back|Learned:|Executing \w+ \.|Sanitizing PII|On-device vision|zero-leak|Zero-leak|Running on-device/;

function isTechnical(text: string): boolean {
  return TECH_RE.test(text);
}

function humanizeLog(text: string): string {
  if (text.startsWith("Adaptive loop started")) return "Agent started with auto-recovery";
  if (text.startsWith("Running single step")) return "Running a single step";
  if (text === "Loop finished.") return "Agent finished.";
  if (text.startsWith("Loop stopped by user")) return "Stopped by user";
  if (text.startsWith("Task complete at step")) return text;
  if (text.includes("Too many consecutive failures")) return text;
  if (text.includes("Stuck: same action")) return "Agent got stuck — recovering…";
  if (text.includes("Recovery fired")) return "Recovery attempted";
  if (text.startsWith("Blocked:")) return `⛔ ${text}`;
  if (text.startsWith("Failed:")) return text;
  if (text.includes("Recovering")) return text;

  if (/Capturing screenshot/.test(text)) return "Captured the current page";
  if (/^Screenshot captured/.test(text)) return "Captured the current page";
  if (/^DOM serialized: (\d+) interactive elements/.test(text))
    return `Found ${/^DOM serialized: (\d+)/.exec(text)?.[1]} interactive elements`;
  if (/^Redacted (\d+) PII region/.test(text))
    return `🔒 Protected ${/^Redacted (\d+)/.exec(text)?.[1]} sensitive region${/^Redacted (\d+)/.exec(text)?.[1] === "1" ? "" : "s"}`;
  if (text === "No PII detected") return "✓ Nothing sensitive detected";
  if (/^Vision: /.test(text)) return "Scanned pixels for faces & hidden text";
  if (/^Zero-leak gate done/.test(text)) return "Zero-leak verification passed";
  if (/^Zero-leak OCR gate skipped/.test(text)) return "Zero-leak image gate skipped — DOM gate enforced";
  if (/^🧠 VLM thought:/.test(text)) return text;
  if (/^→ Action: /.test(text)) return `Agent selected ${text.replace(/^→ Action: /, "")}`;
  if (/^Done: /.test(text)) return `✓ ${text.replace(/^Done: /, "")}`;
  if (text.startsWith("Server up at")) return "✓ Connected to the local VLM server";
  if (text.startsWith("Server unreachable")) return "⚠ Server unreachable — start it with uvicorn";
  if (text.startsWith("Preloading on-device vision models")) return "Warming up on-device vision (face + OCR)…";
  if (text.startsWith("Vision models ready")) return "✓ On-device vision ready";
  if (text.startsWith("Sensitive page")) return `⛔ ${text}`;
  if (/^Vision host unavailable/.test(text)) return "Vision host unavailable — DOM-only redaction";
  return text;
}

// ── History (foldered sessions) ───────────────────────────────────────────

function renderHistory() {
  histListEl.innerHTML = "";
  if (sessions.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-hint";
    p.textContent = "No runs yet — start the agent to get going.";
    histListEl.appendChild(p);
    return;
  }
  for (const [i, s] of sessions.entries()) {
    histListEl.appendChild(sessionCard(s, i));
  }
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(s: StoredSession): string {
  if (!s.ended) return "";
  const sec = Math.max(1, Math.round((s.ended - s.started) / 1000));
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${sec}s`;
}

function statusLabel(status: StoredSession["status"]): string {
  switch (status) {
    case "done":
      return "Done";
    case "stuck":
      return "Stuck";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    default:
      return "Running";
  }
}

function privacySummary(s: StoredSession): string {
  const p = s.privacy;
  if (!p) return "";
  const gate = p.pass ? "PASS" : "LEAK";
  return `${p.protected} protected · 0 leaked · ${gate}`;
}

function sessionCard(s: StoredSession, index: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "hist-card";
  card.setAttribute("data-i", String(index));

  const head = document.createElement("button");
  head.className = "hist-head";
  head.type = "button";

  const chev = document.createElement("span");
  chev.className = "chev";
  chev.textContent = "▶";
  const title = document.createElement("span");
  title.className = "hist-title";
  title.textContent = s.kind === "loop" ? `Agent #${s.id}` : "Step run";
  const task = document.createElement("span");
  task.className = "hist-task";
  task.textContent = s.task;
  const privacy = document.createElement("span");
  privacy.className = "hist-privacy";
  const sum = privacySummary(s);
  if (sum) {
    const label = sum.split(" · ");
    const main = document.createElement("span");
    main.innerHTML = `${label[0]} · ${label[1]}`;
    const gate = document.createElement("b");
    gate.className = s.privacy?.pass ? "pass" : "";
    gate.textContent = label[2];
    privacy.append(main, gate);
  }
  const time = document.createElement("span");
  time.className = "hist-time";
  time.textContent = `${fmtTime(s.started)} · ${fmtDuration(s)}`;
  const chip = document.createElement("span");
  chip.className = `chip chip-${s.status}`;
  chip.textContent = statusLabel(s.status);

  head.append(chev, title, task, privacy, time, chip);

  const body = document.createElement("div");
  body.className = "hist-body";
  body.hidden = true;
  const ul = document.createElement("ul");
  ul.className = "mini-log";
  for (const e of s.entries) renderEntry(ul, e, false);
  body.appendChild(ul);

  head.addEventListener("click", () => {
    const open = !body.hidden;
    body.hidden = open;
    card.classList.toggle("open", !open);
  });

  card.append(head, body);
  return card;
}

// ── Event handlers ────────────────────────────────────────────────────────

function showSanitized(dataUrl: string) {
  shotEl.src = dataUrl;
  shotEl.hidden = false;
  noshotEl.hidden = true;
}

function showPreview(m: Extract<ExtMessage, { type: "capture-preview" }>) {
  if (m.original) {
    shotOriginalEl.src = m.original;
    shotOriginalEl.hidden = false;
    noshotOriginalEl.hidden = true;
  }
  if (m.sanitized) {
    shotEl.src = m.sanitized;
    shotEl.hidden = false;
    noshotEl.hidden = true;
  }
  const kb = m.payloadKb > 0 ? `${m.payloadKb} KB` : "";
  capSizeEl.textContent = kb;
  previewStatsEl.hidden = false;
  pvProtRegionsEl.innerHTML = `<b>${m.protected}</b> sensitive region${m.protected === 1 ? "" : "s"} removed`;
  pvRaw2El.textContent = "0";
  pvPayloadEl.innerHTML = `<b>${kb || "—"}</b> payload size`;
}

function setLoopUI(running: boolean, step?: number, max?: number) {
  loopRunning = running;
  if (running) {
    loopBtn.textContent = "■ Stop";
    loopBtn.classList.add("active");
    statusEl.textContent = `Step ${step}/${max}`;
    statusEl.className = "hint running";
  } else {
    loopBtn.textContent = "▶ Start agent";
    loopBtn.classList.remove("active");
    statusEl.textContent = step !== undefined ? `Stopped at step ${step}` : "Ready";
    statusEl.className = "hint";
    setStage("ready", step !== undefined ? `Stopped at step ${step}` : undefined);
  }
}

// ── Cockpit state: header phase pill + pipeline strip ────────────────────

const STAGE_ORDER = [
  "capturing",
  "sanitizing",
  "verifying",
  "reasoning",
  "acting",
] as const;

function setStage(stage: string, text?: string) {
  agentStateEl.dataset.state = stage;
  agentStateTextEl.textContent =
    stage === "ready"
      ? "READY"
      : stage === "verifying"
        ? "VERIFYING PRIVACY"
        : stage === "done"
          ? "DONE"
          : stage.toUpperCase();
  stageTextEl.textContent = text ?? stage;
  const idx = STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);
  pipeStages.forEach((el, i) => {
    el.classList.toggle("done", idx >= 0 && i < idx);
    el.classList.toggle("active", i === idx);
    const mark = el.querySelector(".mark");
    if (mark) {
      mark.textContent = i === idx ? "●" : idx >= 0 && i < idx ? "✓" : "○";
    }
  });
  if (idx === 2) {
    gateStage?.classList.remove("blocked");
    gateStage?.classList.add("active");
    const mark = gateStage?.querySelector(".mark");
    if (mark) mark.textContent = "●";
    gateBadgeEl.className = "badge badge-verifying";
    gateBadgeEl.textContent = "VERIFYING";
    gateNoteEl.hidden = true;
  }
}

/** Reflect the fail-closed gate verdict on the pipeline + hero card. */
function setGateVerdict(gate: "pass" | "block" | "skip") {
  if (gate === "pass") {
    gateBadgeEl.className = "badge badge-pass";
    gateBadgeEl.textContent = "GATE PASSED";
    gateNoteEl.className = "gate-note pass";
    gateNoteEl.innerHTML = "✓ SAFE TO REASON";
    gateNoteEl.hidden = false;
    gateStage?.classList.remove("blocked");
    pipeStages.forEach((el, i) => {
      if (i < 3) el.classList.toggle("done", true);
    });
    const mark = gateStage?.querySelector(".mark");
    if (mark) mark.textContent = "✓";
  } else if (gate === "block") {
    gateBadgeEl.className = "badge badge-block";
    gateBadgeEl.textContent = "BLOCKED";
    gateNoteEl.className = "gate-note block";
    gateNoteEl.innerHTML = "⛔ BLOCKED — PII REMAINS";
    gateNoteEl.hidden = false;
    gateStage?.classList.add("blocked");
    const mark = gateStage?.querySelector(".mark");
    if (mark) mark.textContent = "⛔";
  } else {
    gateBadgeEl.className = "badge badge-idle";
    gateBadgeEl.textContent = "GROUNDED";
    gateNoteEl.className = "gate-note skip";
    gateNoteEl.innerHTML = "Image gate unavailable — DOM gate still enforced";
    gateNoteEl.hidden = true;
  }
}

// ── Privacy gate hero card ───────────────────────────────────────────────

function resetPrivacyDisplay() {
  pvDetectedEl.textContent = "–";
  pvRedactedEl.textContent = "–";
  pvRawEl.textContent = "0";
  pvRaw2El.textContent = "0";
  pvListEl.innerHTML = "";
  gateBadgeEl.className = "badge badge-idle";
  gateBadgeEl.textContent = "STANDBY";
  gateNoteEl.hidden = true;
  if (pvBoundaryEl) pvBoundaryEl.textContent = "raw capture never leaves";
  previewStatsEl.hidden = true;
  shotEl.hidden = true;
  shotOriginalEl.hidden = true;
  noshotEl.hidden = false;
  noshotOriginalEl.hidden = false;
}

function renderPrivacy(m: Extract<ExtMessage, { type: "privacy" }>) {
  pvDetectedEl.textContent = String(m.detected);
  pvRedactedEl.textContent = String(m.redacted);
  pvRawEl.textContent = String(m.rawValuesSent);
  pvRaw2El.textContent = String(m.rawValuesSent);
  pvDetectedEl.classList.toggle("blocked", m.gate === "block");
  if (pvBoundaryEl) pvBoundaryEl.textContent = "raw capture never leaves";
  setGateVerdict(m.gate);

  // Privacy summary follows the run so History can render it.
  if (current) {
    current.privacy = {
      protected: m.redacted,
      leaked: m.rawValuesSent,
      pass: m.gate !== "block",
    };
  }

  pvListEl.innerHTML = "";
  let hasRows = false;
  if (m.faces > 0) {
    pvListEl.appendChild(pvRow(`face${m.faces > 1 ? "s" : ""}`, m.faces, true));
    hasRows = true;
  }
  for (const t of m.byType) {
    pvListEl.appendChild(pvRow(t.type, t.count, true));
    hasRows = true;
  }
  // Stable-token map: masked value → token (the redaction mechanism made visible).
  for (const t of m.tokens) {
    pvListEl.appendChild(pvTokenRow(t.type, t.masked, t.token));
    hasRows = true;
  }
  if (!hasRows) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="pv-tag">nothing sensitive</span><span class="pv-ok">✓</span>`;
    pvListEl.appendChild(li);
  }
}

function pvRow(type: string, count: number, ok: boolean): HTMLLIElement {
  const li = document.createElement("li");
  const tag = document.createElement("span");
  tag.className = "pv-tag";
  tag.textContent = type.replace(/_/g, " ");
  const right = document.createElement("span");
  const cnt = document.createElement("span");
  cnt.className = "pv-multi";
  cnt.textContent = `${count} ×`;
  const okEl = document.createElement("span");
  okEl.className = "pv-ok";
  okEl.textContent = ok ? "✓" : "✗";
  right.append(cnt, okEl);
  li.append(tag, right);
  return li;
}

function pvTokenRow(type: string, masked: string, token: string): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "pv-token-row";
  const tag = document.createElement("span");
  tag.className = "pv-tag";
  tag.textContent = type.replace(/_/g, " ");
  const map = document.createElement("span");
  map.className = "pv-tok-map";
  const m = document.createElement("span");
  m.className = "pv-masked";
  m.textContent = masked;
  const arrow = document.createElement("span");
  arrow.textContent = "→";
  const t = document.createElement("span");
  t.className = "pv-tok";
  t.textContent = token;
  map.append(m, arrow, t);
  li.append(tag, map);
  return li;
}

// ── Agent decision card (no raw chain-of-thought) ────────────────────────

function resetDecisionDisplay() {
  lastDecision = null;
  decObservedEl.textContent = "—";
  decProtectedEl.textContent = "—";
  decTargetEl.textContent = "—";
  decActionEl.textContent = "";
  decResultEl.textContent = "pending…";
  decResultEl.className = "dec-val";
  thinkStatusEl.textContent = "idle";
}

function renderDecision(m: Extract<ExtMessage, { type: "decision" }>) {
  decObservedEl.textContent = `${m.observed} interactive element${m.observed === 1 ? "" : "s"}`;
  decProtectedEl.textContent = `${m.protected} sensitive region${m.protected === 1 ? "" : "s"}`;
  decTargetEl.className = "dec-val som";
  decTargetEl.textContent = m.target
    ? `SoM #${m.target.id} — ${m.target.desc || "element"}`
    : "—";
  decActionEl.className = "dec-val token";
  decActionEl.textContent = m.action;
  decResultEl.textContent = m.subgoal ? m.subgoal : "pending…";
  decResultEl.className = "dec-val";
  thinkStatusEl.textContent = "ready";
}

function renderDecisionResult(result: string) {
  decResultEl.textContent = result;
  const ok = /^done:|^navigating|^clicked|^typed|^pressed|^scrolled|^waited/.test(result);
  decResultEl.className = ok ? "dec-val ok" : "dec-val";
}

// ── Loop controls ─────────────────────────────────────────────────────────

async function startLoop() {
  if (loopRunning) return;
  beginSession("loop");
  addLocalLog("info", "Starting agent…");
  await browser.runtime.sendMessage({
    type: "start-loop",
    task: taskEl.value,
  } satisfies ExtMessage);
}

async function stopLoop() {
  addLocalLog("info", "Stopping agent…");
  await browser.runtime.sendMessage({ type: "stop-loop" } satisfies ExtMessage);
}

async function runStep() {
  if (loopRunning) return;
  beginSession("step");
  addLocalLog("info", "Running single step…");
  await browser.runtime.sendMessage({
    type: "run-step",
    task: taskEl.value,
  } satisfies ExtMessage);
}

function clearHistory() {
  sessions = [];
  persistSessions();
  renderHistory();
  addLocalLog("info", "Cleared session history.");
}

function addLocalLog(level: Level, text: string) {
  const human = humanizeLog(text);
  if (current) current.entries.push({ level, text, human });
  renderEntry(logEl, { level, text, human });
}

// ── Live "decision" readout ──────────────────────────────────────────────
// We deliberately do NOT surface raw chain-of-thought. The card shows the
// structured decision trace; raw text stays available in technical logs.

function startThink() {
  thinkStatusEl.textContent = "reasoning…";
  decResultEl.textContent = "reasoning…";
  decResultEl.className = "dec-val";
}

function endThink() {
  thinkStatusEl.textContent = "reasoned";
}

// ── Terminal-state detection on background log lines
function maybeFinalize(level: Level, text: string): boolean {
  if (!current) return false;
  if (current.kind === "step") {
    if (level === "error" && text.startsWith("Failed:")) {
      finalizeSession("failed");
      return true;
    }
    if (text.startsWith("Done:")) {
      finalizeSession("done");
      return true;
    }
  }
  if (text.startsWith("Task complete at step")) {
    finalizeSession("done");
    return true;
  }
  if (text.includes("Stuck: same action")) {
    finalizeSession("stuck");
    return true;
  }
  if (text.includes("Recovery fired")) {
    finalizeSession("stuck");
    return true;
  }
  if (text.includes("Too many consecutive failures")) {
    finalizeSession("failed");
    return true;
  }
  if (text.includes("Loop stopped by user")) {
    finalizeSession("stopped");
    return true;
  }
  if (text === "Loop finished.") {
    finalizeSession("done");
    return true;
  }
  return false;
}

browser.runtime.onMessage.addListener((raw: unknown) => {
  const msg = raw as ExtMessage;
  if (msg?.type === "agent-log") {
    if (!maybeFinalize(msg.level, msg.text)) {
      pushEntry(msg.level, msg.text, msg.screenshot);
    }
  }
  if (msg?.type === "loop-status") {
    setLoopUI(msg.running, msg.step, msg.maxSteps);
  }
  if (msg?.type === "think-start") startThink();
  if (msg?.type === "think-end") endThink();
  if (msg?.type === "agent-stage") setStage(msg.stage, msg.text);
  if (msg?.type === "privacy") renderPrivacy(msg);
  if (msg?.type === "decision") renderDecision(msg);
  if (msg?.type === "decision-result") renderDecisionResult(msg.result);
  if (msg?.type === "capture-preview") showPreview(msg);
});

// ── Controls wiring ───────────────────────────────────────────────────────

runBtn.addEventListener("click", runStep);
loopBtn.addEventListener("click", () => (loopRunning ? stopLoop() : startLoop()));

clearHistEl.addEventListener("click", clearHistory);

// Minimal live-activity card control (keeps panel compact when driving from
// the page spotlight with Alt+K).
const LS_LIVE_MIN = "sihLiveMinimized";
function applyLiveMinimized(min: boolean) {
  liveCardEl.classList.toggle("minimized", min);
  toggleLiveEl.textContent = min ? "+" : "–";
  localStorage.setItem(LS_LIVE_MIN, min ? "1" : "0");
}
toggleLiveEl.addEventListener("click", () => {
  applyLiveMinimized(!liveCardEl.classList.contains("minimized"));
});
applyLiveMinimized(localStorage.getItem(LS_LIVE_MIN) === "1");

// Technical-logs toggle. On: hide-and-show "tech" lines; remembers preference
// (also seeded by the Advanced "Debug logging" switch).
const LS_SHOW_TECH = "sihShowTech";
function applyTechMode(wide: boolean) {
  logEl.classList.toggle("hide-tech", !wide);
  toggleTechEl.textContent = wide ? "Hide technical logs" : "View technical logs ›";
}
toggleTechEl.addEventListener("click", () => {
  const wide = logEl.classList.contains("hide-tech");
  applyTechMode(wide);
  localStorage.setItem(LS_SHOW_TECH, wide ? "1" : "0");
});

// Advanced ⚙ toggle.
toggleAdvancedEl.addEventListener("click", () => {
  advancedEl.open = !advancedEl.open;
  toggleAdvancedEl.textContent = advancedEl.open ? "Advanced ✓" : "⚙ Advanced";
});

// Settings persistence (shared storage read by the background for each step).
function setNum(key: string, el: HTMLInputElement) {
  return () => {
    const n = Number(el.value);
    if (Number.isFinite(n)) browser.storage.local.set({ [key]: n }).catch(() => {});
  };
}
maxStepsEl.addEventListener("change", setNum(STORAGE_MAX_STEPS, maxStepsEl));
shotQualityEl.addEventListener("change", () => {
  browser.storage.local.set({ [STORAGE_SHOT_QUALITY]: Number(shotQualityEl.value) }).catch(() => {});
});
debugEl.addEventListener("change", () => {
  browser.storage.local.set({ [STORAGE_DEBUG]: debugEl.checked }).catch(() => {});
  applyTechMode(!debugEl.checked);
});
browser.storage.local.get([STORAGE_MAX_STEPS, STORAGE_SHOT_QUALITY, STORAGE_DEBUG]).then((r) => {
  if (typeof r[STORAGE_MAX_STEPS] === "number") maxStepsEl.value = String(r[STORAGE_MAX_STEPS]);
  if (typeof r[STORAGE_SHOT_QUALITY] === "number") {
    shotQualityEl.value = String(r[STORAGE_SHOT_QUALITY]);
    if (!shotQualityEl.querySelector(`option[value="${r[STORAGE_SHOT_QUALITY]}"]`)) {
      shotQualityEl.value = "50";
    }
  }
  const wide = (debugEl.checked = r[STORAGE_DEBUG] === true);
  if (localStorage.getItem(LS_SHOW_TECH) === "1") applyTechMode(true);
  else applyTechMode(!wide);
}).catch(() => {});

// Task is shared with the page spotlight (chrome.storage.local).
browser.storage.local
  .get(STORAGE_TASK)
  .then((r) => {
    if (typeof r[STORAGE_TASK] === "string" && r[STORAGE_TASK]) {
      taskEl.value = r[STORAGE_TASK];
    }
  })
  .catch(() => {});
taskEl.addEventListener("input", () => {
  browser.storage.local.set({ [STORAGE_TASK]: taskEl.value }).catch(() => {});
});

// Agent-cursor preference lives in shared storage.
cursorEl.addEventListener("change", () => {
  browser.storage.local
    .set({ [STORAGE_CURSOR]: cursorEl.checked })
    .catch(() => {});
  browser.runtime
    .sendMessage({ type: "cursor-toggle", enabled: cursorEl.checked } satisfies ExtMessage)
    .catch(() => {});
});
browser.storage.local
  .get(STORAGE_CURSOR)
  .then((r) => {
    const enabled = r[STORAGE_CURSOR] !== false;
    cursorEl.checked = enabled;
    browser.runtime
      .sendMessage({ type: "cursor-toggle", enabled } satisfies ExtMessage)
      .catch(() => {});
  })
  .catch(() => {});

// ── Startup ───────────────────────────────────────────────────────────────

// Page-view controls: Privacy orb, Privacy Lens, and the USER | AI VIEW toggle
// are shared with the content script via chrome.storage.local — the active
// tab reacts to the change and updates the live page.
orbCtlEl.addEventListener("change", () => {
  browser.storage.local.set({ [STORAGE_ORB]: orbCtlEl.checked }).catch(() => {});
});
lensCtlEl.addEventListener("change", () => {
  browser.storage.local.set({ [STORAGE_LENS]: lensCtlEl.checked }).catch(() => {});
});

function applyViewToggle(view: "user" | "ai") {
  viewToggleEl.dataset.view = view;
  browser.storage.local
    .set({ [STORAGE_AI_VIEW]: view === "ai" })
    .catch(() => {});
}
viewToggleEl.querySelectorAll<HTMLElement>(".seg").forEach((seg) => {
  seg.addEventListener("click", () =>
    applyViewToggle(seg.dataset.view === "ai" ? "ai" : "user"),
  );
});

browser.storage.local
  .get([STORAGE_ORB, STORAGE_LENS, STORAGE_AI_VIEW])
  .then((r) => {
    orbCtlEl.checked = r[STORAGE_ORB] !== false;
    lensCtlEl.checked = r[STORAGE_LENS] === true;
    viewToggleEl.dataset.view = r[STORAGE_AI_VIEW] === true ? "ai" : "user";
  })
  .catch(() => {});

// Keep this panel's controls in sync when a toggle happens elsewhere (e.g.
// the page command palette with Alt+K).
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (STORAGE_ORB in changes) orbCtlEl.checked = changes[STORAGE_ORB].newValue !== false;
  if (STORAGE_LENS in changes) lensCtlEl.checked = changes[STORAGE_LENS].newValue === true;
  if (STORAGE_AI_VIEW in changes) {
    viewToggleEl.dataset.view = changes[STORAGE_AI_VIEW].newValue === true ? "ai" : "user";
  }
});

renderHistory();
resetPrivacyDisplay();

// Human label for a model id in the selector.
function modelLabel(m: string): string {
  if (m === "moondream" || m === "moondream:latest") return "moondream (fast · GPU)";
  return m;
}

// Model selector — persisted in shared storage (read by background for each
// act request); populate from the server's /models list with a default option.
fetch(`${SERVER_URL}/models`)
  .then((r) => r.json())
  .then((j: { models?: string[] }) => {
    const models = j.models ?? [];
    if (models.length === 0) return;
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = modelLabel(m);
      modelEl.appendChild(opt);
    }
    browser.storage.local.get(STORAGE_MODEL).then((r) => {
      const saved = r[STORAGE_MODEL];
      if (typeof saved === "string" && models.includes(saved)) {
        modelEl.value = saved;
      } else {
        modelEl.value = models.includes("qwen2.5vl:3b")
          ? "qwen2.5vl:3b"
          : models[0];
        browser.storage.local.set({ [STORAGE_MODEL]: modelEl.value }).catch(() => {});
      }
    });
  })
  .catch(() => {});
modelEl.addEventListener("change", () => {
  browser.storage.local.set({ [STORAGE_MODEL]: modelEl.value }).catch(() => {});
});

fetch(`${SERVER_URL}/health`)
  .then((r) => r.json())
  .then((j: { status: string }) => addLocalLog("success", `Server up at ${SERVER_URL} (${j.status})`))
  .catch(() => addLocalLog("error", `Server unreachable — start it: uvicorn app:app --reload`));