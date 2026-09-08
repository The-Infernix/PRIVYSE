// Privacy Lens — highlights sensitive regions directly on the live page with
// red rings + type tags, plus a banner offering "Show sanitized view" (which
// enters AI View). Lens only READS the DOM (never rewrites it), so the page
// itself is untouched; everything lives in a shadow-DOM overlay.
//
// All regions are drawn in viewport CSS px on a position:fixed overlay and
// repositioned on scroll/resize. The overlay is hidden during agent captures
// (content.ts hooks cursor-hide) so highlights never reach a screenshot.

import { detectPii, sensitiveFieldName } from "./pii-rules";
import { tokenizeText } from "./sanitizer";
import { isVisible } from "./dom-common";
import { aiView } from "./ai-view";

const HOST_ID = "sih-lens-host";
const TAG_PAD = 26;

interface LensRegion {
  els: Element[];
  types: string[];
}

function inputLabel(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  if (el.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lbl) return (lbl.textContent ?? "").trim();
  }
  const parentLabel = el.closest("label");
  if (parentLabel) {
    const clone = parentLabel.cloneNode(true) as HTMLLabelElement;
    clone.querySelectorAll("input, select, textarea, style, script").forEach((c) => c.remove());
    const t = clone.textContent?.trim();
    if (t) return t;
  }
  const ph = el.getAttribute("placeholder");
  if (ph) return ph;
  const ac = el.getAttribute("autocomplete");
  if (ac) return ac;
  const name = el.getAttribute("name");
  if (name) return name;
  return "";
}

class LensOverlay {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private regionsEl: HTMLElement | null = null;
  private bannerEl: HTMLElement | null = null;
  private bannerTextEl: HTMLElement | null = null;

  private shown = false;
  private visible = true;
  private initd = false;
  private regions: LensRegion[] = [];
  private rafPending = false;

  ensure() {
    if (this.initd) return;
    this.initd = true;
    this.inject();
  }

  active(): boolean {
    return this.shown;
  }

  count(): number {
    return this.regions.length;
  }

  /** User-invoked show — scans the page and draws highlights. */
  show() {
    this.ensure();
    this.shown = true;
    this.visible = true;
    this.rescan();
    this.applyVisibility();
    window.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onScroll);
  }

  /** User-invoked hide. */
  hide() {
    this.shown = false;
    this.applyVisibility();
    window.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onScroll);
  }

  /** Transient visibility (agent captures) — keeps the shown state. */
  setVisible(v: boolean) {
    this.visible = v;
    this.applyVisibility();
  }

  rescan() {
    this.scan();
    this.render();
  }

  // -- scanning ------------------------------------------------------------

  private scan() {
    const byEl = new Map<Element, Set<string>>();
    const add = (el: Element, type: string) => {
      let s = byEl.get(el);
      if (!s) {
        s = new Set();
        byEl.set(el, s);
      }
      s.add(type);
    };

    // 1) Prose / tables / labels: any visible text node carrying PII.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const n = node as Text;
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = n.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.tagName === "SCRIPT" || parent.tagName === "STYLE") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const { redactions } = tokenizeText(node.nodeValue ?? "");
      if (redactions.length === 0) continue;
      const parent = node.parentElement!;
      if (!parent.isConnected || !isVisible(parent)) continue;
      for (const r of redactions) add(parent, r.type);
    }

    // 2) Inputs / textareas / selects — by label signal and detected values.
    const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input, textarea, select",
    );
    for (const el of Array.from(fields)) {
      if (!isVisible(el)) continue;
      const label = inputLabel(el);
      const labelType =
        (el as HTMLInputElement).type === "password"
          ? "password"
          : (sensitiveFieldName(label) ?? sensitiveFieldName(el.name ?? ""))?.type;
      if (labelType) add(el, labelType);
      if ("value" in el && !(el as HTMLInputElement).type?.match(/pass|hidden/)) {
        const v = String(el.value ?? "");
        if (v && v.trim()) {
          for (const m of detectPii(v)) add(el, m.type);
        }
      }
    }

    // 3) <address> blocks (contact information by element semantics).
    const addrs = document.querySelectorAll<HTMLElement>("address");
    for (const el of Array.from(addrs)) {
      if (el.isConnected && isVisible(el)) add(el, "address");
    }

    // Collapse into regions with unique type labels; drop zero-size elements.
    this.regions = [];
    for (const [el, types] of byEl) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      this.regions.push({ els: [el], types: [...types] });
    }
  }

  // -- rendering -----------------------------------------------------------

  private onScroll = () => {
    if (this.rafPending || !this.shown) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.render();
    });
  };

  private render() {
    if (!this.regionsEl || !this.bannerTextEl) return;
    this.regionsEl.innerHTML = "";
    let hit = 0;
    for (const region of this.regions) {
      const box = this.unionRect(region.els);
      if (!box) continue;
      const d = document.createElement("div");
      d.className = "region";
      d.style.left = `${box.left}px`;
      d.style.top = `${box.top}px`;
      d.style.width = `${box.width}px`;
      d.style.height = `${box.height}px`;
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = region.types.join(" · ");
      d.appendChild(tag);
      this.regionsEl.appendChild(d);
      hit++;
    }
    this.bannerTextEl.innerHTML = `<b>${hit}</b> sensitive region${hit === 1 ? "" : "s"} on this page`;
    this.bannerEl?.classList.toggle("empty", hit === 0);
  }

  private unionRect(els: Element[]): DOMRect | null {
    let l = Infinity;
    let t = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    let any = false;
    for (const el of els) {
      if (!el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.left > window.innerWidth || rect.top > window.innerHeight) continue;
      l = Math.min(l, rect.left);
      t = Math.min(t, rect.top);
      r = Math.max(r, rect.right);
      b = Math.max(b, rect.bottom);
      any = true;
    }
    if (!any) return null;
    return new DOMRect(l, t, r - l, b - t);
  }

  private applyVisibility() {
    if (this.host) {
      const show = this.shown && this.visible;
      this.host.style.display = show ? "block" : "none";
      if (show) this.render();
    }
  }

  // -- shadow host ---------------------------------------------------------

  private inject() {
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483646;display:none;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; pointer-events: none; }
        .layer { position: absolute; inset: 0; }
        .region {
          position: absolute;
          border: 2px solid rgba(248,113,113,.85);
          border-radius: 6px;
          background: rgba(248,113,113,.07);
          box-shadow: 0 0 0 1px rgba(0,0,0,.12);
        }
        .region .tag {
          position: absolute; left: -2px; top: -${TAG_PAD - 4}px;
          padding: 3px 8px; border-radius: 5px;
          background: #431c22; color: #fecaca;
          border: 1px solid rgba(248,113,113,.55);
          font: 700 10px system-ui, "Segoe UI", sans-serif;
          white-space: nowrap; letter-spacing: .04em;
          max-width: 240px; overflow: hidden; text-overflow: ellipsis;
        }
        .banner {
          position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
          display: flex; align-items: center; gap: 10px;
          padding: 8px 12px; border-radius: 12px;
          background: rgba(13,22,41,.97);
          border: 1px solid rgba(248,113,113,.45);
          color: #e5edf8; font: 600 12px system-ui, "Segoe UI", sans-serif;
          box-shadow: 0 12px 34px rgba(0,0,0,.5);
          pointer-events: auto;
          max-width: min(92vw, 560px);
        }
        .banner .lens-label { display: flex; align-items: center; gap: 7px; }
        .banner .lens-label b { color: #fca5a5; font-size: 14px; }
        .banner .btn {
          padding: 5px 10px; border-radius: 7px;
          font: 700 11px system-ui, "Segoe UI", sans-serif;
          border: 1px solid #2e4170; color: #e5edf8;
          background: #111a2e; cursor: pointer; user-select: none;
          white-space: nowrap; transition: border-color .15s, color .15s, background .15s;
        }
        .banner .btn:hover { border-color: #38bdf8; color: #7fd4ff; }
        .banner .btn.primary { background: linear-gradient(135deg,#38bdf8,#34d399); color: #04121f; border: 0; }
        .banner .btn.primary:hover { filter: brightness(1.08); }
        .banner.empty { border-color: rgba(52,211,153,.4); }
        .banner.empty .lens-label b { color: #34d399; }
      </style>
      <div class="layer"></div>
      <div class="banner">
        <span class="lens-label"><b>PRIVYSE</b> <span id="bannerText"></span></span>
        <span class="btn primary" data-act="sanitized">Show sanitized view</span>
        <span class="btn" data-act="rescan">Re-scan</span>
        <span class="btn" data-act="hide">Hide</span>
      </div>
    `;
    document.documentElement.appendChild(host);

    this.host = host;
    this.root = root;
    this.regionsEl = root.querySelector(".layer") as HTMLElement;
    this.bannerEl = root.querySelector(".banner") as HTMLElement;
    this.bannerTextEl = root.querySelector("#bannerText") as HTMLElement;

    root.querySelector(".banner")?.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).dataset?.act;
      if (act === "sanitized") {
        this.hide();
        aiView.enter();
      } else if (act === "rescan") {
        this.rescan();
      } else if (act === "hide") {
        this.hide();
      }
    });
  }
}

export const lens = new LensOverlay();