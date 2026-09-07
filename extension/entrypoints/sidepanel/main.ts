import { SERVER_URL } from "@/core/config";
import type { ExtMessage } from "@/core/protocol";

const logEl = document.getElementById("log") as HTMLUListElement;
const shotEl = document.getElementById("shot") as HTMLImageElement;
const noshotEl = document.getElementById("noshot") as HTMLParagraphElement;
const capSizeEl = document.getElementById("capSize") as HTMLSpanElement;
const taskEl = document.getElementById("task") as HTMLInputElement;
const loopBtn = document.getElementById("loop") as HTMLButtonElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const cursorEl = document.getElementById("cursor") as HTMLInputElement;
const modelEl = document.getElementById("model") as HTMLSelectElement;
const liveDotEl = document.getElementById("liveDot") as HTMLSpanElement;
const toggleLiveEl = document.getElementById("toggleLive") as HTMLButtonElement;
const liveCardEl = document.getElementById("liveCard") as HTMLElement;
const clearHistEl = document.getElementById("clearHist") as HTMLButtonElement;
const histListEl = document.getElementById("histList") as HTMLDivElement;
const thinkBodyEl = document.getElementById("thinkBody") as HTMLPreElement;
const thinkHeadEl = document.getElementById("thinkStatus") as HTMLSpanElement;

const STORAGE_TASK = "sihTask";
const STORAGE_CURSOR = "sihCursorEnabled";
const STORAGE_MODEL = "sihModel";

// ── Persisted state ───────────────────────────────────────────────────────

const LS_SESSIONS = "sihSessions";
const MAX_SESSIONS = 25;
const MAX_ENTRIES = 40;

type Level = "info" | "error" | "success";
interface LogEntry {
  level: Level;
  text: string;
}
interface StoredSession {
  id: number;
  kind: "loop" | "step";
  task: string;
  started: number;
  ended?: number;
  status: "running" | "done" | "stuck" | "failed" | "stopped";
  entries: LogEntry[];
}

let sessions: StoredSession[] = loadSessions();
let loopSeq: number = Number(localStorage.getItem("sihLoopSeq") || "0");
let current: StoredSession | null = null;
let loopRunning = false;

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
    // localStorage full — drop oldest session and retry once
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

// If a run was triggered from the page (Alt+K spotlight) and this panel has no
// live session yet, begin one so it still lands in History.
function ensureSessionFromLog(text: string) {
  if (current) return;
  if (text.startsWith("Loop started") || text.startsWith("Adaptive loop started")) beginSession("loop");
  else if (text.startsWith("Running single step")) beginSession("step");
}

function pushEntry(level: Level, text: string, screenshot?: string) {
  ensureSessionFromLog(text);
  if (current) current.entries.push({ level, text });
  renderEntry(logEl, level, text);
  if (screenshot) showScreenshot(screenshot);
}

function renderEntry(
  ul: HTMLUListElement,
  level: Level,
  text: string,
) {
  const li = document.createElement("li");
  li.className = level;
  if (text.includes("🧠 VLM thought:")) li.classList.add("thought");
  li.textContent = text;
  ul.appendChild(li);
  li.scrollIntoView({ block: "end" });
}

// ── History (foldered sessions) ───────────────────────────────────────────

function renderHistory() {
  histListEl.innerHTML = "";
  if (sessions.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-hint";
    p.textContent = "No runs yet — start a loop to get going.";
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
  title.textContent = s.kind === "loop" ? `Loop #${s.id}` : "Step run";
  const task = document.createElement("span");
  task.className = "hist-task";
  task.textContent = s.task;
  const time = document.createElement("span");
  time.className = "hist-time";
  time.textContent = `${fmtTime(s.started)} · ${fmtDuration(s)}`;
  const chip = document.createElement("span");
  chip.className = `chip chip-${s.status}`;
  chip.textContent = statusLabel(s.status);

  head.append(chev, title, task, time, chip);

  const body = document.createElement("div");
  body.className = "hist-body";
  body.hidden = true;
  const ul = document.createElement("ul");
  ul.className = "mini-log";
  for (const e of s.entries) renderEntry(ul, e.level, e.text);
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

function showScreenshot(dataUrl: string) {
  shotEl.src = dataUrl;
  shotEl.hidden = false;
  noshotEl.hidden = true;
  const kb = Math.round((dataUrl.replace(/^data:image\/\w+;base64,/, "").length * 3) / 4 / 1024);
  capSizeEl.textContent = `${kb} KB`;
}

function setLoopUI(running: boolean, step?: number, max?: number) {
  loopRunning = running;
  if (running) {
    loopBtn.textContent = "Stop loop";
    loopBtn.classList.add("active");
    statusEl.textContent = `Step ${step}/${max}`;
    statusEl.className = "hint running";
  } else {
    loopBtn.textContent = "Start loop";
    loopBtn.classList.remove("active");
    statusEl.textContent = step !== undefined ? `Stopped at step ${step}` : "Ready";
    statusEl.className = "hint";
  }
}

async function startLoop() {
  if (loopRunning) return;
  beginSession("loop");
  addLocalLog("info", "Starting loop…");
  await browser.runtime.sendMessage({
    type: "start-loop",
    task: taskEl.value,
  } satisfies ExtMessage);
}

async function stopLoop() {
  addLocalLog("info", "Stopping loop…");
  await browser.runtime.sendMessage({ type: "stop-loop" } satisfies ExtMessage);
}

async function runStep() {
  if (loopRunning) return;
  beginSession("step");
  addLocalLog("info", "Step requested…");
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
  if (current) current.entries.push({ level, text });
  renderEntry(logEl, level, text);
}

// ── Live "thinking" readout ───────────────────────────────────────────────

// Buffered so we can Cap the DOM before storming the panel with tiny updates.
let thinkAccum = "";
let thinkTimer: ReturnType<typeof setTimeout> | undefined;

function startThink() {
  thinkAccum = "";
  thinkHeadEl.textContent = "thinking…";
  thinkBodyEl.textContent = "";
}

function commitThink() {
  if (!thinkAccum) return;
  thinkAccum = thinkAccum.slice(-4000);
  thinkBodyEl.textContent = thinkAccum;
  thinkHeadEl.textContent = thinkAccum.length ? "thought" : "thinking…";
  thinkBodyEl.scrollTop = thinkBodyEl.scrollHeight;
}

function appendThink(delta: string) {
  thinkAccum += delta;
  if (!thinkTimer) thinkTimer = setTimeout(() => { thinkTimer = undefined; commitThink(); }, 80);
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
  if (msg?.type === "think-delta") appendThink(msg.text);
  if (msg?.type === "think-end") {
    commitThink();
    thinkHeadEl.textContent = "thought";
  }
});

// ── Controls wiring ───────────────────────────────────────────────────────

runBtn.addEventListener("click", runStep);
loopBtn.addEventListener("click", () => (loopRunning ? stopLoop() : startLoop()));

clearHistEl.addEventListener("click", clearHistory);

// Minimise / expand the live activity card so the panel stays compact while
// driving from the page spotlight (Alt+K).
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

// Task is shared with the page spotlight (chrome.storage.local) so a loop can
// be started from Alt+K with the same prompt.
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

// Agent-cursor preference lives in shared storage (single source of truth for
// panel checkbox + content script auto-restore).
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

renderHistory();

// Human label for a model id in the selector — show the FULL id so the
// quick/accurate tier is unambiguous (e.g. qwen3-vl:2b vs qwen2.5vl:3b vs
// openbmb/minicpm-v4.6:1b). moondream keeps a friendlier annotation.
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