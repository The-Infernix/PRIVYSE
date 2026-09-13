// Minimal browser probe for the on-device ViT perception path.
// Loads <img> of a GT page, runs __sih.perceiveScreen via the real bundled
// inpage.js, prints enabled/ms/tiles/decisions. Run from benchmarks dir.
import { chromium } from "playwright-core";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modelsDir = join(__dirname, "..", "extension", "public", "models");
const siteDir = join(__dirname, "..", "test-site");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".onnx": "application/octet-stream", ".jpg": "image/jpeg", ".png": "image/png" };

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

const shot = await page.screenshot({ type: "jpeg", quality: 82 });
const dataUrl = `data:image/jpeg;base64,${shot.toString("base64")}`;

const out = await page.evaluate(async ({ dataUrl }) => {
  const { __sih } = window;
  const regions = __sih.collectImageRegions();
  // Show region geometry + screenshot geometry for debugging.
  const shotW = document.createElement("img");
  shotW.src = dataUrl;
  await new Promise(r => { shotW.onload = r; shotW.onerror = r; });
  const shotDim = [shotW.naturalWidth, shotW.naturalHeight];
  const cold = await __sih.perceiveScreen({ imageDataUrl: dataUrl, budgetMs: 8000, maxTiles: 6 });
  const t0 = performance.now();
  const p = await __sih.perceiveScreen({ imageDataUrl: dataUrl, imageRegions: regions, budgetMs: 8000, maxTiles: 6 });
  const wall = Math.round(performance.now() - t0);
  return { wall, cold: cold.ms, regions, tiles: p.tiles.map((t) => ({x:t.x,y:t.y,w:t.w,h:t.h,tag:t.tag,conf:t.conf})), shotDim, p };
}, { dataUrl });
await browser.close();
console.log("screenshot dim:", out.shotDim);
console.log("regions fed:", out.regions.length);
for (const r of out.regions.slice(0,6)) console.log("  region:", r);
console.log("tiles:");
for (const t of out.tiles) console.log(`  ${t.x},${t.y} ${t.w}x${t.h}  tag=${t.tag} conf=${(t.conf*100).toFixed(0)}%`);
console.log("cold ms:", out.cold, "| warm wall:", out.wall + "ms (incl decode)");
console.log("enabled:", out.p.enabled, "| p.ms:", out.p.ms);
console.log("summary:", JSON.stringify(out.p.summary));
console.log("escalate:", out.p.decisions.escalate.length, "ocrPriority:", out.p.decisions.ocrPriority.length, "captchaLike:", out.p.decisions.captchaLike.length);
for (const d of out.p.decisions.escalate.slice(0,4)) console.log("  esc region:", d.region.join(","), "|", d.reason);
srv.close();