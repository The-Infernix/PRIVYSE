// A/B: batch vs single inference on identical crops — catch batched-layout bugs.
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
    if (!file.startsWith(normalize(dir)) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404).end("nf"); return; }
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
const out = await page.evaluate(({ dataUrl }) => window.__sih._abTest(dataUrl, 6), { dataUrl });
console.log("batch :", out.batch ?? out.error);
console.log("single:", out.single ?? "");
await browser.close();
srv.close();