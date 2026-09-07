import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const bundleJs = readFileSync("dist/inpage.js", "utf8");

async function fresh(p) {
  await p.goto("https://google.com", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await p.waitForTimeout(1200);
  await p.addScriptTag({ content: bundleJs });
  await p.waitForTimeout(300);
}

const out = {};
{
  const p = await b.newPage();
  await fresh(p);
  await p.evaluate(async () => {
    const dom = window.__sih.serializeDOM();
    const ta = dom.find((e) => e.tag === "textarea");
    await window.__sih.executeAction({ type: "type", target: ta.id, text: "student login" });
    await window.__sih.executeAction({ type: "press", key: "enter" });
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  out.synthEnterUrl = p.url();
  await p.close();
  await new Promise((r) => setTimeout(r, 500));
}
{
  const p = await b.newPage();
  await fresh(p);
  await p.evaluate(async () => {
    const dom = window.__sih.serializeDOM();
    const ta = dom.find((e) => e.tag === "textarea");
    await window.__sih.executeAction({ type: "type", target: ta.id, text: "student login" });
    const el = document.querySelector("textarea");
    el.focus();
    const form = el.closest("form");
    if (!form) return;
    form.requestSubmit();
  }).catch((e) => (out.requestSubmitErr = String(e).slice(0, 80)));
  await p.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  out.requestSubmitUrl = p.url();
  await p.close();
}
console.log(JSON.stringify(out, null, 1));
await b.close();