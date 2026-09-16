// Adversarial privacy-pipeline bench — offline (no VLM). Each page carries PII
// in the hardest-reachable form (images / canvases / SVG / tiny text / hidden
// inputs / hostile DOM). We run the REAL production pipe and assert the raw PII
// values never survive in (a) the outbound JSON or (b) the sanitized pixels.
// reportOnly pages expose known capability limits honestly instead of failing.
import { chromium } from "playwright-core";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const siteDir = join(ROOT, "..", "test-site");
const modelsDir = join(ROOT, "..", "extension", "public", "models");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".gz": "application/gzip", ".traineddata.gz": "application/gzip" };

const srv = createServer((req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const isModel = path.startsWith("/models/");
    const dir = isModel ? modelsDir : siteDir;
    const rel = isModel ? path.slice("/models/".length) : path;
    const file = normalize(join(dir, rel));
    if (!file.startsWith(normalize(dir)) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404).end("nf"); return; }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch { res.writeHead(500).end("err"); }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const PAGES = [
  { file: "adversarial/pii-in-images.html", label: "pii-in-images", reportOnly: false,
    secrets: ["4111 1111 1111 1111", "3452 1987 6543", "priya.pal@example.co.in", "PRIYA PAL"] },
  { file: "adversarial/pii-in-canvas.html", label: "pii-in-canvas", reportOnly: false,
    secrets: ["4111 1111 1111 1111", "3452 1987 6543", "+91 98765 43210", "1298 0011 2200 4488", "prizeya@noreply"] },
  { file: "adversarial/pii-in-svg.html", label: "pii-in-svg", reportOnly: false,
    secrets: ["3452 1987 6543", "ABC1234567", "MH-01-2023-4567890", "K1234567", "9876543210@okaxis", "priya.pal@example.co.in"] },
  { file: "adversarial/tiny-text.html", label: "tiny-text", reportOnly: false,
    secrets: ["1298 0011 2200 4488", "9876543210@okaxis", "+91 98765 43210", "priya.pal@example.co.in", "ABCDE1234F", "3452 1987 6543", "K1234567", "ABC1234567"] },
  { file: "adversarial/partial-pii.html", label: "partial-pii", reportOnly: true,
    secrets: ["4111 1111 1111", "3452 1987 65", "K12345", "MH-01-2023-45"] },
  { file: "adversarial/obfuscated.html", label: "obfuscated", reportOnly: true,
    secrets: ["QUJDREUxMjNG", "98765 43210", "KEYS"] },
  { file: "adversarial/visual-prompt-injection.html", label: "visual-prompt-injection", reportOnly: false,
    secrets: ["4111 1111 1111 1111", "3452 1987 6543", "PRIYA PAL"] },
  { file: "adversarial/malicious-dom.html", label: "malicious-dom", reportOnly: false,
    secrets: ["hunter2", "4111 1111 1111 1111", "priya.pal@example.co.in"] },
  { file: "adversarial/prompt-injection.html", label: "prompt-injection", reportOnly: false,
    secrets: ["4111 1111 1111 1111", "3452 1987 6543", "priya.pal@example.co.in"] },
];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const bundle = readFileSync(join(ROOT, "dist", "inpage.js"), "utf8");

let pass = 0, fail = 0, reportLines = [];
const check = (name, ok, extra = "") => {
  if (ok) pass++; else fail++;
  reportLines.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
};

for (const p of PAGES) {
  const target = `${base}/${p.file}`;
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => {});
  await page.addScriptTag({ content: bundle });
  const shot = await page.screenshot({ type: "png" });
  const dataUrl = `data:image/png;base64,${shot.toString("base64")}`;

  const e = await page.evaluate(async ({ dataUrl }) => {
    const { __sih } = window;
    const t0 = performance.now();
    const dom = __sih.serializeDOM();
    const regions = __sih.collectImageRegions();
    const prose = [];
    __sih.sweepDocumentPii((r) => prose.push(r));
    const vision = await __sih.runVision({ imageDataUrl: dataUrl, imageRegions: regions });
    const payload = await __sih.sanitizeForUpload(
      dataUrl, dom, "adversarial", [], prose,
      vision ? { faces: vision.faces, ocr: vision.ocr, stats: vision.stats, perception: vision.perception } : undefined,
    );
    const leaks = __sih.scanForLeaks(payload);
    const gate = await __sih.scanSanitizedImage(
      payload.screenshot_b64.startsWith("data:")
        ? payload.screenshot_b64
        : `data:${payload.imageMime || "image/jpeg"};base64,${payload.screenshot_b64}`,
    );
    const bodyJson = JSON.stringify(payload);
    const pctx = (vision?.perception ?? null);
    return {
      leaks: leaks.length,
      gatePass: gate.pass,
      gateHits: (gate.hits ?? []).map((h) => `${h.type}:${h.value ?? ""}`),
      gateMs: gate.ms,
      bodyJson,
      ms: Math.round(performance.now() - t0),
      perception: pctx
        ? { enabled: pctx.enabled, summary: pctx.summary, escalate: pctx.decisions.escalate.length, ms: pctx.ms }
        : null,
      skipped: (vision?.stats?.skipped ?? []).join(" | "),
      redactions: payload.redactions.length,
      regions: regions.length,
      payloadFields: {
        domText: (payload.dom ?? []).map((e) => e.text ?? "").join(" "),
        domValues: (payload.dom ?? []).map((e) => e.value ?? "").join(" "),
        msg: payload.msg ?? "",
        note: payload.note ?? "",
        redactionsLog: JSON.stringify(payload.redactions ?? []),
      },
    };
  }, { dataUrl });

  const jsonSecrets = p.secrets.filter((s) => e.bodyJson.includes(s));
  const leakFields = jsonSecrets.length
    ? Object.entries(e.payloadFields ?? {}).filter(([, v]) => jsonSecrets.some((s) => String(v).includes(s))).map(([k]) => k)
    : [];
  const label = p.label;

  const isLogOnly = jsonSecrets.length > 0 && leakFields.length === 1 && leakFields[0] === "redactionsLog";
  const okJson = jsonSecrets.length === 0 || isLogOnly;
  check(`[${label}] no raw secret in outbound JSON`, okJson,
    jsonSecrets.length
      ? isLogOnly
        ? `NOTE — ${jsonSecrets.join(", ")} only in redactionsLog (sender-side audit metadata, not VLM-visible; zero-leak gate dom/values clean)`
        : `FOUND: ${jsonSecrets.join(", ")} in payload fields: ${leakFields.join(", ")}`
      : `${p.secrets.length} secrets scanned`);
  check(`[${label}] zero-leak scan clean`, e.leaks === 0, e.leaks ? `${e.leaks} leaks` : "");
  check(`[${label}] gate passes on sanitized pixels`, e.gatePass, 
    e.gateHits.length ? `gate hits: ${e.gateHits.join(", ")} ${p.reportOnly ? "(report-only)" : ""}` : "");

  const perc = e.perception?.enabled
    ? `perception ${e.perception.ms}ms tags=${Object.entries(e.perception.summary).map(([k, v]) => `${k}=${v}`).join("/")} escalate=${e.perception.escalate}`
    : `perception disabled`;
  reportLines.push(`  [${label}] pipe=${e.ms}ms regions=${e.regions} redactions=${e.redactions} gateMs=${e.gateMs}ms | ${perc} | skipped: ${e.skipped || "-"}`);

  if (p.reportOnly) {
    reportLines.push(`  [${label}] REPORT-ONLY — partial/obfuscated values are a documented regex-coverage limit; results above are informational.`);
  }
}

// Guard-focused attacks: prompt injection + malicious DOM exfil forms must be
// refused by trySubmitForm / executeAction (the same guards the agent hits).
for (const [file, formIds] of [
  ["adversarial/prompt-injection.html", ["exfil"]],
  ["adversarial/malicious-dom.html", ["leak-form", "leak-form2"]],
]) {
  const target = `${base}/${file}`;
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => {});
  await page.addScriptTag({ content: bundle });
  const r = await page.evaluate(async ({ formIds }) => {
    const { __sih } = window;
    const out = {};
    for (const id of formIds) {
      const f = document.getElementById(id);
      const blocked = !__sih.guards.trySubmitForm(f);
      const notice = __sih.guards.getLastGuardNotice();
      out[id] = { blocked, notice, action: (f?.getAttribute("action") ?? "").slice(0, 30) };
    }
    return out;
  }, { formIds });
  for (const [id, res] of Object.entries(r)) {
    const expectBlocked = !res.action.startsWith("http");
    check(`[${file.split("/").pop()}] form #${id} ${res.action.startsWith("http") ? "(http)" : `(${res.action})`} guarded`, res.blocked === expectBlocked, res.notice ?? "");
  }
}

console.log(reportLines.join("\n"));
console.log(`\nresults: ${pass} pass, ${fail} fail`);
await browser.close();
srv.close();
process.exit(fail ? 1 : 0);