// Floating PRIVYSE orb — a draggable status dot that lives on the page while
// the side panel is closed. When the agent loop runs it expands into a live
// status pill (stage + step counter + pipeline dots) driven by the SAME
// broadcast messages the side panel consumes (loop-status / agent-stage /
// privacy), so the background needs no new wiring.
//
// The orb is hidden on cursor-hide (background sends it before every capture)
// so it never appears in a VLM screenshot.

import type { AgentStage } from "./protocol";

const HOST_ID = "sih-orb-host";
const POS_KEY = "sihOrbPos";

const DOT = 50;
const DRAG_THRESHOLD = 5;
const PIPELINE: AgentStage[] = [
  "capturing",
  "sanitizing",
  "verifying",
  "reasoning",
  "acting",
];
const STAGE_LABEL: Record<string, string> = {
  ready: "READY",
  capturing: "CAPTURING",
  sanitizing: "SANITIZING",
  verifying: "VERIFYING",
  reasoning: "REASONING",
  acting: "ACTING",
  done: "DONE",
};

interface Pos {
  x: number;
  y: number;
}

function defaultPos(): Pos {
  return { x: window.innerWidth - DOT - 18, y: window.innerHeight - DOT - 30 };
}

function readPos(): Pos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Pos;
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    }
  } catch {
    /* ignore */
  }
  return defaultPos();
}

function clampPos(p: Pos): Pos {
  const maxX = window.innerWidth - DOT - 8;
  const maxY = window.innerHeight - DOT - 8;
  return {
    x: Math.max(8, Math.min(p.x, maxX)),
    y: Math.max(8, Math.min(p.y, maxY)),
  };
}

class AgentOrb {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private orbEl: HTMLElement | null = null;
  private dotEl: HTMLElement | null = null;
  private pillEl: HTMLElement | null = null;
  private pillStageEl: HTMLElement | null = null;
  private pillStepEl: HTMLElement | null = null;
  private pipeDots: HTMLElement[] = [];
  private flashEl: HTMLElement | null = null;

  private initd = false;
  private enabled = true;
  private visible = true;
  private pos: Pos = { x: 8, y: 8 };

  private running = false;
  private step = 0;
  private max = 0;
  private stage: AgentStage = "ready";

  private dragStartX = 0;
  private dragStartY = 0;
  private dragMoved = false;
  private dragActive = false;

  ensure() {
    if (this.initd) return;
    this.initd = true;
    this.pos = clampPos(readPos());
    this.inject();
  }

  setEnabled(b: boolean) {
    this.enabled = b;
    this.applyVisibility();
  }

  setVisible(b: boolean) {
    this.visible = b;
    this.applyVisibility();
  }

  setLoop(running: boolean, step: number, max: number) {
    this.running = running;
    if (Number.isFinite(step)) this.step = step;
    if (Number.isFinite(max)) this.max = max;
    this.renderPill();
  }

  setStage(stage: AgentStage) {
    this.stage = stage;
    this.renderPill();
  }

  setGate(gate: "pass" | "block" | "skip") {
    if (gate === "pass") this.flash("pass", "GATE PASS");
    else if (gate === "block") this.flash("block", "BLOCKED");
  }

  private inject() {
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; pointer-events: none; }
        .orb {
          position: fixed; left: ${this.pos.x}px; top: ${this.pos.y}px;
          width: ${DOT}px; height: ${DOT}px;
          pointer-events: auto; cursor: grab; user-select: none;
        }
        .orb.dragging { cursor: grabbing; }
        .dot {
          position: absolute; inset: 0;
          display: grid; place-items: center;
          border-radius: 50%;
          background: linear-gradient(135deg, #38bdf8, #34d399);
          box-shadow: 0 4px 18px rgba(56,189,248,.45), inset 0 0 0 2px rgba(255,255,255,.22);
          transition: filter .15s ease, transform .1s ease;
        }
        .dot:hover { filter: brightness(1.08); }
        .dot:active { transform: scale(.94); }
        .dot.pulse::after {
          content: ""; position: absolute; inset: -2px; border-radius: 50%;
          border: 2px solid rgba(56,189,248,.55);
          animation: orb-pulse 2.2s ease-out infinite;
        }
        .dot svg { display: block; }
        @keyframes orb-pulse {
          0%   { transform: scale(.96); opacity: .9; }
          70%  { transform: scale(1.55); opacity: 0; }
          100% { opacity: 0; }
        }
        .pill {
          position: absolute; right: calc(100% + 12px); top: 50%;
          transform: translateY(-50%);
          display: none; flex-direction: column; gap: 5px;
          padding: 8px 12px; border-radius: 10px;
          background: rgba(13,22,41,.97);
          border: 1px solid rgba(56,189,248,.38);
          color: #e5edf8; font: 600 11px "Segoe UI", system-ui, sans-serif;
          box-shadow: 0 10px 30px rgba(0,0,0,.5);
          white-space: nowrap;
        }
        .pill.pill-on { display: flex; animation: orb-pop .16s ease-out; }
        @keyframes orb-pop {
          from { opacity: 0; transform: translateY(-50%) translateX(6px) scale(.97); }
          to   { opacity: 1; transform: translateY(-50%) translateX(0) scale(1); }
        }
        .pill-row { display: flex; align-items: center; gap: 10px; }
        .pill-stage { font-size: 11px; font-weight: 800; color: #7fd4ff; letter-spacing: .06em; }
        .pill-step { font-size: 10px; color: #8b9bb8; font-family: ui-monospace, Consolas, monospace; }
        .pill-pipe { display: flex; align-items: center; gap: 5px; }
        .p-dot {
          width: 14px; height: 5px; border-radius: 3px;
          background: #22304d; transition: background .2s ease;
        }
        .p-dot.on { background: #38bdf8; animation: p-blink 1s ease-in-out infinite; }
        .p-dot.done { background: #34d399; }
        @keyframes p-blink { 50% { opacity: .45; } }
        .flash {
          position: absolute; bottom: calc(100% + 10px); right: 0;
          padding: 4px 10px; border-radius: 7px;
          font: 800 10px "Segoe UI", system-ui, sans-serif;
          letter-spacing: .08em; opacity: 0; transition: opacity .15s ease;
        }
        .flash.pass { color: #34d399; background: rgba(18,61,51,.96); border: 1px solid rgba(52,211,153,.5); }
        .flash.block { color: #fca5a5; background: rgba(67,28,34,.96); border: 1px solid rgba(248,113,113,.5); }
      </style>
      <div class="orb">
        <div class="dot pulse"></div>
        <div class="pill">
          <div class="pill-row">
            <span class="pill-stage">READY</span>
            <span class="pill-step"></span>
          </div>
          <div class="pill-pipe"></div>
        </div>
        <div class="flash"></div>
      </div>
    `;
    document.documentElement.appendChild(host);

    this.host = host;
    this.root = root;
    this.orbEl = root.querySelector(".orb") as HTMLElement;
    this.dotEl = root.querySelector(".dot") as HTMLElement;
    this.pillEl = root.querySelector(".pill") as HTMLElement;
    this.pillStageEl = root.querySelector(".pill-stage") as HTMLElement;
    this.pillStepEl = root.querySelector(".pill-step") as HTMLElement;
    this.flashEl = root.querySelector(".flash") as HTMLElement;

    const pipe = root.querySelector(".pill-pipe") as HTMLElement;
    for (let i = 0; i < PIPELINE.length; i++) {
      const d = document.createElement("div");
      d.className = "p-dot";
      pipe.appendChild(d);
      this.pipeDots.push(d);
    }

    this.dotEl.innerHTML = `
      <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#0b1220" d="M12 2.5 4 5v5.2c0 4.8 3.3 9 8 10.8 4.7-1.8 8-6 8-10.8V5z"/>
        <path fill="#34d399" d="M9.6 12.3l1.7 1.7 3.6-3.7 1.1 1.1-4.7 4.7-2.8-2.8z"/>
      </svg>`;

    this.wireDrag();
    this.renderPill();
    this.applyVisibility();
  }

  private onDragDown = (e: PointerEvent) => {
    if (!this.orbEl) return;
    this.dragActive = true;
    this.dragMoved = false;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.orbEl.classList.add("dragging");
    this.orbEl.setPointerCapture(e.pointerId);
  };

  private onDragMove = (e: PointerEvent) => {
    if (!this.dragActive || !this.orbEl) return;
    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;
    if (!this.dragMoved && Math.hypot(dx, dy) > DRAG_THRESHOLD) this.dragMoved = true;
    if (this.dragMoved) {
      this.pos = clampPos({ x: this.pos.x + dx, y: this.pos.y + dy });
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this.applyPosition();
    }
  };

  private onDragUp = (e: PointerEvent) => {
    if (!this.dragActive) return;
    this.dragActive = false;
    this.orbEl?.classList.remove("dragging");
    try {
      this.orbEl?.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    if (!this.dragMoved) {
      browser.runtime.sendMessage({ type: "open-panel" }).catch(() => {});
    } else {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(this.pos));
      } catch {
        /* ignore */
      }
    }
  };

  private wireDrag() {
    if (!this.orbEl) return;
    this.orbEl.addEventListener("pointerdown", this.onDragDown);
    this.orbEl.addEventListener("pointermove", this.onDragMove);
    this.orbEl.addEventListener("pointerup", this.onDragUp);
    this.orbEl.addEventListener("pointercancel", this.onDragUp);
  }

  private applyPosition() {
    if (this.orbEl) {
      this.orbEl.style.left = `${this.pos.x}px`;
      this.orbEl.style.top = `${this.pos.y}px`;
    }
  }

  private renderPill() {
    if (!this.initd) return;
    const show = this.running || this.stage !== "ready";
    this.pillEl?.classList.toggle("pill-on", show);
    this.dotEl?.classList.toggle("pulse", !show);
    if (!this.pillStageEl) return;
    this.pillStageEl.textContent = STAGE_LABEL[this.stage] ?? String(this.stage).toUpperCase();
    this.pillStepEl!.textContent = this.running ? `Step ${this.step}/${this.max}` : "";

    const idx = PIPELINE.indexOf(this.stage);
    this.pipeDots.forEach((d, i) => {
      d.classList.toggle("done", idx >= 0 && i < idx);
      d.classList.toggle("on", i === idx);
    });
  }

  private flash(kind: "pass" | "block", text: string) {
    if (!this.flashEl) return;
    this.flashEl.textContent = text;
    this.flashEl.className = `flash ${kind}`;
    this.flashEl.style.opacity = "1";
    window.setTimeout(() => {
      if (this.flashEl) this.flashEl.style.opacity = "0";
    }, 1800);
  }

  private applyVisibility() {
    if (this.host) {
      this.host.style.display = this.enabled && this.visible ? "block" : "none";
    }
  }
}

export const orb = new AgentOrb();