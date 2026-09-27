// Scripted /act stub for HUMAN-IN-THE-LOOP testing.
//
// The `ask` action and the Proceed/Cancel safety gate are emitted by the VLM,
// so testing them against a real model is non-deterministic: you cannot force
// a question at step 3, and you cannot reproduce a failure. This server makes
// HITL deterministic by replaying a scripted list of ServerActResponse
// objects, one per /act call.
//
// It speaks only the contract the extension actually uses:
//   GET  /health        -> { status }                     (sidepanel/main.ts)
//   GET  /models        -> { models }                     (sidepanel/main.ts)
//   POST /act           -> ServerActResponse              (the scripted queue)
//   POST /rethink       -> same queue (recovery path)
//   /act/stream, /rethink/stream -> 404 on purpose, so the extension takes its
//       own documented non-streamed fallback (background.ts) instead of the
//       test having to fake SSE framing.
//
// Every request body is appended to a JSONL capture so a test can assert on
// what ACTUALLY left the device - that is how the history/task PII cases
// (see docs/hitl-test-matrix.md) are proven rather than assumed.
//
// Usage (PowerShell):
//   $env:HITL_PRESET = "ask-basic"
//   node benchmarks/mock-act-server.mjs
//   # then set Advanced -> Server URL in the side panel to the printed URL
//
//   $env:HITL_SCRIPT = '[{"thought":"t","action":{"type":"done"},"done":true}]'
//   $env:HITL_SCRIPT_FILE = "my-script.json"   # alternative to HITL_SCRIPT
//   $env:HITL_PORT = "8010"
//   $env:HITL_LOG = "benchmarks/results/hitl-capture.jsonl"
//   $env:HITL_REPEAT = "false"                 # stop answering after the script
//   $env:HITL_DELAY_MS = "0"                   # per-step think time

import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.HITL_PORT ?? 8010);
const HOST = process.env.HITL_HOST ?? "127.0.0.1";
const LOG_PATH = resolve(process.env.HITL_LOG ?? join(__dirname, "results", "hitl-capture.jsonl"));
const REPEAT = process.env.HITL_REPEAT !== "false";
const DELAY_MS = Number(process.env.HITL_DELAY_MS ?? 0);

// ── Script helpers ────────────────────────────────────────────────────────

const a = (action, thought = "mock", extra = {}) => ({
  thought,
  subgoal: null,
  blocked: false,
  model_used: "mock-vlm",
  // The agent loop terminates on the TOP-LEVEL `done` flag - it reads
  // `data.done` and never looks at `action.type` - so this must be derived from
  // the action. Hardcoding false would make every run loop forever.
  done: action?.type === "done",
  action,
  ...extra,
});

/** An `ask` action - pauses the loop for a user decision. */
const ask = (question, options) =>
  a({ type: "ask", question, ...(options?.length ? { options } : {}) }, "I need a decision.");

/** Scripted presets, one per matrix case. `id` shows up in the capture log so a
 *  test (or a human reading the JSONL) can tell which step produced what. */
const PRESETS = {
  // A. decide path
  "ask-basic": [
    ask("Which seat do you want?", ["Window", "Aisle"]),
    a({ type: "wait", ms: 50 }, "Applying the choice."),
    a({ type: "done", answer: "Seat selected." }, "Finished."),
  ],
  "ask-freetext": [
    ask("Which date should I use? (no options = free text)"),
    a({ type: "done", answer: "Booked." }, "Finished."),
  ],
  // Entry 3 exists so HITL-07 and HITL-08 can be told apart with ONE script:
  // Proceed ends the run on entry 2 and never reaches it; Cancel continues to
  // entry 3, so the visible "it asked again instead of finishing" is the proof
  // the gate did its job.
  "ask-then-done": [
    ask("Proceed with the booking?", ["Yes", "No"]),
    a({ type: "done", answer: "Booked." }, "All set."),
    ask("Understood - what should I do instead?", ["Pick another seat", "Stop here"]),
  ],
  "ask-same-twice": [
    ask("Pick one.", ["A", "B"]),
    ask("Pick one.", ["A", "B"]),
    ask("Pick one.", ["A", "B"]),
    ask("Pick one.", ["A", "B"]),
    ask("Pick one.", ["A", "B"]),
  ],
  "empty-question": [ask(""), a({ type: "done", answer: "ok" }, "Finished.")],

  // B. confirm gate - only `done` and CROSS-ORIGIN navigate are gated.
  "cross-origin": [
    a({ type: "navigate", url: "https://example.com/" }, "Leaving the site."),
    a({ type: "done", answer: "Arrived." }, "Finished."),
  ],
  "same-origin": [
    a({ type: "navigate", url: "/index.html" }, "Staying on the same origin."),
    a({ type: "done", answer: "Done." }, "Finished."),
  ],

  // D. privacy - the question invites PII, the answer slot is where it lands.
  "noisy-answer": [
    ask("Read me your PAN and Aadhaar to continue.", ["Proceed", "Cancel"]),
    a({ type: "done", answer: "ok" }, "Finished."),
  ],
  "padded-pii": [ask("Confirm the PAN you want used.", ["Proceed", "Cancel"])],

  // Happy path with no question at all - proves the gate does NOT over-trigger.
  "no-ask": [a({ type: "wait", ms: 50 }, "Looking."), a({ type: "done", answer: "ok" }, "Done.")],
};

// ── Script resolution ─────────────────────────────────────────────────────

function resolveScript() {
  const preset = process.env.HITL_PRESET;
  if (preset) {
    if (!PRESETS[preset]) {
      console.error(`unknown HITL_PRESET '${preset}'. known: ${Object.keys(PRESETS).join(", ")}`);
      process.exit(2);
    }
    return { name: preset, entries: PRESETS[preset] };
  }
  if (process.env.HITL_SCRIPT_FILE) {
    const p = resolve(process.env.HITL_SCRIPT_FILE);
    if (!existsSync(p)) {
      console.error(`HITL_SCRIPT_FILE not found: ${p}`);
      process.exit(2);
    }
    return { name: p, entries: JSON.parse(readFileSync(p, "utf8")) };
  }
  if (process.env.HITL_SCRIPT) {
    return { name: "HITL_SCRIPT", entries: JSON.parse(process.env.HITL_SCRIPT) };
  }
  console.error(
    "no script configured. set one of:\n" +
      `  HITL_PRESET  - one of: ${Object.keys(PRESETS).join(", ")}\n` +
      "  HITL_SCRIPT  - inline JSON array of ServerActResponse objects\n" +
      "  HITL_SCRIPT_FILE - path to a .json file holding that array",
  );
  process.exit(2);
}

const { name: scriptName, entries: script } = resolveScript();
if (!Array.isArray(script) || script.length === 0) {
  console.error("script must be a non-empty array of {thought, action, done}");
  process.exit(2);
}

let cursor = 0;
/** Next scripted response. Stops at the end when HITL_REPEAT=false, which is
 *  how a case asserts "the agent stopped asking" instead of looping forever. */
function nextResponse() {
  if (cursor >= script.length) {
    if (REPEAT) return { ...script[script.length - 1], thought: "mock: script exhausted, repeating last" };
    return null;
  }
  return script[cursor++];
}

// ── Capture ───────────────────────────────────────────────────────────────

mkdirSync(dirname(LOG_PATH), { recursive: true });
/** Bodies captured this process, newest last. Also served from /__requests. */
const captured = [];

function capture(kind, body) {
  const rec = {
    seq: captured.length,
    kind,
    at: new Date().toISOString(),
    // Screenshot b64 is megabytes; keep it out of the readable log but record
    // its size so a payload-budget assertion still has something to check.
    task: body?.task ?? null,
    history: body?.history ?? [],
    dom: Array.isArray(body?.dom) ? body.dom : [],
    model: body?.model ?? null,
    warnings: body?.warnings ?? [],
    screenshotBytes: body?.screenshot_b64?.length ?? 0,
    imageMime: body?.imageMime ?? null,
    hasScreenPerception: body?.screenPerception != null,
  };
  captured.push(rec);
  appendFileSync(LOG_PATH, JSON.stringify(rec) + "\n", "utf8");
  const hist = (body?.history ?? []).map((h) => h?.result ?? "");
  console.log(
    `[mock] #${rec.seq} ${kind} -> ${scriptName}[${Math.min(cursor, script.length) - 1}]` +
      ` | task="${String(body?.task ?? "").slice(0, 40)}"` +
      ` | history=${hist.length}` +
      (hist.length ? ` | last="${String(hist[hist.length - 1]).slice(0, 60)}"` : ""),
  );
  return rec;
}

// ── Server ────────────────────────────────────────────────────────────────

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolvePromise) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch (e) {
        resolvePromise({ __parseError: String(e) });
      }
    });
  });

const srv = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, `http://${HOST}:${PORT}`).pathname);

  if (path === "/health") {
    return json(res, 200, {
      status: "ok (mock)",
      vlm_connected: true,
      vlm_model: "mock-vlm",
      protocol_version: 2,
      models: ["mock-vlm"],
    });
  }

  if (path === "/models") {
    return json(res, 200, { models: ["mock-vlm", "qwen2.5vl:3b", "qwen2.5vl:7b"] });
  }

  // Debug helper: what has this process received so far.
  if (path === "/__requests") {
    return json(res, 200, { script: scriptName, count: captured.length, requests: captured });
  }
  if (path === "/__reset") {
    cursor = 0;
    captured.length = 0;
    return json(res, 200, { ok: true, script: scriptName });
  }

  if (req.method === "POST" && (path === "/act" || path === "/rethink")) {
    const body = await readBody(req);
    capture(path === "/act" ? "act" : "rethink", body);
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    const next = nextResponse();
    if (!next) {
      // No script left: 409 makes the extension treat this as a server-side
      // failure so the loop's own failure handling is what you observe.
      return json(res, 409, { detail: "mock script exhausted (HITL_REPEAT=false)" });
    }
    return json(res, 200, next);
  }

  // Streaming is intentionally unsupported - see the header comment.
  if (path.endsWith("/stream")) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ detail: "mock: streaming not implemented, client should fall back to POST" }));
  }

  return json(res, 404, { detail: `mock-act-server: no route for ${req.method} ${path}` });
});

srv.listen(PORT, HOST, () => {
  console.log(`\nmock-act-server listening on http://${HOST}:${PORT}`);
  console.log(`  script      : ${scriptName} (${script.length} entr${script.length === 1 ? "y" : "ies"}, repeat=${REPEAT})`);
  console.log(`  capture     : ${LOG_PATH}`);
  console.log(`  inspect     : http://${HOST}:${PORT}/__requests`);
  console.log(`  reset       : http://${HOST}:${PORT}/__reset`);
  console.log(`\nNext: in the extension side panel set Advanced -> Server URL to the URL above.`);
  for (const e of script) {
    const ac = e?.action ?? {};
    console.log(`    - ${ac.type}${ac.question !== undefined ? `: ${JSON.stringify(ac.question)}` : ""}${ac.options ? ` ${JSON.stringify(ac.options)}` : ""}`);
  }
  console.log("");
});
