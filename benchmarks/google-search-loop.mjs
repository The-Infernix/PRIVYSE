import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SERVER = process.env.BENCH_SERVER || "http://127.0.0.1:8000";
const MODEL = process.env.BENCH_MODEL || "qwen2.5vl:3b";
const MAX_STEPS = Number(process.env.BENCH_STEPS || 12);
const TASK = process.env.BENCH_TASK || 'Search for "student login portal" and report the first result.';
const START_URL = process.env.BENCH_URL || "https://www.google.com";
const VIEWPORT = { width: 1280, height: 800 };

// ── Mirrors of the extension's auto-type escalator (entrypoints/background.ts) ──
function deriveTypePhrase(task) {
  const t = task.trim();
  const q = /"([^"]{1,50})"/.exec(t);
  if (q) return q[1];
  const m = /search\s+(?:for\s+)?(.+)$/i.exec(t);
  if (m) {
    const p = m[1].replace(/\s+(on|in|at|via|using|to|page|website|site)\s+\S+.*$/i, "").trim();
    if (p) return p.slice(0, 50);
  }
  return t.replace(/^(please|i need to|can you|go to)\s+/i, "").replace(/\s+(so that|and|please).*$/i, "").trim().slice(0, 40);
}

async function act(task, screenshotB64, dom, history, warnings) {
  const t0 = performance.now();
  const res = await fetch(`${SERVER}/act`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task, history, screenshot_b64: screenshotB64, dom, model: MODEL, warnings }),
  });
  if (!res.ok) throw new Error(`/act HTTP ${res.status}`);
  return { body: await res.json(), uploadMs: performance.now() - t0 };
}

async function health() {
  try {
    const res = await fetch(`${SERVER}/health`);
    const j = await res.json();
    return { ok: j.vlm_connected, model: j.vlm_model };
  } catch (e) {
    return { ok: false, model: String(e) };
  }
}

async function ensureInjected(page, bundleJs) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  for (let k = 0; k < 3; k++) {
    try {
      await page.addScriptTag({ content: bundleJs });
      const ok = await page.evaluate(() => typeof window.__sih?.executeAction === "function");
      if (ok) return;
    } catch { /* navigation in flight */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("could not inject benchmark bundle");
}

async function settlePage(page, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ready = await page.evaluate(() => document.readyState).catch(() => "done");
    if (ready === "complete" || ready === "done") return;
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function acceptConsent(page) {
  if (!/consent\.google\.com/.test(page.url())) return;
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    const b = btns.find((x) => /accept all/i.test(x.textContent || ""));
    if (b) b.click();
  }).catch(() => {});
  await settlePage(page, 3000);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const bundleJs = readFileSync(join(ROOT, "dist", "inpage.js"), "utf8");

try {
  const h = await health();
  console.log("server health:", JSON.stringify(h));
  if (!h.ok) { console.error("Server/VLM not reachable."); process.exit(2); }
  await fetch(`${SERVER}/warm?model=${encodeURIComponent(MODEL)}`).catch(() => {});

  const page = await browser.newPage({ viewport: VIEWPORT });
  const context = page.context();
  await context.route("**/log?**", (r) => r.fulfill({ status: 204 })).catch(() => {});
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await acceptConsent(page);
  await ensureInjected(page, bundleJs);
  await settlePage(page);

  const history = [];
  const warnings = [];
  const trace = [];
  const clickedTypeables = new Set();
  let prevSig = "";
  let repeatCount = 0;
  let done = false;
  let reason = "";
  let autoTypes = 0;

  for (let i = 0; i < MAX_STEPS && !done; i++) {
    await ensureInjected(page, bundleJs).catch(() => {});
    const shot = await page.screenshot({ type: "png" });
    const screenshotB64 = shot.toString("base64");

    const inpage = await (async () => {
      for (let k = 0; k < 3; k++) {
        try {
          return await page.evaluate(async ({ dataUrl }) => {
            const { __sih } = window;
            const prose = [];
            __sih.sweepDocumentPii((r) => prose.push(r));
            const dom = __sih.serializeDOM();
            const payload = await __sih.sanitizeForUpload(dataUrl, dom, "", [], prose);
            return { dom: payload.dom, prose: prose.length };
          }, { dataUrl: `data:image/png;base64,${screenshotB64}` });
        } catch {
          await ensureInjected(page, bundleJs).catch(() => {});
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      throw new Error("could not serialize DOM (page kept navigating)");
    })();
    const dom = inpage.dom;

    let resp, uploadMs;
    try {
      const r = await act(TASK, screenshotB64, dom, history, warnings);
      resp = r.body; uploadMs = r.uploadMs;
    } catch (e) {
      reason = `VLM error: ${e}`;
      trace.push({ step: i + 1, err: String(e) });
      done = true;
      break;
    }
    const action = resp.action || {};

    // Auto-type escalator (mirrors background.ts): re-clicking a KNOWN text
    // field → inject `type` + Enter instead of looping. First click records the
    // field; a later click on it triggers the escalator.
    let staged = null; // action to execute this step
    let note = "";
    const isKnownTypeable = action.type === "click" && clickedTypeables.has(action.target);
    if (action.type === "click") {
      const el = Array.isArray(dom) ? dom.find((e) => e.id === action.target) : null;
      if (el && /^(input|textarea|select)$/i.test(String(el.tag))) clickedTypeables.add(el.id);
    }
    if (isKnownTypeable) {
      const phrase = deriveTypePhrase(TASK);
      if (phrase) {
        autoTypes++;
        const typeStaged = { type: "type", target: action.target, text: phrase };
        const typeOut = await page.evaluate(async (a) => {
          try { return await window.__sih.executeAction(a); } catch (e) { return "err:" + e; }
        }, typeStaged);
        const enterOut = await page.evaluate(async () => {
          try { return await window.__sih.executeAction({ type: "press", key: "enter" }); } catch (e) { return "err:" + e; }
        }).catch(() => "");
        note = `AUTO-TYPE "${phrase}" -> #${action.target} | ${typeOut} | ${enterOut}`;
        trace.push({ step: i + 1, cmd: note, thought: String(resp.thought || "").slice(0, 120), url: page.url() });
        history.push({ action: typeStaged, result: note, subgoal: resp.subgoal, blocked: false });
        warnings.push(`While stuck you auto-typed "${phrase}" into <field> #${action.target} and pressed Enter. Continue from the results.`);
        await settlePage(page);
        await new Promise((r) => setTimeout(r, 400));
        // Enter submitted the form — the page should now be on the search URL
        // (headless Chrome gets Google's /sorry anti-bot interstitial instead
        // of results; a real browser shows the result page).
        let finalUrl = "";
        for (let k = 0; k < 20; k++) {
          finalUrl = page.url();
          if (finalUrl.includes("/search") || finalUrl.includes("%2Fsearch")) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        if (/\bq=/.test(finalUrl)) {
          done = true;
          reason = `search submitted: ${finalUrl.slice(0, 90)}`;
        } else {
          done = true;
          reason = `Enter submitted but landed on: ${finalUrl.slice(0, 90)}`;
        }
        trace.push({ step: i + 1, cmd: `AUTO-TYPE+ENTER → ${reason}`, url: finalUrl });
        break;
      }
    } else {
      staged = action;
    }

    let execResult = "";
    if (staged && staged.type && staged.type !== "done") {
      const ex = await page.evaluate(async (a) => {
        const t0 = performance.now();
        let out = "", err = null;
        try { out = await window.__sih.executeAction(a); } catch (e) { err = String(e); }
        return { out, err, ms: performance.now() - t0 };
      }, staged);
      execResult = ex.out;
      if (staged.type === "click") {
        const el = Array.isArray(dom) ? dom.find((e) => e.id === staged.target) : null;
        if (ex.err) warnings.push(`${staged.type} #${staged.target} failed: ${ex.err}`);
      }
      if (ex.err) { warnings.push(`${staged.type} failed: ${ex.err}`); reason = `exec error: ${ex.err}`; }
      const cmd = `${staged.type}${staged.target !== undefined ? " #" + staged.target : ""}${staged.text ? ' "' + staged.text + '"' : ""}${staged.url ? " " + staged.url : ""}${staged.key ? " " + staged.key : ""}`;
      trace.push({ step: i + 1, cmd, note, thought: String(resp.thought || "").slice(0, 120), execResult, err: ex.err || null, url: page.url() });
    } else {
      trace.push({ step: i + 1, cmd: JSON.stringify(action), thought: String(resp.thought || "").slice(0, 120), url: page.url() });
    }

    if (!note) history.push({ action, result: execResult, subgoal: resp.subgoal, blocked: resp.blocked });
    await settlePage(page);
    await new Promise((r) => setTimeout(r, 300));

    // Repeat / rethink path (mirrors harness) — escalator already won for typeables.
    const sig = JSON.stringify(action);
    if (sig === prevSig) repeatCount++; else { repeatCount = 1; prevSig = sig; }
    let rethinked = false;
    if (repeatCount >= 2 && !note && !resp.blocked) {
      try {
        const rr = await fetch(`${SERVER}/rethink`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task: TASK, history, screenshot_b64: screenshotB64, dom, model: MODEL, warnings }),
        });
        const rt = await rr.json();
        trace.push({ step: i + 1, cmd: `RETHINK ${JSON.stringify(rt.action || {})} → ${rt.thought || ""}` });
        history.push({ action: rt.action, result: "rethink", subgoal: rt.subgoal, blocked: rt.blocked });
        rethinked = true;
      } catch { }
    }

    // Camera reality-check of the page state.
    const state = await page.evaluate(() => ({
      url: location.href,
      hasResults: !!document.querySelector("#search, #rso, [data-sokoban-container]"),
      h3: [...document.querySelectorAll("h3")].slice(0, 3).map((h) => h.textContent?.slice(0, 40)),
    }));

    if (/\bq=/.test(state.url) && !/sorry/i.test(state.url)) {
      done = true;
      reason = `search submitted. h3: ${state.h3.join(" | ") || "(none)"}`;
      break;
    }
    if (resp.done) { done = true; reason = `VLM reported done: ${resp.answer || ""}`; break; }
  }

  const report = {
    generated_at: new Date().toISOString(),
    model: MODEL,
    task: TASK,
    max_steps: MAX_STEPS,
    success: done,
    reason,
    auto_typed: autoTypes,
    steps_taken: trace.length,
    trace,
    url_at_end: await page.evaluate(() => location.href).catch(() => ""),
  };
  mkdirSync(join(ROOT, "results"), { recursive: true });
  writeFileSync(join(ROOT, "results", "google-search-loop.json"), JSON.stringify(report, null, 2));
  console.log(`\nTASK: ${TASK}`);
  console.log(`AUTO-TYPES: ${autoTypes}`);
  console.log(`STEPS: ${trace.length}`);
  console.log(`SUCCESS: ${done ? "YES ✅" : "NO ❌"} — ${reason}`);
  if (!done) console.log("TRACE:"), console.log(trace.map((t) => `  [${t.step}] ${t.cmd}${t.err ? " ERR:" + t.err : ""}`).join("\n"));
  await page.close();
} finally {
  await browser.close();
}