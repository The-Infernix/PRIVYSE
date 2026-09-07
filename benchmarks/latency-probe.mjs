// Latency probe: measure how screenshot resolution drives VLM latency + token
// count for the 7b model. Captures ONE real sanitized screenshot on the test
// site, resizes it to several widths in-page (canvas JPEG), then calls Ollama
// directly and records wall time + usage tokens.
//
// Usage: node latency-probe.mjs [model] [page] [--task fl*]
import { chromium } from "./node_modules/playwright-core/index.mjs";
import { readFileSync } from "node:fs";

const MODEL = process.argv[2] || "qwen2.5vl:7b";
const PAGE = process.argv[3] || "flight-booking.html";
const OLLAMA = "http://127.0.0.1:11434";
const WIDTHS = [1280, 960, 800, 672, 560, 480, 384];
const TASK = "Fill the passenger form and continue to payment";

const bundle = readFileSync("./dist/inpage.js", "utf8");

async function main() {
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:8000/test-site/${PAGE}`);
  await page.addScriptTag({ content: bundle });

  const shotPngB64 = (await page.screenshot({ type: "png" })).toString("base64");
  const payload = await page.evaluate(async (args) => {
    const [d, taskText] = args;
    const prose = [];
    window.__sih.sweepDocumentPii((r) => prose.push(r));
    const dom = window.__sih.serializeDOM();
    const pl = await window.__sih.sanitizeForUpload(d, dom, taskText, [], prose);
    return { dom: pl.dom };
  }, ["data:image/png;base64," + shotPngB64, TASK]);

  // Produce a JPEG variant at each width via canvas.
  const variants = await page.evaluate(async (args) => {
    const [srcB64, widths] = args;
    const img = new Image();
    img.src = "data:image/png;base64," + srcB64;
    await img.decode();
    const out = {};
    for (const w of widths) {
      const h = Math.round((img.naturalHeight / img.naturalWidth) * w);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      out[w] = c.toDataURL("image/jpeg", 0.8).split(",")[1];
    }
    return out;
  }, [shotPngB64, WIDTHS]);

  // DOM text block (fixed across variants).
  const domLines = payload.dom.slice(0, 20).map((el) =>
    `[${el.id}] <${el.tag}> text="${(el.text || "").slice(0, 40)}" label="${(el.label || "")}"`
  ).join("\n");

  const sys = "Return ONE JSON object: {\"thought\": \"...\", \"action\": {...}, \"done\": false}. target is a plain integer from the [N] list.";

  const results = [];
  for (const w of WIDTHS) {
    const jpegB64 = variants[w];
    const t0 = performance.now();
    let usage = null, content = "";
    try {
      const r = await fetch(`${OLLAMA}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: [
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpegB64}` } },
              { type: "text", text: `Task: ${TASK}\nDOM:\n${domLines}\nReturn JSON only.` },
            ] },
          ],
          temperature: 0,
          max_tokens: 128,
          stream: false,
        }),
      });
      const j = await r.json();
      usage = j.usage || null;
      content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    } catch (e) {
      console.error("call failed:", e.message);
    }
    const totalMs = performance.now() - t0;
    const kb = Math.round(jpegB64.length / 1024);
    results.push({ w, kb, totalMs: Math.round(totalMs), usage, content: content.slice(0, 60) });
    console.log(
      `${w}px  jpeg=${kb}KB  total=${Math.round(totalMs)}ms` +
      (usage ? `  prompt_tok=${usage.prompt_tokens} comp_tok=${usage.completion_tokens}` : "")
    );
  }
  await browser.close();
  console.log("\ncontent check (first variant):", results[0].content);
}

main().catch((e) => { console.error(e); process.exit(1); });