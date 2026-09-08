// AI View mode — flips the live page into "what the agent sees":
//   • PII prose + unfocused input values are rewritten to stable tokens
//     ([EMAIL_1], [PHONE_1], …) using the same tokenizeText as the sanitizer.
//   • Set-of-Marks chips are drawn on interactive elements, numbered by the
//     SAME forEachElement pass the serializer uses — so chip N is the element
//     the VLM references as #N.
// All DOM changes are tracked so Exit restores the page exactly (tokens are
// a preview: nothing leaves the device either way).

import { tokenizeText } from "./sanitizer";
import { forEachElement, MAX_ELEMENTS } from "./dom-common";

const HOST_ID = "sih-ai-view-host";

interface TextChange {
  node: Text;
  original: string;
}

interface ValueChange {
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  original: string;
  token: string;
}

interface Chip {
  el: Element;
  node: HTMLElement;
}

function chipColor(tag: string): string {
  switch (tag) {
    case "a":
      return "#3b82f6";
    case "button":
    case "details":
    case "summary":
      return "#22c55e";
    case "input":
    case "textarea":
    case "select":
      return "#06b6d4";
    case "img":
      return "#ec4899";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "#8b5cf6";
    default:
      return "#64748b";
  }
}

class AiView {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private somLayer: HTMLElement | null = null;

  private active = false;
  private visible = true;
  private initd = false;
  private textChanges: TextChange[] = [];
  private valueChanges: ValueChange[] = [];
  private chips: Chip[] = [];
  private rafPending = false;

  ensure() {
    if (this.initd) return;
    this.initd = true;
    this.inject();
  }

  isActive(): boolean {
    return this.active;
  }

  enter() {
    this.ensure();
    if (this.active) return;
    this.active = true;
    this.visible = true;

    // 1) Tokenize prose / tables / labels (mirror sweepDocumentPii's walk).
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
      const original = node.nodeValue ?? "";
      const { text: clean, redactions } = tokenizeText(original);
      if (redactions.length === 0 || clean === original) continue;
      this.textChanges.push({ node, original });
      node.nodeValue = clean;
    }

    // 2) Mask PII inside unfocused input values (leave password/typing alone).
    const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input, textarea, select",
    );
    for (const el of Array.from(fields)) {
      if (!("value" in el) || el === document.activeElement) continue;
      const t = (el as HTMLInputElement).type?.toLowerCase();
      if (t === "password" || t === "hidden") continue;
      const original = String(el.value ?? "");
      if (!original || !original.trim()) continue;
      const { text: clean, redactions } = tokenizeText(original);
      if (redactions.length === 0 || clean === original) continue;
      this.valueChanges.push({ el, original, token: clean });
      el.value = clean;
    }

    // 3) SoM chips, numbered identically to the serializer's element ids.
    this.buildChips();
    this.applyVisibility();
    window.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onScroll);
  }

  exit() {
    if (!this.active) return;

    for (const c of this.textChanges) {
      if (c.node.isConnected) {
        try {
          c.node.nodeValue = c.original;
        } catch {
          /* read-only node */
        }
      }
    }
    for (const c of this.valueChanges) {
      if (!c.el.isConnected) continue;
      // If the user/agent typed something new over our token, keep it.
      if (c.el.value === c.token) c.el.value = c.original;
    }

    this.textChanges = [];
    this.valueChanges = [];
    this.clearChips();
    this.active = false;
    this.applyVisibility();
    window.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onScroll);
  }

  /** Transient hide of the AI-view chrome during captures — the tokenized
   * DOM text STAYS (it is exactly what the VLM should see). */
  setVisible(v: boolean) {
    this.visible = v;
    this.applyVisibility();
  }

  // -- SoM chips -----------------------------------------------------------

  private buildChips() {
    this.somLayer?.querySelectorAll("[data-chip]").forEach((n) => n.remove());
    this.chips = [];
    if (!this.somLayer) return;
    let id = 0;
    forEachElement((el) => {
      if (id >= MAX_ELEMENTS) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const chip = document.createElement("span");
      chip.dataset.chip = "1";
      chip.textContent = String(id);
      chip.style.background = chipColor(el.tagName.toLowerCase());
      chip.style.left = `${Math.max(4, rect.left - 12)}px`;
      chip.style.top = `${Math.max(4, rect.top - 12)}px`;
      this.somLayer!.appendChild(chip);
      this.chips.push({ el, node: chip });
      id++;
    });
  }

  private positionChips() {
    for (const c of this.chips) {
      if (!c.el.isConnected) continue;
      const r = c.el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        c.node.style.display = "none";
        continue;
      }
      c.node.style.display = "grid";
      c.node.style.left = `${Math.max(4, r.left - 12)}px`;
      c.node.style.top = `${Math.max(4, r.top - 12)}px`;
    }
  }

  private clearChips() {
    this.chips = [];
    this.somLayer?.querySelectorAll("[data-chip]").forEach((n) => n.remove());
  }

  private onScroll = () => {
    if (this.rafPending || !this.active) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      if (this.active) this.positionChips();
    });
  };

  // -- shadow host ---------------------------------------------------------

  private inject() {
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483645;display:none;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; pointer-events: none; }
        .som { position: absolute; inset: 0; }
        .som [data-chip] {
          position: absolute;
          width: 20px; height: 20px; border-radius: 50%;
          display: grid; place-items: center;
          color: #fff; font: 800 10px ui-monospace, Consolas, monospace;
          box-shadow: 0 1px 5px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.25);
          pointer-events: none;
        }
        .topbar {
          position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
          display: flex; align-items: center; gap: 10px;
          padding: 6px 8px 6px 14px; border-radius: 999px;
          background: rgba(13,22,41,.97);
          border: 1px solid rgba(167,139,250,.55);
          color: #e5edf8;
          font: 600 11px system-ui, "Segoe UI", sans-serif;
          box-shadow: 0 10px 30px rgba(0,0,0,.5);
          pointer-events: auto;
          max-width: min(94vw, 640px);
        }
        .topbar .brand { color: #c4b5fd; font-weight: 800; letter-spacing: .06em; }
        .topbar .desc { color: #8b9bb8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .topbar .btn {
          padding: 4px 12px; border-radius: 999px;
          font: 700 10px system-ui, "Segoe UI", sans-serif;
          letter-spacing: .05em;
          background: #2e1065; color: #ddd6fe;
          border: 1px solid rgba(167,139,250,.55); cursor: pointer; user-select: none;
          transition: filter .15s ease, border-color .15s ease;
        }
        .topbar .btn:hover { filter: brightness(1.15); border-color: #a78bfa; }
      </style>
      <div class="som"></div>
      <div class="topbar">
        <span class="brand">PRIVYSE AI VIEW</span>
        <span class="desc">this is how the agent sees this page · PII → tokens</span>
        <span class="btn" data-act="exit">Exit</span>
      </div>
    `;
    document.documentElement.appendChild(host);

    this.host = host;
    this.root = root;
    this.somLayer = root.querySelector(".som") as HTMLElement;

    root.querySelector(".topbar")?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).dataset?.act === "exit") this.exit();
    });
  }

  private applyVisibility() {
    if (this.host) {
      const show = this.active && this.visible;
      this.host.style.display = show ? "block" : "none";
      if (show) this.positionChips();
    }
  }
}

export const aiView = new AiView();