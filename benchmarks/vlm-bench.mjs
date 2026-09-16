import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./tasks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SERVER = process.env.BENCH_SERVER || "http://127.0.0.1:8000";
const MODEL = process.env.BENCH_MODEL || "qwen2.5vl:3b";
// Routed mode: BENCH_ROUTED=1 uses %MODEL_SMALL% for interactive steps and
// %MODEL_BIG% only when the task is a read/report task (or after a rethink).
// This is the "use the smallest model that keeps accuracy" lever for the client
// resources / latency criteria.
const ROUTED = process.env.BENCH_ROUTED === "1";
const MODEL_SMALL = process.env.BENCH_MODEL_SMALL || "qwen2.5vl:3b";
const MODEL_BIG = process.env.BENCH_MODEL_BIG || "qwen2.5vl:7b";
// A "read/report" task needs the big model's reading + aggregation ability.
const READ_TASKS = /find|report|list|what is|identify|read out|extract|answer|summar/i;
// BENCH_ROUTE=perception: server-side perception-driven routing — the request
// omits `model` and the FastAPI layer picks small/big from the on-device
// MobileViT map (server/routing.py). `model_used` is echoed back in /act.
const ROUTE_PERCEPTION = process.env.BENCH_ROUTE === "perception";
// BENCH_VISION=0 disables the in-loop on-device vision pass (faces+OCR+ViT).
// On by default: this is the real production loop — and because each step
// passes pageUrl, the perception map is cached on visually-unchanged steps,
// which the first/subsequent latency split reports.
const WITH_VISION = process.env.BENCH_VISION !== "0";
const BASE = process.env.BENCH_BASE || "http://127.0.0.1:8000/test-site";
const MAX_STEPS = Number(process.env.BENCH_STEPS || 12);
const VIEWPORT = { width: 1280, height: 800 };
const ONLY = (process.env.BENCH_ONLY || "").split(",").filter(Boolean);

/** Percentile helper for the step-latency distribution. */
function pct(vals, p) {
  const arr = (vals || []).filter((v) => typeof v === "number" && isFinite(v));
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(p * s.length));
  return +s[idx].toFixed(1);
}

async function act(task, screenshotB64, dom, history, warnings, useBig) {
  const t0 = performance.now();
  const model = ROUTE_PERCEPTION ? undefined : (ROUTED ? (useBig ? MODEL_BIG : MODEL_SMALL) : MODEL);
  const body = {
    task: task.prompt,
    history,
    screenshot_b64: screenshotB64,
    dom,
    warnings,
  };
  // Only pass `model` when not perception-routing (server decides via screenPerception).
  if (model) body.model = model;
  const res = await fetch(`${SERVER}/act`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/act HTTP ${res.status}`);
  const t1 = performance.now();
  const j = await res.json();
  return { body: j, uploadMs: t1 - t0, model: j.model_used || model || MODEL };
}

async function health() {
  try {
    const res = await fetch(`${SERVER}/health`, { timeout: 3000 });
    const j = await res.json();
    return { ok: true, vlm: j.vlm_connected, model: j.vlm_model };
  } catch (e) {
    return { ok: false, error: String(e), vlm: false };
  }
}

function reconsideredThought(rethink, resp) {
  return rethink?.thought || resp?.thought || "";
}

async function ensureInjected(page, bundleJs) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  // Inject retry loop — a navigation can invalidate __sih between the goto
  // and the script tag if the bundle is (re)added too early.
  for (let k = 0; k < 3; k++) {
    try {
      await page.addScriptTag({ content: bundleJs });
      const ok = await page.evaluate(() => typeof window.__sih?.sweepDocumentPii === "function");
      if (ok) return;
    } catch {
      // navigation in flight; wait and retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("could not inject benchmark bundle");
}

// Small VLMs routinely emit garbage `navigate` URLs that leave the page in a
// half-navigated state. Poll until the document is stable (or a timeout elapses)
// BEFORE the next screenshot / goto — a bare waitForLoadState swallow is not
// enough and a pending navigation races the next task's goto.
async function settlePage(page, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ready = await page.evaluate(() => document.readyState).catch(() => "done");
    if (ready === "complete" || ready === "done") return;
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function runTask(page, bundleJs, task) {
  // Cancel any pending navigation from the previous task before starting fresh.
  await settlePage(page);
  await page.goto("about:blank", { waitUntil: "load" }).catch(() => {});
  await settlePage(page);
  const url = `${BASE}/${task.url}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await ensureInjected(page, bundleJs);

  // Warm the real on-device vision stack (face detector + Tesseract + ViT
  // session) once per task so a cold model load never inflates the first
  // measured step. The 1×1 PNG is cheap after the models are resident.
  if (WITH_VISION) {
    await page.evaluate(async () => {
      try {
        await window.__sih.runVision({
          pageUrl: location.href,
          imageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRU5ErkJggg==",
          imageRegions: [],
        });
      } catch { /* warm is best-effort */ }
    }).catch(() => {});
  }

  const history = [];
  const warnings = [];
  const steps = [];
  let prevSignature = null;
  let done = false;
  let reason = "";

  for (let i = 0; i < MAX_STEPS; i++) {
    // Re-inject after any navigation so __sih is fresh on the current page.
    await ensureInjected(page, bundleJs).catch(() => {});
    const step = { i, actions: [] };
    const t = {};

    let t0 = performance.now();
    const shot = await page.screenshot({ type: "png" });
    t.capture = performance.now() - t0;
    const screenshotB64 = shot.toString("base64");

    // Real production path: sweep -> serialize -> sanitize (matches extension).
    const inpage = await page.evaluate(async ({ dataUrl }) => {
      const { __sih } = window;
      const proseRedactions = [];
      let t0 = performance.now();
      __sih.sweepDocumentPii((r) => proseRedactions.push(r));
      const domStart = performance.now();
      const dom = __sih.serializeDOM();
      const tSerialize = performance.now() - domStart;
      const sanStart = performance.now();
      const payload = await __sih.sanitizeForUpload(dataUrl, dom, "", [], proseRedactions);
      const tSanitize = performance.now() - sanStart;
      return { dom: payload.dom, prose: proseRedactions.length, tSerialize, tSanitize };
    }, { dataUrl: `data:image/png;base64,${screenshotB64}` });
    const dom = inpage.dom;
    t.serialize = inpage.tSerialize;
    t.sanitize = inpage.tSanitize;

    // Real production vision pass (faces + region OCR + ViT perception) with
    // the SAME pageUrl semantics as the extension (background.ts passes
    // tab.url). Perception is pixel-hash cached: a visually-unchanged step
    // after the first is served from the map, which the first/subsequent
    // latency split makes visible.
    let tVision = 0;
    let percMs = 0;
    let percCached = false;
    if (WITH_VISION) {
      const v0 = performance.now();
      const vr = await page.evaluate(async ({ dataUrl }) => {
        const { __sih } = window;
        try {
          return await __sih.runVision({
            pageUrl: window.location.href,
            imageDataUrl: dataUrl,
            imageRegions: __sih.collectImageRegions(),
          });
        } catch {
          return null;
        }
      }, { dataUrl: `data:image/png;base64,${screenshotB64}` });
      tVision = performance.now() - v0;
      percMs = vr?.perception?.ms ?? 0;
      percCached = vr?.perception?.cached === true;
    }
    t.vision = tVision;
    t.perception = percMs;
    t.perceptionCached = percCached;

    let actRes;
    const useBig = ROUTED && READ_TASKS.test(task.prompt);
    try {
      actRes = await act(task, screenshotB64, dom, history, warnings, useBig);
      t.upload = actRes.uploadMs;
      t.vlm = Math.max(0, actRes.uploadMs); // includes inference latency
    } catch (e) {
      done = true;
      reason = `VLM/server error: ${e}`;
      step.error = String(e);
      steps.push({ ...step, t });
      break;
    }
    const resp = actRes.body;
    const action = resp.action || {};

    // Execute via the real extension executor in-page.
    let execResult = "";
    let execMs = 0;
    let cmd = null;
    if (action.type && action.type !== "done") {
      const ex = await page.evaluate(async (a) => {
        const start = performance.now();
        let out = "";
        let err = null;
        try {
          out = await window.__sih.executeAction(a);
        } catch (e) {
          err = String(e);
        }
        return { out, err, ms: performance.now() - start };
      }, action);
      execResult = ex.out;
      execMs = ex.ms;
      t.execute = execMs;
      if (ex.err) {
        step.error = ex.err;
        warnings.push(`${action.type} #${action.target} failed: ${ex.err}`);
      }
      cmd = `${action.type}${action.target !== undefined ? " #" + action.target : ""}${action.text ? ' "' + action.text + '"' : ""}`;
    } else {
      t.execute = 0;
    }

    // Let any in-flight navigation from the executed action settle before the
    // next screenshot, so the VLM sees the post-navigation page. Poll the
    // readyState instead of swallowing a single waitForLoadState — pending
    // navigations to garbage URLs otherwise race the next lifecycle call.
    await settlePage(page);
    await new Promise((r) => setTimeout(r, 300));

    if (action.type === "navigate" && action.url) {
      cmd = `navigate ${action.url}`;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
    if (action.type === "press") cmd = `press ${action.key}`;

    // Track last extract for the readPage-style tasks.
    if (action.type === "extract") {
      cmd = `extract "${action.text}"`;
      const txt = (action.text || "").trim();
      if (txt) step.extract = txt;
    }

    const histEntry = {
      action,
      result: execResult || (action.type === "done" ? `done: ${action.answer ?? ""}` : ""),
      subgoal: resp.subgoal,
      blocked: resp.blocked,
    };
    history.push(histEntry);

    // Detect repeated action -> use rethink.
    const sig = JSON.stringify(action);
    if (sig === prevSignature && i > 0 && !resp.blocked) {
      const r0 = performance.now();
      let rethink = null;
      try {
        const rr = await fetch(`${SERVER}/rethink`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: task.prompt, history, screenshot_b64: screenshotB64, dom,
            model: ROUTED ? MODEL_BIG : MODEL, warnings,
          }),
        });
        rethink = await rr.json();
      } catch (e) {
        step.error = `rethink: ${e}`;
      }
      t.rethink = performance.now() - r0;
      if (rethink && rethink.action) {
        history.push({ action: rethink.action, result: "rethink", subgoal: rethink.subgoal, blocked: rethink.blocked });
        const rcmd = `${rethink.action.type}${rethink.action.target !== undefined ? " #" + rethink.action.target : ""}${rethink.action.text ? ' "' + rethink.action.text + '"' : ""}${rethink.action.url ? " " + rethink.action.url : ""}${rethink.action.key ? " " + rethink.action.key : ""}`;
        steps.push({ ...step, cmd: rcmd, thought: reconsideredThought(rethink, resp), actionType: rethink.action.type, done: rethink.done, blocked: rethink.blocked, reason: "repeat->rethink", t, model: ROUTED ? MODEL_BIG : MODEL });
        prevSignature = JSON.stringify(rethink.action);
        const ex2 = await page.evaluate(async (a) => {
          let o = "";
          try { o = await window.__sih.executeAction(a); } catch (e) { o = "err:" + e; }
          return o;
        }, rethink.action);
        if (rethink.action.type === "navigate") await page.waitForLoadState("domcontentloaded").catch(() => {});
        execResult = ex2;
        if (rethink.action.type === "extract" && rethink.action.text) step.extract = rethink.action.text;
        if (rethink.done) { done = true; reason = "done via rethink"; }
        steps[steps.length - 1].execResult = execResult;
        steps[steps.length - 1].cmd = rcmd;
      }
      t0 = performance.now();
      const success = await task.success(page, { lastExtract: step.extract || summary(history) });
      if (success) { done = true; reason = success; }
      continue;
    }

    prevSignature = sig;
    steps.push({ ...step, cmd, thought: resp.thought, actionType: action.type, done: resp.done, blocked: resp.blocked, execResult, reason: "", t, model: ROUTED ? (useBig ? MODEL_BIG : MODEL_SMALL) : MODEL });

    if (resp.done) {
      done = true;
      reason = resp.answer || "done";
      // verify against task.normal answer
      break;
    }

    const success = await task.success(page, { lastExtract: step.extract || "" });
    if (success) {
      done = true;
      reason = success;
      break;
    }
  }

  return { done, reason, steps, history };
}

function summary(history) {
  const extracts = history
    .map((h) => (h.action && h.action.type === "extract" ? h.action.text : null))
    .filter(Boolean);
  return extracts.join(" | ");
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const bundleJs = readFileSync(join(ROOT, "dist", "inpage.js"), "utf8");

try {
  const h = await health();
  console.log("server health:", JSON.stringify(h));
  if (!h.ok || !h.vlm) {
    console.error("Server/VLM not reachable. Start Ollama and the FastAPI server first.");
    process.exit(2);
  }
  if (ROUTED) {
    // Warm in usage order so the small (default) model is hot first and the
    // big model is only loaded right before the first read task — on a 4GB
    // VRAM box only one model is resident at a time, so each warm/swap costs a
    // full cold load; doing it lazily avoids wasted reloads.
    await fetch(`${SERVER}/warm?model=${encodeURIComponent(MODEL_SMALL)}`).catch(() => {});
  } else {
    await fetch(`${SERVER}/warm?model=${encodeURIComponent(MODEL)}`).catch(() => {});
  }

  const page = await browser.newPage({ viewport: VIEWPORT });
  const runs = [];
  const tasks = ONLY.length ? TASKS.filter((t) => ONLY.includes(t.id)) : TASKS;
  let bigWarmed = !ROUTED;
  for (const task of tasks) {
    console.log(`\n=== TASK ${task.id} ===`);
    if (ROUTED && !bigWarmed && READ_TASKS.test(task.prompt)) {
      await fetch(`${SERVER}/warm?model=${encodeURIComponent(MODEL_BIG)}`).catch(() => {});
      bigWarmed = true;
    }
    const run = await runTask(page, bundleJs, task).catch((e) => ({
      id: task.id,
      done: false,
      reason: `harness fault: ${e}`,
      steps: [],
      history: [],
    }));
    const ok = !!run.done;
    const stepCount = (run.steps || []).length;
    const latency = run.steps.reduce(
      (a, s) => {
        a.capture += s.t.capture || 0;
        a.serialize += s.t.serialize || 0;
        a.sanitize += s.t.sanitize || 0;
        a.vision += s.t.vision || 0;
        a.perception += s.t.perception || 0;
        a.upload += s.t.upload || 0;
        a.vlm += s.t.vlm || 0;
        a.execute += s.t.execute || 0;
        a.rethink += s.t.rethink || 0;
        return a;
      },
      { capture: 0, serialize: 0, sanitize: 0, vision: 0, perception: 0, upload: 0, vlm: 0, execute: 0, rethink: 0 },
    );
    for (const k of Object.keys(latency)) latency[k] = +(latency[k] / (stepCount || 1)).toFixed(1);
    const e2eMs = (run.steps || []).reduce(
      (a, s) =>
        a + (s.t.capture || 0) + (s.t.serialize || 0) + (s.t.sanitize || 0) +
        (s.t.vision || 0) + (s.t.upload || 0) + (s.t.execute || 0) + (s.t.rethink || 0),
      0,
    );
    runs.push({
      id: task.id,
      success: ok,
      successMessage: run.reason,
      expected: task.expected,
      modelUsed: run.steps[0]?.model || MODEL,
      steps: stepCount,
      e2eMs: Math.round(e2eMs),
      avgLatencyMs: latency,
      trace: run.steps.map((s) => ({
        cmd: s.cmd,
        thought: String(s.thought || "").slice(0, 140),
        actionType: s.actionType,
        done: s.done,
        blocked: s.blocked,
        model: s.model || null,
        t: s.t || {},
        error: s.error || null,
      })),
    });
    console.log(`  success=${ok} ${ok ? "✅" : "❌"} reason="${run.reason}" steps=${stepCount}`);
  }
  await page.close();

  const n = runs.length;
  const successCount = runs.filter((r) => r.success).length;
  const avgSteps = +(runs.reduce((a, r) => a + r.steps, 0) / (n || 1)).toFixed(1);

  // ── phase-level stats across every step ─────────────────────────────────────
  const allSteps = runs.flatMap((r) => r.trace || []);
  const firstSteps = [];
  const subSteps = [];
  for (const r of runs) {
    const s = r.trace || [];
    if (s.length > 0) firstSteps.push(s[0]);
    for (let i = 1; i < s.length; i++) subSteps.push(s[i]);
  }
  const PHASES = ["capture", "serialize", "sanitize", "vision", "perception", "upload", "vlm", "execute", "rethink"];
  const phaseArrays = Object.fromEntries(PHASES.map((k) => [k, allSteps.map((s) => s.t?.[k] || 0)]));
  const waterfall = Object.fromEntries(
    PHASES.map((k) => {
      const vals = phaseArrays[k];
      return [k, {
        mean: +(vals.reduce((a, b) => a + b, 0) / (vals.length || 1)).toFixed(1),
        p50: pct(vals, 0.5),
        p95: pct(vals, 0.95),
        min: pct(vals, 0),
        max: pct(vals, 1),
      }];
    }),
  );
  const stepTotal = (s) => (s?.t?.capture || 0) + (s?.t?.serialize || 0) + (s?.t?.sanitize || 0) +
    (s?.t?.vision || 0) + (s?.t?.upload || 0) + (s?.t?.execute || 0) + (s?.t?.rethink || 0);
  const firstMean = firstSteps.length
    ? +(firstSteps.reduce((a, s) => a + stepTotal(s), 0) / firstSteps.length).toFixed(1)
    : 0;
  const subMean = subSteps.length
    ? +(subSteps.reduce((a, s) => a + stepTotal(s), 0) / subSteps.length).toFixed(1)
    : 0;
  const e2eArr = runs.map((r) => r.e2eMs || 0);
  const percFirst = firstSteps.map((s) => s.t?.perception || 0);
  const percSub = subSteps.map((s) => s.t?.perception || 0);
  const visionFirst = firstSteps.map((s) => s.t?.vision || 0);
  const visionSub = subSteps.map((s) => s.t?.vision || 0);

  const report = {
    generated_at: new Date().toISOString(),
    server: SERVER,
    model: MODEL,
    routed: ROUTED,
    route_perception: ROUTE_PERCEPTION,
    with_vision: WITH_VISION,
    model_small: ROUTED ? MODEL_SMALL : null,
    model_big: ROUTED ? MODEL_BIG : null,
    steps_budget: MAX_STEPS,
    task_success: {
      passed: successCount,
      total: n,
      rate: +(successCount / (n || 1)).toFixed(2),
    },
    agent_steps: { mean: avgSteps, max: Math.max(...runs.map((r) => (r.trace?.length || 1))), min: Math.min(...runs.map((r) => (r.trace?.length || 1))) },
    latency_waterfall_ms: waterfall,
    // First step of each task vs the rest — next steps reuse the perception map
    // on visually-unchanged screens, so subsequent steps should report a much
    // smaller perception/vision time (pixel-hash perception cache).
    first_vs_subsequent_ms: {
      per_step: { first: firstMean, subsequent: subMean },
      perception_ms: { first: pct(percFirst, 0.5), subsequent: pct(percSub, 0.5) },
      vision_ms: { first: pct(visionFirst, 0.5), subsequent: pct(visionSub, 0.5) },
    },
    task_e2e_ms: {
      mean: Math.round(e2eArr.reduce((a, b) => a + b, 0) / (e2eArr.length || 1)),
      p50: Math.round(pct(e2eArr, 0.5)),
      p95: Math.round(pct(e2eArr, 0.95)),
      per_run: e2eArr,
    },
    runs,
  };
  mkdirSync(join(ROOT, "results"), { recursive: true });
  writeFileSync(join(ROOT, "results", "vlm-accuracy.json"), JSON.stringify(report, null, 2));
  console.log(`\nTASK SUCCESS: ${successCount}/${n} (${(successCount / n * 100).toFixed(0)}%)`);
  console.log(`AVG STEPS/TASK: ${avgSteps}`);
  console.log("WATERFALL (ms/step, mean | p50 | p95):");
  for (const [k, v] of Object.entries(waterfall)) console.log(`  ${k}: ${v.mean} | ${v.p50} | ${v.p95}`);
  console.log(`FIRST vs SUBSEQUENT step (per-step total): ${firstMean} ms vs ${subMean} ms`);
  console.log(`  perception ms: first ${pct(percFirst, 0.5)} vs subsequent ${pct(percSub, 0.5)} (cached map)`);
  console.log(`  vision ms:     first ${pct(visionFirst, 0.5)} vs subsequent ${pct(visionSub, 0.5)}`);
  console.log(`TASK E2E ms: mean ${report.task_e2e_ms.mean} | p50 ${report.task_e2e_ms.p50} | p95 ${report.task_e2e_ms.p95}`);
} finally {
  await browser.close();
}