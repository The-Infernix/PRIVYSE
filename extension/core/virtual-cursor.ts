type Phase = "follow" | "flying" | "returning" | "dwelling";

interface Pt {
  x: number;
  y: number;
}

interface Flight {
  p0: Pt;
  p1: Pt;
  p2: Pt;
  start: number;
  dur: number;
  returning: boolean;
}

const OFFSET_X = 35;
const OFFSET_Y = 25;
const SPRING_STIFFNESS = 0.28;
const SPRING_DAMPING = 0.62;
const DWELL_MS = 220;
const TYPO_MS = 34;

const CURSOR_PATH =
  "M2 0 L2 16 L6.5 12 L9 18.5 L12.5 16.5 L10 10 L14 10 Z";

class VirtualCursor {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private arrow: HTMLDivElement | null = null;
  private ring: HTMLDivElement | null = null;
  private ripple: HTMLDivElement | null = null;
  private bubble: HTMLDivElement | null = null;
  private bubbleText: HTMLSpanElement | null = null;
  private caret: HTMLSpanElement | null = null;
  private tagEl: HTMLDivElement | null = null;
  private outlineEl: HTMLDivElement | null = null;
  private outlineTimer: ReturnType<typeof setTimeout> | undefined;
  private tagTimer: ReturnType<typeof setTimeout> | undefined;

  private enabled = true;
  private visible = true;
  private initd = false;

  private phase: Phase = "follow";
  private pos: Pt = { x: -200, y: -200 };
  private vel: Pt = { x: 0, y: 0 };
  private mouse: Pt = { x: -200, y: -200 };
  private hasMouse = false;

  private flight: Flight | null = null;
  private dwellUntil = 0;
  private settle: (() => void) | null = null;

  private ringTarget: Pt = { x: -200, y: -200 };
  private ringPhase = 0;
  private ringAlpha = 0;

  private pointerDownUntil = 0;
  private wiggleUntil = 0;
  private rippleStart = 0;
  private rippleActive = false;

  private bubbleTimer: ReturnType<typeof setTimeout> | undefined;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  private bubbleWidth = 0;

  private raf = 0;
  private lastT = 0;

  private onMove = (e: PointerEvent) => {
    this.mouse = { x: e.clientX, y: e.clientY };
    this.hasMouse = true;
  };

  ensure() {
    if (this.initd) return;
    this.initd = true;
    this.inject();
    window.addEventListener("pointermove", this.onMove);
    this.lastT = performance.now();
    const loop = (t: number) => {
      this.tick(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  setEnabled(b: boolean) {
    this.enabled = b;
    this.applyVisibility();
  }

  setVisible(b: boolean) {
    this.visible = b;
    this.applyVisibility();
  }

  /** Current cursor screen position, or null if it has never been shown. */
  getPosition(): Pt | null {
    if (!this.initd) return null;
    return { ...this.pos };
  }

  async flyTo(el: Element, label?: string): Promise<void> {
    this.ensure();
    if (!this.enabled) return;
    if (label) this.setTag(`🧠 ${label}`);
    const r = el.getBoundingClientRect();
    this.outline(r);
    const pt = await this.waitStable(el);
    this.ringTarget = pt;
    this.ringAlpha = 0;
    this.startFlight(pt, false);
    return new Promise<void>((resolve) => {
      this.settle = resolve;
    });
  }

  /** Show "OBSERVE" phase chip before the cursor flies to a target. */
  observe(label = "observe") {
    if (!this.enabled) return;
    this.setTag(`👁 ${label}`, 900);
  }

  /** Draw a dashed focus outline around an element rect (viewport coords). */
  private outline(r: DOMRect) {
    if (!this.outlineEl) return;
    this.outlineEl.style.left = `${r.left}px`;
    this.outlineEl.style.top = `${r.top}px`;
    this.outlineEl.style.width = `${r.width}px`;
    this.outlineEl.style.height = `${r.height}px`;
    this.outlineEl.style.opacity = "1";
    if (this.outlineTimer) clearTimeout(this.outlineTimer);
    this.outlineTimer = setTimeout(() => {
      if (this.outlineEl) this.outlineEl.style.opacity = "0";
    }, 1400);
  }

  /** Small phase chip near the cursor (e.g. "SOM 07", "↖ CLICK"). */
  setTag(text: string, ms = 1200) {
    if (!this.tagEl) this.ensure();
    if (!this.tagEl) return;
    if (!this.enabled) return;
    this.tagEl.textContent = text;
    this.tagEl.style.opacity = "1";
    if (this.tagTimer) clearTimeout(this.tagTimer);
    this.tagTimer = setTimeout(() => {
      if (this.tagEl) this.tagEl.style.opacity = "0";
    }, ms);
  }

  click() {
    if (!this.enabled) return;
    this.pointerDownUntil = performance.now() + 110;
    this.rippleActive = true;
    this.rippleStart = performance.now();
    this.setTag("↖ CLICK", 700);
    setTimeout(() => {
      this.rippleActive = false;
    }, 420);
  }

  typeText(text: string) {
    this.ensure();
    if (!this.enabled) return;
    if (this.typingTimer) clearTimeout(this.typingTimer);
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
    this.setBubble("", true);
    let i = 0;
    const step = () => {
      i++;
      this.setBubble(text.slice(0, i), true);
      if (i < text.length) {
        this.typingTimer = setTimeout(step, TYPO_MS);
      } else {
        this.typingTimer = setTimeout(() => this.clearBubble(), 1000);
      }
    };
    this.typingTimer = setTimeout(step, 30);
  }

  pressKey(key: string) {
    this.ensure();
    if (!this.enabled) return;
    this.setBubble(`Key: ${key}`, false);
    this.wiggleUntil = performance.now() + 260;
    this.bubbleTimer = setTimeout(() => this.clearBubble(), 1000);
  }

  scroll(dir: "up" | "down") {
    this.ensure();
    if (!this.enabled) return;
    this.setBubble(dir === "down" ? "Scrolling down" : "Scrolling up", false);
    this.bubbleTimer = setTimeout(() => this.clearBubble(), 900);
  }

  notify(text: string) {
    this.ensure();
    if (!this.enabled) return;
    this.setBubble(text, false);
    this.bubbleTimer = setTimeout(() => this.clearBubble(), 1100);
  }

  returnToMouse() {
    if (!this.enabled || !this.hasMouse) {
      this.phase = "follow";
      return;
    }
    this.startFlight(
      { x: this.mouse.x + OFFSET_X, y: this.mouse.y + OFFSET_Y },
      true,
    );
  }

  private startFlight(target: Pt, returning: boolean) {
    const p0 = { ...this.pos };
    const p2 = { ...target };
    const mid = { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 };
    const dist = Math.hypot(p2.x - p0.x, p2.y - p0.y);
    const lift = Math.min(dist * 0.22, 90);
    const dur = Math.min(Math.max(280 + dist * 0.5, 650), 1300);
    this.phase = returning ? "returning" : "flying";
    this.flight = {
      p0,
      p1: { x: mid.x, y: mid.y - lift },
      p2,
      start: performance.now(),
      dur,
      returning,
    };
  }

  private async waitStable(el: Element): Promise<Pt> {
    const timeout = 900;
    const start = performance.now();
    let last: Pt | null = null;
    while (performance.now() - start < timeout) {
      const r = el.getBoundingClientRect();
      const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      if (
        last &&
        Math.abs(c.x - last.x) < 0.5 &&
        Math.abs(c.y - last.y) < 0.5
      ) {
        return c;
      }
      last = c;
      await new Promise((res) => setTimeout(res, 40));
    }
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  private spring(dt: number) {
    const target = { x: this.mouse.x + OFFSET_X, y: this.mouse.y + OFFSET_Y };
    const k = SPRING_STIFFNESS * dt;
    const damp = Math.pow(SPRING_DAMPING, dt);
    this.vel.x = this.vel.x * damp + (target.x - this.pos.x) * k;
    this.vel.y = this.vel.y * damp + (target.y - this.pos.y) * k;
    this.pos.x += this.vel.x;
    this.pos.y += this.vel.y;
  }

  private tick(t: number) {
    const dt = Math.min(Math.max((t - this.lastT) / 16.667, 0.2), 2.5);
    this.lastT = t;

    if (this.phase === "follow" && this.hasMouse) this.spring(dt);

    if (this.flight) {
      const f = this.flight;
      const p = Math.min((t - f.start) / f.dur, 1);
      const e = p * p * (3 - 2 * p);
      const q = 2 * (1 - e) * e;
      this.pos.x =
        (1 - e) * (1 - e) * f.p0.x + q * f.p1.x + e * e * f.p2.x;
      this.pos.y =
        (1 - e) * (1 - e) * f.p0.y + q * f.p1.y + e * e * f.p2.y;
      if (this.phase === "flying" || this.phase === "returning") {
        this.ringAlpha = Math.min(1, this.ringAlpha + 0.12 * dt);
      }
      if (p >= 1) {
        this.pos = { ...f.p2 };
        this.flight = null;
        if (f.returning) {
          this.phase = "follow";
          this.ringAlpha = Math.max(0, this.ringAlpha - 0.35);
        } else {
          this.phase = "dwelling";
          this.dwellUntil = t + DWELL_MS;
        }
      }
    } else if (this.phase === "dwelling" && t >= this.dwellUntil) {
      if (this.settle) {
        const r = this.settle;
        this.settle = null;
        r();
      }
    }

    if (!this.flight && this.phase === "follow") {
      this.ringAlpha = Math.max(0, this.ringAlpha - 0.15 * dt);
    }

    this.ringPhase += 0.08 * dt;
    this.render();
  }

  private render() {
    if (!this.arrow || !this.ring || !this.ripple || !this.bubble) return;
    const d = performance.now();

    const scale = d < this.pointerDownUntil ? 0.84 : 1;
    const wiggle =
      d < this.wiggleUntil
        ? Math.sin(((this.wiggleUntil - d) / 40) * 6) * 7
        : 0;
    this.arrow.style.transform = `translate3d(${this.pos.x}px, ${this.pos.y}px, 0) scale(${scale}) rotate(${wiggle}deg)`;

    const pulse = 1 + Math.sin(this.ringPhase) * 0.1;
    this.ring.style.transform = `translate(${this.ringTarget.x}px, ${this.ringTarget.y}px) translate(-50%, -50%) scale(${pulse})`;
    this.ring.style.opacity = String(Math.min(1, this.ringAlpha));

    if (this.rippleActive) {
      const pr = (d - this.rippleStart) / 420;
      const rad = 6 + pr * 30;
      this.ripple.style.left = `${this.pos.x - rad}px`;
      this.ripple.style.top = `${this.pos.y - rad}px`;
      this.ripple.style.width = `${rad * 2}px`;
      this.ripple.style.height = `${rad * 2}px`;
      this.ripple.style.opacity = String(Math.max(0, 1 - pr));
    } else {
      this.ripple.style.opacity = "0";
    }

    let bx = this.pos.x + 24;
    let by = this.pos.y + 14;
    if (bx + this.bubbleWidth > window.innerWidth - 8) {
      bx = this.pos.x - this.bubbleWidth - 10;
    }
    if (by + 30 > window.innerHeight - 6) {
      by = window.innerHeight - 36;
    }
    this.bubble.style.transform = `translate(${bx}px, ${by}px)`;

    if (this.tagEl) {
      let tx = this.pos.x + 10;
      let ty = this.pos.y - 40;
      if (tx < 4) tx = 4;
      if (ty < 4) ty = this.pos.y + 16;
      this.tagEl.style.transform = `translate(${tx}px, ${ty}px)`;
    }
  }

  private setBubble(text: string, typing: boolean) {
    if (!this.bubble || !this.bubbleText || !this.caret) return;
    this.bubbleText.textContent = text;
    this.caret.style.display = typing ? "inline-block" : "none";
    this.bubbleWidth = this.bubble.offsetWidth || 0;
    this.bubble.style.opacity = "1";
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
  }

  private clearBubble() {
    if (this.bubble) this.bubble.style.opacity = "0";
  }

  private inject() {
    const host = document.createElement("div");
    host.id = "sih-agent-cursor-host";
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .arrow {
          position: absolute; left: 0; top: 0; width: 26px; height: 26px;
          will-change: transform;
          filter: drop-shadow(0 0 5px rgba(51,128,255,.9));
        }
        .arrow svg { display: block; overflow: visible; }
        .ring {
          position: absolute; left: 0; top: 0; width: 46px; height: 46px;
          border-radius: 50%;
          border: 3px solid rgba(51,128,255,.95);
          box-shadow: 0 0 14px rgba(51,128,255,.55), inset 0 0 10px rgba(51,128,255,.25);
          opacity: 0; will-change: transform;
          transform-origin: center center;
        }
        .ripple {
          position: absolute; left: 0; top: 0; width: 0; height: 0;
          border: 4px solid rgba(51,128,255,.9); border-radius: 50%;
          opacity: 0; will-change: transform, width, height;
        }
        .bubble {
          position: absolute; left: 0; top: 0;
          padding: 5px 10px; border-radius: 8px;
          background: rgba(18,26,40,.92); color: #fff;
          font: 600 12px/1.4 "Segoe UI", system-ui, -apple-system, sans-serif;
          white-space: nowrap; max-width: 280px;
          overflow: hidden; text-overflow: ellipsis;
          opacity: 0; transition: opacity .18s ease;
          box-shadow: 0 2px 12px rgba(0,0,0,.4);
          pointer-events: none;
        }
        .caret {
          display: none; width: 6px; height: 12px; margin-left: 2px;
          vertical-align: -2px; background: #7fc1ff;
          animation: sih-caret 1s steps(1) infinite;
        }
        .tag {
          position: absolute; left: 0; top: 0;
          padding: 3px 8px; border-radius: 6px;
          background: #0f2c4d; color: #7fd4ff;
          border: 1px solid rgba(127,212,255,.45);
          font: 800 11px/1.4 "Segoe UI", system-ui, sans-serif;
          white-space: nowrap; letter-spacing: .04em;
          opacity: 0; transition: opacity .16s ease;
          box-shadow: 0 2px 10px rgba(0,0,0,.45);
          pointer-events: none;
        }
        .outline {
          position: absolute; left: 0; top: 0;
          border: 2px solid rgba(51,128,255,.95);
          border-radius: 6px;
          box-shadow: 0 0 0 9999px rgba(11,18,32,.12), 0 0 18px rgba(51,128,255,.35);
          opacity: 0; transition: opacity .2s ease;
          pointer-events: none;
        }
        @keyframes sih-caret { 50% { opacity: 0; } }
      </style>
      <div class="arrow">
        <svg width="26" height="26" viewBox="0 0 26 26">
          <g transform="translate(-2,0)">
            <path d="${CURSOR_PATH}" fill="#3380ff" stroke="#ffffff" stroke-width="2.2" stroke-linejoin="round" />
          </g>
        </svg>
      </div>
      <div class="ring"></div>
      <div class="ripple"></div>
      <div class="bubble"><span class="bubble-text"></span><span class="caret"></span></div>
      <div class="tag"></div>
      <div class="outline"></div>
    `;
    document.documentElement.appendChild(host);
    this.host = host;
    this.root = root;
    this.arrow = root.querySelector(".arrow") as HTMLDivElement;
    this.ring = root.querySelector(".ring") as HTMLDivElement;
    this.ripple = root.querySelector(".ripple") as HTMLDivElement;
    this.bubble = root.querySelector(".bubble") as HTMLDivElement;
    this.bubbleText = root.querySelector(".bubble-text") as HTMLSpanElement;
    this.caret = root.querySelector(".caret") as HTMLSpanElement;
    this.tagEl = root.querySelector(".tag") as HTMLDivElement;
    this.outlineEl = root.querySelector(".outline") as HTMLDivElement;
  }

  private applyVisibility() {
    if (this.host) {
      this.host.style.display = this.enabled && this.visible ? "block" : "none";
    }
  }
}

export const cursor = new VirtualCursor();