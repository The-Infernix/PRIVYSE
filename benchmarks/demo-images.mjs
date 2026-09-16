// demo-images.mjs â€” render honest, in-repo README hero images by running the
// REAL production sanitizer pipeline (inpage bundle) against a GT-labelled
// page, then saving:
//   docs/readme/demo-user-view.png  â€” raw screen (what a naive agent uploads)
//   docs/readme/demo-gate-view.png  â€” sanitized pixels + redaction boxes & tokens
//   docs/readme/demo-model-view.png â€” the sanitized bytes the VLM actually sees
//
// Run: node demo-images.mjs     (no server / Ollama needed)
import { chromium } from "playwright-core";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteDir = join(__dirname, "..", "test-site");
const modelsDir = join(__dirname, "..", "extension", "public", "models");
const outDir = join(__dirname, "..", "docs", "readme");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PAGE = process.env.DEMO_PAGE || "/flight-payment.html";
const SLUG = process.env.DEMO_SLUG || PAGE.replace(/^\//, "").replace(/\.html$/, "").replace(/\//g, "-");
const VIEW = { width: 1280, height: 2400 };
const MIME = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".onnx": "application/octet-stream", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gz": "application/gzip", ".traineddata.gz": "application/gzip" };

mkdirSync(outDir, { recursive: true });

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

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
const bundle = readFileSync(join(__dirname, "dist", "inpage.js"), "utf8");

await page.goto(`${base}${PAGE}`, { waitUntil: "load" });
await page.waitForLoadState("load").catch(() => {});
await page.evaluate(() => window.scrollTo(0, 0));
await page.addScriptTag({ content: bundle });
await page.waitForTimeout(300);

// 1) RAW view â€” exactly what a naive agent would upload (grab BEFORE the
//    sweep so the raw PII is still visible in the shot).
const raw = await page.screenshot({ type: "png" }); // device-px == css-px (dpr 1)
await (await import("node:fs")).promises.writeFile(join(outDir, `demo-${SLUG}-user-view.png`), raw);
const dataUrl = `data:image/png;base64,${raw.toString("base64")}`;

// 2) Run ON-DEVICE vision + the real sanitizer, and fetch redaction boxes.
const payload = await page.evaluate(async (screenshot) => {
  const { __sih } = window;
  const vision = await __sih.runVision({ imageDataUrl: screenshot });
  const dom = __sih.serializeDOM();
  const out = await __sih.sanitizeForUpload(screenshot, dom, "", [], [], vision ?? undefined);
  return {
    screenshot_b64: out.screenshot_b64,
    mime: out.imageMime,
    redactions: (out.redactions ?? []).map((r) => ({
      type: r.type, tier: r.tier, token: r.token ?? null, bbox: r.bbox,
      source: r.source, masked: r.masked ?? null,
    })),
    vision: vision ? { faces: vision.faces.length, ocr: vision.ocr.length, perception: !!vision.perception } : null,
  };
}, dataUrl);

const sanData = `data:${payload.mime};base64,${payload.screenshot_b64}`;
const boxes = payload.redactions.filter((r) => r.bbox && r.bbox[2] > 4 && r.bbox[3] > 4);
const stats = `${boxes.length} redactions; faces=${payload.vision?.faces}, ocr=${payload.vision?.ocr}, perception=${payload.vision?.perception}`;
console.log(stats);

// 3) GATE view â€” sanitized pixels + redaction boxes/tokens drawn over them.
const gv = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
await gv.setContent(`<div id="root" style="position:relative;width:${VIEW.width}px;font-family:Consolas,monospace;"></div>`);
await gv.evaluate(async ({ sanData, boxes }) => {
  const root = document.getElementById("root");
  const img = document.createElement("img");
  img.src = sanData;
  img.style.cssText = `display:block;width:${innerWidth}px;height:auto;position:relative;z-index:1;`;
  root.appendChild(img);
  for (const b of boxes) {
    const [x, y, w, h] = b.bbox;
    const box = document.createElement("div");
    box.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:2;` +
      `box-shadow:inset 0 0 0 3px ${b.tier === "A" ? "#ef4444" : b.tier === "B" ? "#f97316" : "#a855f7"};`;
    const tag = document.createElement("span");
    const label = b.token ? `${b.type} ${b.token}` : `${b.type}`;
    tag.textContent = label;
    tag.style.cssText = `position:absolute;left:0;top:-18px;white-space:nowrap;font-size:12px;font-weight:700;` +
      `padding:1px 6px;border-radius:3px;color:#fff;z-index:3;` +
      `background:${b.tier === "A" ? "#ef4444" : b.tier === "B" ? "#f97316" : "#a855f7"};`;
    box.appendChild(tag);
    root.appendChild(box);
  }
}, { sanData, boxes });
await gv.screenshot({ path: join(outDir, `demo-${SLUG}-gate-view.png`) });

// 4) MODEL view â€” the sanitized image alone (what the VLM receives).
await gv.evaluate(() => { document.getElementById("root").innerHTML = ""; });
await gv.evaluate((sanData) => {
  const root = document.getElementById("root");
  const img = document.createElement("img");
  img.src = sanData;
  img.style.cssText = `display:block;width:${innerWidth}px;height:auto;`;
  root.appendChild(img);
}, sanData);
await gv.screenshot({ path: join(outDir, `demo-${SLUG}-model-view.png`) });

// 1b) raw view already written above (before the sweep mutated the DOM).
console.log(`wrote: ${join(outDir, `demo-${SLUG}-user-view.png`)}`);
console.log(`wrote: ${join(outDir, `demo-${SLUG}-gate-view.png`)}`);
console.log(`wrote: ${join(outDir, `demo-${SLUG}-model-view.png`)}`);
await browser.close();
srv.close();

