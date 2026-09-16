// Latency probe — where does the <5 s/step budget go, and which model is fastest?
//
// Part A: real /act round trip (production server path) for the default model.
// Part B: identical prompt+image straight to Ollama, per candidate model, using
//         /api/chat metrics to split prompt prefill vs token generation.
//
// Usage: node benchmarks/latency-probe.mjs   (server + Ollama must be up)

import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SERVER = "http://127.0.0.1:8000";
const OLLAMA = "http://127.0.0.1:11434/api/chat";
const PAGE_URL = `${SERVER}/test-site/flight-booking.html`;
const TASK = "Fill out the passenger details form: name Aarav Sharma, email alice@example.com, phone +91 98765 43210, PAN ABCDE1234F, Aadhaar 2345 6789 0123. Then click Continue to payment.";
const SYSTEM = `Browser agent decision layer. Return EXACTLY one JSON object, nothing else:
{"thought": "<short reason>", "action": <one action>, "done": false, "subgoal": "<short aim>", "blocked": <bool>}
Actions: {"type":"click","target":5} {"type":"type","target":5,"text":"x"} {"type":"press","key":"enter"} {"type":"scroll","direction":"down","amount":600} {"type":"navigate","url":"https://... "} {"type":"wait","ms":800} {"type":"extract","text":"..."} {"type":"done","answer":"..."}
TARGET RULE: "target" is a plain integer id from the [N] list. Redaction legend: [EMAIL_N],[PHONE_N],[AADHAAR_N],[PAN_N],[CARD_N],[NAME_N] = redacted data, never ask to reveal. done=true only when the task is complete.`;

const MODELS = ["qwen2.5vl:3b", "qwen3-vl:2b", "qwen2.5vl:7b"];
const SYSTEM_FULL = `You are the decision layer of an autonomous browser agent. You receive ONE screenshot of a web page plus a compact DOM snapshot, and you return ONE JSON object describing the single next action that moves the task TOWARD ITS GOAL. You never write prose, never explain, never use markdown.

OUTPUT FORMAT (return exactly this shape, nothing else):
{"thought": "<short reason>", "action": <one action object>, "done": false, "subgoal": "<short what you are trying to achieve right now>", "blocked": <true/false>}

- "subgoal": the immediate sub-goal this step advances (e.g. "open search results"). Use it to keep yourself on track across steps.
- "blocked": true ONLY when this step could not happen because of an obstacle (login wall, permission dialog, paywall, page error, missing element) AND you need to change approach rather than repeat. Otherwise false.
- "done": true ONLY when the overall task is fully complete.

LENGTH BUDGET (CRITICAL): "thought" max 8 words, "subgoal" max 5 words. The ENTIRE reply stays under 45 tokens. Never add prose after the JSON.

ACTION OBJECTS (use the fields the type needs; omit the rest):
{"type": "click",    "target": 5}
{"type": "type",     "target": 5, "text": "zombie reddy 2 trailer"}
{"type": "press",    "key": "enter"}
{"type": "scroll",   "direction": "down", "amount": 600}
{"type": "navigate", "url": "https://example.com"}
{"type": "wait",     "ms": 800}
{"type": "extract",  "text": "the error message"}
{"type": "done",     "answer": "optional final answer"}

THE NUMBERED TAGS: the DOM snapshot lists elements like:
  [7] <input> role=textbox text="Search" label="search"
The "7" is the element's id and is drawn as a numbered tag "[7]" on the screenshot. ALWAYS use the plain integer (7), never the string "[7]" and never the word "search".

TARGET RULE: "target" is ALWAYS a plain integer copied from the [N] tag. It is NEVER a word, NEVER the task text, NEVER in brackets.

SEARCHING: to search for something, do it in three steps:
  1. click the search box (its numeric id)
  2. type into that same numeric id with the phrase in "text"
  3. press enter

BLOCKER RECOVERY — CRITICAL BEHAVIOUR:
When a step is blocked, DO NOT repeat the same action. Instead adapt: change subgoal, change the element, change the URL — never fire the identical failing action twice.

Redaction legend: [EMAIL_N], [PHONE_N], [AADHAAR_N], [PAN_N], [CARD_N], [NAME_N], [ADDRESS_N] are placeholders for redacted personal data — reason about their position, never ask the user to reveal them. [SECRET] fields are passwords — never interact past them.

Rules:
1. Prefer clicking/typing a visible target over scrolling.
2. done=true only when the task is complete.
3. If nothing useful is visible, scroll down.
4. When blocked, produce a DIFFERENT action than the one that just failed.`;

function pms(ns) {
  return ns == null ? "0" : (ns / 1e6).toFixed(0);
}

function pct(vals, p) {
  const arr = [...vals].sort((a, b) => a - b);
  return arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
}
function stats(vals) {
  return `${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(0)}ms | p50 ${pct(vals, 0.5).toFixed(0)}ms | p95 ${pct(vals, 0.95).toFixed(0)}ms | n=${vals.length}`;
}

async function act(screenshotB64) {
  const body = { task: TASK, history: [], screenshot_b64: screenshotB64, dom: [] };
  const t0 = performance.now();
  const res = await fetch(`${SERVER}/act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const dt = performance.now() - t0;
  const j = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j)}`);
  return { ms: dt, model: j.model_used, action: j.action?.type ?? "?" };
}

async function chat(model, imageB64, system, userText = null) {
  const rawB64 = imageB64.replace(/^data:image\/\w+;base64,/, "");
  const text = userText ?? `Task: ${TASK}\nDOM elements (0 total):\n(No DOM elements captured)\n\nREMINDER: return ONE JSON object only.`;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: text, images: [rawB64] },
  ];
  const res = await fetch(OLLAMA, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false, options: { num_ctx: 4096 }, keep_alive: "5m" }),
  });
  if (!res.ok) throw new Error(`${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}

const b = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(500);
  const shot = await page.screenshot({ type: "png" });
  const b64 = shot.toString("base64");
  console.log(`Screenshot: ${(b64.length * 3 / 4 / 1024).toFixed(0)} KB (1280x800 PNG) from ${PAGE_URL}\n`);

  console.log("=== Part A: real /act (production server path, default model) ===");
  const actTimes = [];
  for (let i = 0; i < 3; i++) {
    try {
      const r = await act(b64);
      actTimes.push(r.ms);
      console.log(`  /act #${i + 1}: ${r.ms.toFixed(0)}ms (model_used=${r.model}, action=${r.action})`);
    } catch (e) {
      console.log(`  /act #${i + 1}: FAILED ${e.message.slice(0, 120)}`);
    }
  }
  if (actTimes.length) console.log(`  summary: ${stats(actTimes)}\n`);

  console.log("=== Part B: straight-to-Ollama per model (prefill vs generate) ===");
  for (const model of MODELS) {
    try {
      const warm = await chat(model, b64, SYSTEM);
      if (warm.error) { console.log(`  ${model}: SKIP (${warm.error})`); continue; }
      console.log(`  ${model}: warm done (prompt_eval=${warm.prompt_eval_count}, eval=${warm.eval_count})`);
    } catch (e) {
      // model may not support the message shape — keep going
    }
    const runs = [];
    for (let i = 0; i < 2; i++) {
      try {
        const r = await chat(model, b64, SYSTEM);
        runs.push(r);
      } catch (e) {
        console.log(`  ${model}: FAILED ${e.message.slice(0, 100)}`);
        break;
      }
    }
    if (!runs.length) continue;
    const prefill = runs.map((r) => (r.prompt_eval_duration ?? 0) / 1e6);
    const gen = runs.map((r) => (r.eval_duration ?? 0) / 1e6);
    const wall = runs.map((r) => (r.total_duration - (r.load_duration ?? 0)) / 1e6);
    console.log(`  ${model}: prompt_tokens=${runs[0].prompt_eval_count} eval_tokens=${runs[0].eval_count}`);
    console.log(`    prefill  ${stats(prefill)}`);
    console.log(`    generate ${stats(gen)}`);
    console.log(`    wall     ${stats(wall)}`);
  }

  console.log("\n=== Part C: prompt-size impact on qwen2.5vl:3b (full vs compact system) ===");
  const domText = Array.from({ length: 40 }, (_, i) =>
    `  [${i}] <input> role=textbox text="Some label text here ${i}" label="field-${i}" value="x"`,
  ).join("\n");
  const longUser = `Task: ${TASK}\n\nPrevious steps:\n  1. click #9 -> ok\n  2. type #4 "hi" -> ok\n\nDOM elements (40 total):\n${domText}\n\nREMINDER: return ONE JSON object only. "target" is a plain integer id from the [N] list.`;
  const warmFull = await chat("qwen2.5vl:3b", b64, SYSTEM_FULL, longUser);
  console.log(`  warm(full+40dom) prompt_eval=${warmFull.prompt_eval_count}`);
  const combos = [
    ["full sys + 40 dom", SYSTEM_FULL, longUser],
    ["compact sys + 40 dom", SYSTEM, longUser],
    ["compact sys + bare text", SYSTEM, null],
  ];
  for (const [label, sys, utxt] of combos) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const r = await chat("qwen2.5vl:3b", b64, sys, utxt);
      runs.push(r);
    }
    const prefill = runs.map((r) => (r.prompt_eval_duration ?? 0) / 1e6);
    const wall = runs.map((r) => (r.total_duration - (r.load_duration ?? 0)) / 1e6);
    console.log(`  ${label}: tokens=${runs[0].prompt_eval_count}`);
    console.log(`    prefill ${stats(prefill)}`);
    console.log(`    wall    ${stats(wall)}`);
  }

  console.log("\n=== Part D: qwen3-vl:2b with realistic (full sys + 40 dom) ===");
  const warmQ = await chat("qwen3-vl:2b", b64, SYSTEM_FULL, longUser);
  console.log(`  warm prompt_eval=${warmQ.prompt_eval_count}`);
  const qRuns = [];
  for (let i = 0; i < 3; i++) {
    const r = await chat("qwen3-vl:2b", b64, SYSTEM_FULL, longUser);
    qRuns.push(r);
  }
  const qPrefill = qRuns.map((r) => (r.prompt_eval_duration ?? 0) / 1e6);
  const qGen = qRuns.map((r) => (r.eval_duration ?? 0) / 1e6);
  const qWall = qRuns.map((r) => (r.total_duration - (r.load_duration ?? 0)) / 1e6);
  console.log(`  qwen3-vl:2b tokens=${qRuns[0].prompt_eval_count}/${qRuns[0].eval_count}`);
  console.log(`    prefill  ${stats(qPrefill)}`);
  console.log(`    generate ${stats(qGen)}`);
  console.log(`    wall     ${stats(qWall)}`);
  console.log(`  sample reply: ${qRuns[0].message.content.slice(0, 160)}`);
} finally {
  await b.close();
}