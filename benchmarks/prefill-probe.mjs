// prefill-vs-decode probe: stream one 7b call, report time-to-first-token
// (prefill) vs total (prefill + decode) on the real sanitized view.
import { chromium } from "./node_modules/playwright-core/index.mjs";
import { readFileSync } from "node:fs";

const MODEL = process.argv[2] || "qwen2.5vl:7b";
const PAGE = process.argv[3] || "bank-transfer.html";
const WIDTH = Number(process.argv[4] || 800);
const bundle = readFileSync("./dist/inpage.js", "utf8");

const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.goto(`http://127.0.0.1:8000/test-site/${PAGE}`);
await p.addScriptTag({ content: bundle });
const shot = (await p.screenshot({ type: "png" })).toString("base64");
const dom = await p.evaluate(() => window.__sih.serializeDOM());
const jpeg = await p.evaluate(async (args) => {
  const [base, w] = args;
  const img = new Image();
  img.src = "data:image/png;base64," + base;
  await img.decode();
  const h = Math.round((img.naturalHeight / img.naturalWidth) * w);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.8).split(",")[1];
}, [shot, WIDTH]);
const domLines = dom.slice(0, 20).map((el) =>
  `[${el.id}] <${el.tag}> text="${String(el.text || "").slice(0, 40)}" label="${el.label}"`).join("\n");
const sys = 'Return ONE JSON object: {"thought":"...","action":{...},"done":false}.';

const body = JSON.stringify({
  model: MODEL,
  messages: [
    { role: "system", content: sys },
    { role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/jpeg;base64," + jpeg } },
      { type: "text", text: "Task: log in and transfer money.\nDOM:\n" + domLines + "\nReturn JSON only." },
    ] },
  ],
  temperature: 0, max_tokens: 128, stream: true,
});

const t0 = performance.now();
let first = null, chars = 0;
const r = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
  method: "POST", headers: { "Content-Type": "application/json" }, body,
});
if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 300));
const rd = r.body.getReader();
const dec = new TextDecoder();
let buf = "";
for (;;) {
  const { done, value } = await rd.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const evts = buf.split("\n\n");
  buf = evts.pop();
  for (const e of evts) {
    if (!e.trim()) continue;
    const line = e.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const d = line.slice(5).trim();
    if (d === "[DONE]") continue;
    try {
      const j = JSON.parse(d);
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) {
        chars += delta.length;
        if (first === null) first = performance.now() - t0;
      }
    } catch { /* partial frame */ }
  }
}
console.log(JSON.stringify({
  model: MODEL, page: PAGE, width: WIDTH,
  prefill_ms: Math.round(first), total_ms: Math.round(performance.now() - t0),
  decode_ms: Math.round(performance.now() - t0 - first), chars,
}));
await b.close();