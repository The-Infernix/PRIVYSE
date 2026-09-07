import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const CHROME =
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

const BASE_URLS = ["http://127.0.0.1:8000/test-site", "file:///C:/SIH/26171/test-site"];
const PAGES = [
  "index.html",
  "flight-booking.html",
  "flight-payment.html",
  "bank-transfer.html",
  "bank-transfer-details.html",
  "bank-transfer-otp.html",
  "pii-in-the-wild.html",
];

// Tall viewport so every GT-labelled element is inside the captured frame
// (production captures the visible tab; the bench mimics a large monitor).
const VIEWPORT = { width: 1280, height: 2400 };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".tflite": "application/octet-stream",
  ".traineddata.gz": "application/gzip",
  ".gz": "application/gzip",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

// Embedded static server so the benchmark is self-contained: module imports,
// fetch() and Web Workers (Tesseract) all need an http origin — file:// pages
// cannot run the vision stack. Serves test-site/ + extension/public/models/.
function startStaticServer() {
  const ROOTS = [
    { prefix: "/models/", dir: normalize(join(ROOT, "..", "extension", "public", "models")) },
    { prefix: "/", dir: join(ROOT, "..", "test-site") },
  ];
  const srv = createServer((req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const root = ROOTS.find((r) => (r.prefix === "/" ? true : path.startsWith(r.prefix)));
      const rel = root.prefix === "/" ? path : path.slice(root.prefix.length);
      const file = normalize(join(root.dir, rel));
      if (!file.startsWith(normalize(root.dir)) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404).end("not found");
        return;
      }
      const ext = extname(file);
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(500).end("error");
    }
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

// Categories scored end-to-end. face/account are Phase 2 (on-device vision);
// everything else stays DOM-rules. Remaining cats are reported as backlog.
const SUPPORTED = new Set(["name", "email", "phone", "aadhaar", "pan", "card", "address", "password", "face", "account", "ifsc"]);
const REPORTED_OUT_OF_SCOPE = new Set(["ssn", "dob"]);

function area(b) {
  return b[2] * b[3];
}
function inter(a, b) {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}
function iou(a, b) {
  const i = inter(a, b);
  return i / (area(a) + area(b) - i || 1);
}

// Pixel precision/recall are computed on rasterized masks (union of boxes),
// NOT by summing per-box best overlaps: when two predictions cover the same GT
// box, per-box sums count that GT's pixels twice and recall exceeds 1.0.
// Mask math is set-based, so both metrics are bounded by 1 by construction.
// Boxes are in viewport CSS px (dpr=1 in this harness), clipped to the
// captured viewport — matching what the screenshot actually contains.
const GRID_W = VIEWPORT.width;
const GRID_H = VIEWPORT.height;

function fillMask(mask, boxes) {
  for (const b of boxes) {
    const x0 = Math.max(0, Math.round(b[0]));
    const y0 = Math.max(0, Math.round(b[1]));
    const x1 = Math.min(GRID_W, Math.round(b[0] + b[2]));
    const y1 = Math.min(GRID_H, Math.round(b[1] + b[3]));
    for (let y = y0; y < y1; y++) {
      const row = y * GRID_W;
      for (let x = x0; x < x1; x++) mask[row + x] = 1;
    }
  }
  return mask;
}

function rasterStats(predBoxes, gtBoxes) {
  const pred = fillMask(new Uint8Array(GRID_W * GRID_H), predBoxes);
  const gt = fillMask(new Uint8Array(GRID_W * GRID_H), gtBoxes);
  let predPx = 0, gtPx = 0, interPx = 0;
  for (let i = 0; i < pred.length; i++) {
    predPx += pred[i];
    gtPx += gt[i];
    interPx += pred[i] & gt[i];
  }
  return { predPx, gtPx, interPx };
}

const classify = (cat) => {
  const c = (cat || "").trim().toLowerCase();
  if (c === "none" || !c) return "benign";
  if (SUPPORTED.has(c)) return "supported";
  if (REPORTED_OUT_OF_SCOPE.has(c)) return "phase2";
  return "other";
};

async function probeBase(browser) {
  for (const base of BASE_URLS) {
    try {
      const page = await browser.newPage({ viewport: VIEWPORT });
      await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded", timeout: 8000 });
      await page.close();
      return base;
    } catch {
      /* try next */
    }
  }
  throw new Error("No reachable base URL for test-site (server or file).");
}

async function runPage(page, base, bundleJs) {
  const url = `${base}/${PAGES.find((p) => p !== "index.html" && p.startsWith("index")) ?? PAGES[0]}`;

  const results = [];
  for (const rel of PAGES) {
    if (rel === "index.html") continue;
    const target = `${base}/${rel}`;
    await page.goto(target, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => {});
    await page.addScriptTag({ content: bundleJs });

    const captureStart = Date.now();
    const shot = await page.screenshot({ type: "png" });
    const captureMs = Date.now() - captureStart;

    const gtx = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("[data-gt]")) {
        const r = el.getBoundingClientRect();
        const box = [r.left, r.top, r.width, r.height];
    for (const part of el.getAttribute("data-gt").split(",")) {
      const idx = part.indexOf(":");
      // valueless labels (data-gt="face") are legal — e.g. Tier C faces
      const cat = (idx < 0 ? part : part.slice(0, idx)).trim();
      const value = idx < 0 ? "" : part.slice(idx + 1).trim();
      if (!cat) continue;
      out.push({
        cat,
        value,
        phase2: el.hasAttribute("data-phase2"),
        box,
      });
    }
      }
      return out;
    });

    const inpage = await page.evaluate(async ({ dataUrl }) => {
      const { __sih } = window;
      const t = {};
      // Production order: serialize FIRST (element bboxes pre-sweep so later
      // prose rewrites don't shift boxes), then sweep prose + rewrite, then
      // vision (faces + OCR of image/canvas regions), then sanitize (tokenizes
      // dom values + masks the shot).
      let t0 = performance.now();
      const dom = __sih.serializeDOM();
      // Regions BEFORE the sweep — same layout the screenshot shows.
      const regions = __sih.collectImageRegions();
      const proseRedactions = [];
      __sih.sweepDocumentPii((r) => proseRedactions.push(r));
      t.serialize = performance.now() - t0;

      // Phase 2 on-device vision — faces + OCR PII in image regions.
      t0 = performance.now();
      const vision = await __sih.runVision({ imageDataUrl: dataUrl, imageRegions: regions });
      t.vision = performance.now() - t0;

      t0 = performance.now();
      const payload = await __sih.sanitizeForUpload(
        dataUrl,
        dom,
        "benchmark",
        [],
        proseRedactions,
        vision
          ? { faces: vision.faces, ocr: vision.ocr, stats: vision.stats }
          : undefined,
      );
      t.sanitize = performance.now() - t0;
      const leaks = __sih.scanForLeaks(payload);

      // Zero-leak layer 2: OCR the SANITIZED screenshot (what would actually
      // be uploaded). Blocks nothing here — the harness records the verdict.
      t0 = performance.now();
      const imageGate = await __sih.scanSanitizedImage(payload.screenshot_b64.startsWith("data:")
        ? payload.screenshot_b64
        : `data:image/jpeg;base64,${payload.screenshot_b64}`);
      t.imageGate = performance.now() - t0;

      t.total = t.serialize + t.sanitize;
      return {
        dom,
        payload,
        leaks,
        vision,
        imageGate,
        regions,
        timings: t,
      };
    }, { dataUrl: `data:image/png;base64,${shot.toString("base64")}` });

    const preds = inpage.payload.redactions.map((r) => ({ type: r.type, box: r.bbox, tier: r.tier, token: r.token }));
    const bodySize = JSON.stringify(inpage.payload).length;
    results.push({
      page: rel,
      captureMs,
      timings: inpage.timings,
      gt: gtx,
      preds,
      leaks: inpage.leaks,
      imageLeaks: inpage.imageGate?.hits ?? [],
      imageGateError: inpage.imageGate?.error,
      imageGateMs: inpage.imageGate?.ms ?? 0,
      visionStats: inpage.vision?.stats,
      ocrHits: inpage.vision?.ocr ?? [],
      faces: inpage.vision?.faces ?? [],
      regions: inpage.regions,
      payloadSnapshot: inpage.payload,
      domElements: inpage.dom.length,
      redactions: preds.length,
      bodySize,
    });
  }
  return results;
}

function scorePage(r) {
  const gtSupported = r.gt.filter((g) => classify(g.cat) === "supported");
  const phase2Gt = r.gt.filter((g) => classify(g.cat) === "phase2");
  const benignGt = r.gt.filter((g) => classify(g.cat) === "benign");
  const cats = [...new Set(gtSupported.map((g) => g.cat))];

  const perCat = {};
  for (const c of cats) {
    const gtc = gtSupported.filter((g) => g.cat === c);
    const prc = r.preds.filter((p) => p.type === c);
    // element-level recall: GT covered >=50% by a matching pred
    let recalled = 0;
    for (const g of gtc) {
      if (prc.some((p) => inter(p.box, g.box) / area(g.box) >= 0.5)) recalled++;
    }
    perCat[c] = {
      gtElements: gtc.length,
      recallElements: recalled,
    };
  }
  return { perCat, gtSupported: gtSupported.length, phase2Gt: phase2Gt.length, benignGt: benignGt.length };
}

function aggregate(scores) {
  const totals = {};
  const byCat = {};
  for (const s of scores) {
    for (const [c, v] of Object.entries(s.perCat)) {
      const t = (byCat[c] ??= { gtElements: 0, recallElements: 0, predPx: 0, coveredPx: 0, gtPx: 0, hitPx: 0 });
      t.gtElements += v.gtElements;
      t.recallElements += v.recallElements;
    }
  }
  return byCat;
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const staticSrv = await startStaticServer();
const staticPort = staticSrv.address().port;
BASE_URLS.unshift(`http://127.0.0.1:${staticPort}`);

try {
  const bundleJs = readFileSync(join(ROOT, "dist", "inpage.js"), "utf8");
  const base = await probeBase(browser);
  console.log(`Using base: ${base}\n`);
  const page = await browser.newPage({ viewport: VIEWPORT });
  const results = await runPage(page, base, bundleJs);
  await page.close();

  const allScores = results.map((r) => scorePage(r));
  const byCat = aggregate(allScores);
  const overall = {};
  for (const [c, t] of Object.entries(byCat)) {
    overall[c] = {
      gtElements: t.gtElements,
      recallElements: t.recallElements,
      recallElementPct: t.gtElements ? +((t.recallElements / t.gtElements) * 100).toFixed(1) : 0,
    };
  }

  // pixel metrics: rasterized per page (each page renders in its own viewport
  // frame), raw mask pixel counts summed across pages, ratios computed once
  const byCatPx = {};
  const overallPx = { predPx: 0, gtPx: 0, interPx: 0 };
  for (const r of results) {
    const gtSupported = r.gt.filter((g) => classify(g.cat) === "supported");
    const predSupported = r.preds.filter((p) => SUPPORTED.has(p.type));
    const cats = new Set([
      ...gtSupported.map((g) => g.cat),
      ...predSupported.map((p) => p.type),
    ]);
    for (const c of cats) {
      const st = rasterStats(
        predSupported.filter((p) => p.type === c).map((p) => p.box),
        gtSupported.filter((g) => g.cat === c).map((g) => g.box),
      );
      const t = (byCatPx[c] ??= { predPx: 0, gtPx: 0, interPx: 0 });
      t.predPx += st.predPx;
      t.gtPx += st.gtPx;
      t.interPx += st.interPx;
    }
    const ov = rasterStats(predSupported.map((p) => p.box), gtSupported.map((g) => g.box));
    overallPx.predPx += ov.predPx;
    overallPx.gtPx += ov.gtPx;
    overallPx.interPx += ov.interPx;
  }
  const px = {};
  for (const [c, b] of Object.entries(byCatPx)) {
    const prec = b.predPx ? b.interPx / b.predPx : 0;
    const rec = b.gtPx ? b.interPx / b.gtPx : 0;
    px[c] = { precisionPx: +prec.toFixed(3), recallPx: +rec.toFixed(3), f1Px: +(prec + rec ? (2 * prec * rec) / (prec + rec || 1) : 0).toFixed(3) };
  }
  const precO = overallPx.predPx ? overallPx.interPx / overallPx.predPx : 0;
  const recO = overallPx.gtPx ? overallPx.interPx / overallPx.gtPx : 0;
  px.__overall__ = {
    precisionPx: +precO.toFixed(3),
    recallPx: +recO.toFixed(3),
    f1Px: +(precO + recO ? (2 * precO * recO) / (precO + recO || 1) : 0).toFixed(3),
  };

  // zero-leak: scanner leaks + surviving GT values in the sanitized body + OCR
  // over the sanitized screenshot (Phase 2 layer 2)
  const leakHits = [];
  const phase2Exposures = [];
  for (const r of results) {
    for (const l of r.leaks) leakHits.push({ page: r.page, type: l.type, value: l.value, where: "dom-scan" });
    for (const h of r.imageLeaks) {
      leakHits.push({ page: r.page, type: h.type, value: h.value, where: "image-ocr" });
    }
    if (r.imageGateError) {
      leakHits.push({ page: r.page, type: "gate-error", value: r.imageGateError, where: "image-ocr-error" });
    }
    // Only scan dom text/value fields, NOT the screenshot_b64 (base64 is binary
    // noise and causes false positives).
    const domText = (r.payloadSnapshot.dom || [])
      .flatMap((el) => [el.text, el.value])
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .replace(/\s+/g, "");
    const taskText = (r.payloadSnapshot.task || "").toLowerCase().replace(/\s+/g, "");
    const haystack = domText + taskText;
    for (const g of r.gt.filter((x) => classify(x.cat) === "supported")) {
      const val = (g.value || "").trim();
      if (!val) continue;
      const needle = val.replace(/\s+/g, "").toLowerCase();
      if (needle && haystack.includes(needle)) {
        leakHits.push({ page: r.page, type: g.cat, value: g.value, where: "gt-value-in-body" });
      }
    }

    // Phase-2 surfaces still carry raw PII today; report separately.
    for (const g of r.gt.filter((x) => classify(x.cat) === "phase2")) {
      const val = (g.value || "").trim();
      if (!val) continue;
      const needle = val.replace(/\s+/g, "").toLowerCase();
      if (needle && haystack.includes(needle)) {
        phase2Exposures.push({ page: r.page, type: g.cat, value: g.value });
      }
    }
  }

  const latencies = results.reduce(
    (a, r) => {
      a.capture += r.captureMs;
      a.serialize += r.timings.serialize;
      a.vision += r.timings.vision || 0;
      a.sanitize += r.timings.sanitize;
      a.imageGate += r.timings.imageGate || 0;
      a.total += r.captureMs + r.timings.serialize + (r.timings.vision || 0) + r.timings.sanitize;
      return a;
    },
    { capture: 0, serialize: 0, vision: 0, sanitize: 0, imageGate: 0, total: 0 },
  );
  const n = results.length;
  for (const k of Object.keys(latencies)) latencies[k] = +(latencies[k] / n).toFixed(1);

  const visionAgg = results.reduce(
    (a, r) => {
      const s = r.visionStats || {};
      a.faceMs += s.faceMs || 0;
      a.ocrMs += s.ocrMs || 0;
      a.facesFound += s.facesFound || 0;
      a.ocrRegions += s.ocrRegions || 0;
      a.ocrHits += s.ocrHits || 0;
      a.modelsMB = s.modelsMB || a.modelsMB;
      if (s.skipped) a.skipped.push(...s.skipped);
      return a;
    },
    { faceMs: 0, ocrMs: 0, facesFound: 0, ocrRegions: 0, ocrHits: 0, modelsMB: 0, skipped: [] },
  );
  for (const k of ["faceMs", "ocrMs"]) visionAgg[k] = +(visionAgg[k] / n).toFixed(1);

  const report = {
    generated_at: new Date().toISOString(),
    pages: results.map((r) => ({
      page: r.page,
      domElements: r.domElements,
      redactions: r.redactions,
      preds: r.preds,
      gt: r.gt,
      bodySizeBytes: r.bodySize,
      faces: r.faces,
      ocrHits: r.ocrHits,
      regions: r.regions,
      timingsMs: { ...r.timings, capture: r.captureMs },
    })),
    categories: Object.fromEntries(
      Object.entries(overall).map(([c, v]) => [c, { ...v, ...px[c] }]),
    ),
    overview: px.__overall__,
    zeroLeak: { pass: leakHits.length === 0, hits: leakHits },
    phase2_exposures: phase2Exposures,
    phase2_backlog: {
      outOfScopeGt: results.reduce((a, r) => a + r.gt.filter((g) => REPORTED_OUT_OF_SCOPE.has(g.cat)).length, 0),
      phase2TaggedGt: results.reduce((a, r) => a + r.gt.filter((g) => g.phase2).length, 0),
    },
    vision: {
      ...visionAgg,
      skipped: [...new Set(visionAgg.skipped)],
    },
    latencyWaterfallMsAvg: latencies,
  };

  mkdirSync(join(ROOT, "results"), { recursive: true });
  writeFileSync(join(ROOT, "results", "latest.json"), JSON.stringify(report, null, 2));

  console.log("METRICS");
  console.table(Object.entries(overall).map(([c, v]) => ({ category: c, ...v, ...px[c] })));
  console.log(`overview: precisionPx=${px.__overall__.precisionPx} recallPx=${px.__overall__.recallPx} f1Px=${px.__overall__.f1Px}`);
  console.log(`zero-leak pass=${report.zeroLeak.pass} hits=${leakHits.length} phase2-exposures=${phase2Exposures.length}`);
  console.log(`latency avg (ms): capture=${latencies.capture} serialize=${latencies.serialize} vision=${latencies.vision} sanitize=${latencies.sanitize} imageGate=${latencies.imageGate}`);
  console.log(`vision: modelsMB=${visionAgg.modelsMB} faces=${visionAgg.facesFound} ocrRegions=${visionAgg.ocrRegions} ocrHits=${visionAgg.ocrHits} faceMs=${visionAgg.faceMs} ocrMs=${visionAgg.ocrMs} skipped=${report.vision.skipped.join(",") || "none"}`);
} finally {
  await browser.close();
  staticSrv.close();
}