// Offline executor guard tests — no VLM, no server. Drives the REAL executor
// + action-guards inside a real Chromium against a hostile form/DOM, and
// asserts each guard fires deterministically.
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
const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };

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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
const bundle = readFileSync(join(ROOT, "dist", "inpage.js"), "utf8");
await page.addScriptTag({ content: bundle });

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
};

// ── pure navigation guard ──────────────────────────────────────────────────
const navCases = await page.evaluate(() => {
  const g = window.__sih.guards;
  const u = g.validateNavigationUrl;
  return {
    js: u("javascript:alert(1)"),
    data: u("data:text/html,<script>steal()</script>"),
    file: u("file:///C:/etc/passwd"),
    blob: u("blob:https://e.com/abc"),
    about: u("about:blank"),
    http: u("http://example.com/x"),
    https: u("https://bank.example/transfer"),
    rel: u("/flow"),
    malformed: u("http://[::1"),
  };
});
check("navigate blocks javascript:", !navCases.js.ok && navCases.js.reason.includes("javascript"), navCases.js.reason);
check("navigate blocks data:", !navCases.data.ok, navCases.data.reason);
check("navigate blocks file:", !navCases.file.ok, navCases.file.reason);
check("navigate blocks blob:", !navCases.blob.ok, navCases.blob.reason);
check("navigate blocks about:", !navCases.about.ok, navCases.about.reason);
check("navigate allows http:", navCases.http.ok);
check("navigate allows https:", navCases.https.ok);
check("navigate allows relative:", navCases.rel.ok);
check("navigate rejects malformed:", !navCases.malformed.ok, navCases.malformed.reason);

// ── DO-NOT-MODIFY structural write veto ───────────────────────────────────
// A forged /act response that rewrites a field whose current value the
// sanitizer would redact (card / PAN / email) must be refused by the executor:
// only an EXACT re-assert is allowed; replacement/erasure is a corruption
// primitive (an attacker-controlled model overwriting the user's golden
// corner). Plain (non-PII) values stay fully editable.
const rewriteCases = await page.evaluate(async () => {
  const mk = (name, type, value) => { const i = document.createElement("input"); i.type = type; i.name = name; i.value = value; document.body.appendChild(i); return i; };
  const card = mk("card", "text", "4111 1111 1111 1111");
  const pan = mk("pan", "text", "ABCDE1234F");
  const email = mk("email", "email", "alice@example.com");
  const name = mk("name", "text", "Aarav Sharma");
  const empty = mk("newphone", "tel", "");
  const idx = (el) => window.__sih.indexOfElement(el);
  const apply = async (el, text) => {
    try { await window.__sih.executeAction({ type: "type", target: idx(el), text }); return null; }
    catch (e) { return String(e?.message ?? e); }
  };
  return {
    cardReplace: await apply(card, "9999 9999 9999 9999"),
    cardSame: await apply(card, "4111 1111 1111 1111"),
    cardErase: await apply(card, ""),
    panReplace: await apply(pan, "ZZZPM1234Q"),
    emailReplace: await apply(email, "attacker@evil.example"),
    nameReplace: await apply(name, "Riya Verma"),
    emptyFill: await apply(empty, "9876500000"),
    values: { card: card.value, pan: pan.value, email: email.value, name: name.value, empty: empty.value },
  };
});
check("write veto: replace card blocked", typeof rewriteCases.cardReplace === "string" && rewriteCases.cardReplace.includes("type blocked"), rewriteCases.cardReplace);
check("write veto: exact card re-assert allowed", rewriteCases.cardSame === null && rewriteCases.values.card.includes("4111"), String(rewriteCases.cardSame));
check("write veto: erasing protected card blocked", typeof rewriteCases.cardErase === "string" && rewriteCases.cardErase.includes("type blocked"), rewriteCases.cardErase);
check("write veto: replace PAN blocked", String(rewriteCases.panReplace ?? "").includes("type blocked"), rewriteCases.panReplace);
check("write veto: replace email blocked", String(rewriteCases.emailReplace ?? "").includes("type blocked"), rewriteCases.emailReplace);
check("write veto: plain name stays editable", rewriteCases.nameReplace === null && rewriteCases.values.name === "Riya Verma", String(rewriteCases.nameReplace));
check("write veto: empty field fill allowed", rewriteCases.emptyFill === null && rewriteCases.values.empty === "9876500000", String(rewriteCases.emptyFill));

// ── executeAction legacy path (pre-guard) refuses navigate javascript: ─────
const navErr = await page.evaluate(async () => {
  try {
    await window.__sih.executeAction({ type: "navigate", url: "javascript:document.cookie" });
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
});
check("executeAction navigate javascript: throws", typeof navErr === "string" && navErr.includes("navigate refused"), navErr);

// ── click on file input refused ────────────────────────────────────────────
const fileClickErr = await page.evaluate(async () => {
  const fi = document.createElement("input");
  fi.type = "file";
  fi.name = "upload";
  document.body.appendChild(fi);
  const idx = window.__sih.indexOfElement(fi);
  try {
    await window.__sih.executeAction({ type: "click", target: idx });
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
});
check("click refuses <input type=file>", typeof fileClickErr === "string" && fileClickErr.includes("click refused"), fileClickErr);

// ── form action guards ─────────────────────────────────────────────────────
const formCases = await page.evaluate(() => {
  const g = window.__sih.guards;
  const origin = location.origin;
  const mk = (action) => { const f = document.createElement("form"); if (action !== null) f.setAttribute("action", action); const i = document.createElement("input"); i.value = "hunter2"; f.appendChild(i); document.body.appendChild(f); return f; };
  // An ALLOWED submit would really navigate; send it to a hidden iframe so the
  // top document (and this test's execution context) survives the assertion.
  const sink = document.createElement("iframe"); sink.name = "sih-sink"; document.body.appendChild(sink);
  const data = mk("data:text/html,leaky");
  const js = mk("javascript:void(0)");
  const mail = mk("mailto:attacker@evil.example");
  const httpX = mk("https://evil.example/pwn");
  httpX.target = "sih-sink";
  const local = mk("/next");
  const none = mk(null);
  return {
    data: g.validateFormAction(data.getAttribute("action"), origin),
    js: g.validateFormAction(js.getAttribute("action"), origin),
    mail: g.validateFormAction(mail.getAttribute("action"), origin),
    httpX: g.validateFormAction(httpX.getAttribute("action"), origin),
    local: g.validateFormAction(local.getAttribute("action"), origin),
    none: g.validateFormAction(none.getAttribute("action"), origin),
    tryData: g.trySubmitForm(data),
    tryHttp: g.trySubmitForm(httpX),
    notice: g.getLastGuardNotice(),
  };
});
check("form action blocks data:", !formCases.data.ok, formCases.data.reason);
check("form action blocks javascript:", !formCases.js.ok, formCases.js.reason);
check("form action blocks mailto:", !formCases.mail.ok, formCases.mail.reason);
check("form action allows http cross-origin:", formCases.httpX.ok);
check("form action allows relative:", formCases.local.ok);
check("form action allows empty:", formCases.none.ok);
check("trySubmitForm refuses data: without submitting", formCases.tryData === false && formCases.notice?.includes("submit blocked"), formCases.notice);
check("trySubmitForm allows http:", formCases.tryHttp === true);

// ── executeAction Enter in a data:-form does NOT leak (no submission) ──────
const enterLeak = await page.evaluate(async () => {
  const f = document.createElement("form");
  f.setAttribute("action", "data:text/html,X");
  const i = document.createElement("input");
  i.value = "secret-pass";
  f.appendChild(i);
  document.body.appendChild(f);
  i.focus();
  const fired = [];
  f.addEventListener("submit", () => fired.push(1));
  await window.__sih.executeAction({ type: "press", key: "enter" });
  await new Promise((r) => setTimeout(r, 150));
  return { fired: fired.length, notice: window.__sih.guards.getLastGuardNotice() };
});
check("Enter in data:-form never submits + notice set", enterLeak.fired === 0 && enterLeak.notice.includes("submit blocked"), JSON.stringify(enterLeak));

console.log(`\nresults: ${pass} pass, ${fail} fail`);
await browser.close();
srv.close();
process.exit(fail ? 1 : 0);