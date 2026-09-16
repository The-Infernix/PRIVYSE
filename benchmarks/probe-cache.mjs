// Probe the same-page perception cache (pixel-hash LRU, opt-in pageUrl).
// Verifies via the REAL runVision path (background->offscreen contract):
//   1. same pixels + same pageUrl  -> cached hit (ms=0, cached=true)
//   2. changed pixels + same url   -> cache miss (runs fresh)
//   3. no pageUrl                  -> never cached
// Run from benchmarks dir (needs node scripts/build.mjs first).
import { chromium } from "playwright-core";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modelsDir = join(__dirname, "..", "extension", "public", "models");
const siteDir = join(__dirname, "..", "test-site");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".onnx": "application/octet-stream", ".jpg": "image/jpeg", ".png": "image/png", ".js": "text/javascript", ".gz": "application/gzip", ".traineddata.gz": "application/gzip" };

const srv = createServer((req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const isModel = path.startsWith("/models/");
    const dir = isModel ? modelsDir : siteDir;
    const rel = isModel ? path.slice("/models/".length) : path;
    const file = normalize(join(dir, rel));
    if (!file.startsWith(normalize(dir)) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end("nf"); return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch { res.writeHead(500).end("err"); }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 2400 } });
await page.goto(`${base}/pii-in-the-wild.html`, { waitUntil: "networkidle" });

const bundle = readFileSync(join(__dirname, "dist", "inpage.js"), "utf8");
await page.addScriptTag({ content: bundle });

// Warm the model stack so timings below are inference-only.
await page.evaluate(async () => {
  await window.__sih.runVision({ pageUrl: "warm", imageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRU5ErkJggg==", imageRegions: [] });
});

const shot = async () => {
  const s = await page.screenshot({ type: "png" });
  return `data:image/png;base64,${s.toString("base64")}`;
};

const vision = (pageUrl, dataUrl) => page.evaluate(async ({ pageUrl, dataUrl }) => {
  const r = await window.__sih.runVision({ pageUrl, imageDataUrl: dataUrl, imageRegions: window.__sih.collectImageRegions() });
  return { cached: r.perception?.cached === true, ms: r.perception?.ms ?? -1, summary: r.perception?.summary ?? null, enabled: r.perception?.enabled ?? false };
}, { pageUrl, dataUrl });

let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`); if (!ok) fails++; };

const a1 = await shot();
const r1 = await vision("https://x/page", a1);
check("run 1 (cold) not cached", r1.cached === false && r1.enabled, `cached=${r1.cached} ms=${r1.ms}`);

const r2 = await vision("https://x/page", a1);
check("run 2 identical pixels -> cached hit", r2.cached === true && r2.ms === 0, `cached=${r2.cached} ms=${r2.ms} summary=${JSON.stringify(r2.summary)}`);
check("cached map matches fresh map", JSON.stringify(r1.summary) === JSON.stringify(r2.summary), `same=${JSON.stringify(r1.summary) === JSON.stringify(r2.summary)}`);

await page.evaluate(() => { document.body.style.background = "#fedcba"; });
const b1 = await shot();
const r3 = await vision("https://x/page", b1);
check("changed pixels -> cache miss", r3.cached === false && r3.ms > 0, `cached=${r3.cached} ms=${r3.ms}`);

const r4 = await vision("https://x/page", b1);
check("missed map now cached", r4.cached === true && r4.ms === 0, `cached=${r4.cached} ms=${r4.ms}`);

await page.evaluate(() => { document.body.style.background = ""; });
const a2 = await shot();
const r5 = await vision("https://x/page", a2);
check("reverting to A -> hit again (LRU holds both A and B)", r5.cached === true && r5.ms === 0, `cached=${r5.cached} ms=${r5.ms}`);

const r6 = await vision(null, a2);
check("no pageUrl -> never cached", r6.cached === false, `cached=${r6.cached}`);
const r7 = await vision("https://y/page", a2);
check("different url + same pixels -> no cross-page hit", r7.cached === false, `cached=${r7.cached}`);

console.log(`results: ${fails === 0 ? "all pass" : fails + " fail(s)"}`);
await browser.close();
srv.close();
process.exit(fails === 0 ? 0 : 1);