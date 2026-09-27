// Human-in-the-loop ask banner — a shadow-DOM overlay that floats near the
// top of the page while the agent waits for a user decision. Mirrors the
// side-panel ask card so the question is answerable even when the panel is
// closed (the orb keeps the agent re-openable from the page). Answers and
// skips go back to the background via ask-answer / ask-skip messages.

import type { ExtMessage } from "./protocol";

const HOST_ID = "sih-ask-banner";

class AskBanner {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private qEl: HTMLElement | null = null;
  private optsEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;

  private initd = false;
  private enabled = true;
  private visible = true;
  private active = false;

  ensure() {
    if (this.initd) return;
    this.initd = true;
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

  /** True while a question is waiting on screen. */
  isActive(): boolean {
    return this.active;
  }

  show(question: string, options: string[], kind: "decide" | "confirm") {
    this.active = true;
    this.ensure();
    if (!this.qEl || !this.optsEl || !this.inputEl) return;

    this.qEl.textContent = question;
    this.optsEl.innerHTML = "";
    const opts = options.filter(Boolean);
    if (opts.length === 0 && kind === "confirm") opts.push("Proceed", "Cancel");
    for (const opt of opts) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = opt;
      b.className = kind === "confirm" && opt === "Cancel" ? "opt opt-danger" : "opt";
      b.addEventListener("click", () => {
        this.respond(opt);
      });
      this.optsEl.appendChild(b);
    }
    this.inputEl.placeholder =
      kind === "confirm" ? "type an answer or Proceed/Cancel…" : "type your answer…";
    this.inputEl.value = "";
    this.applyVisibility();
  }

  hide() {
    this.active = false;
    this.applyVisibility();
  }

  /** Send the answer (or "" on skip) and dismiss the banner. */
  private respond(answer: string) {
    this.hide();
    if (answer) {
      browser.runtime
        .sendMessage({ type: "ask-answer", answer } satisfies ExtMessage)
        .catch(() => {});
    } else {
      browser.runtime.sendMessage({ type: "ask-skip" } satisfies ExtMessage).catch(() => {});
    }
  }

  private onInputEnter = () => {
    const v = this.inputEl?.value.trim() ?? "";
    if (v) this.respond(v);
  };

  private inject() {
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .wrap {
          position: fixed; left: 50%; top: 18px; transform: translateX(-50%);
          width: min(460px, calc(100vw - 24px));
          pointer-events: auto;
          padding: 14px 16px;
          border-radius: 14px;
          background: rgba(13,22,41,.98);
          border: 1px solid rgba(56,189,248,.5);
          box-shadow: 0 18px 50px rgba(0,0,0,.65), 0 0 0 4px rgba(56,189,248,.12);
          color: #e5edf8;
          font: 600 13px/1.45 "Segoe UI", system-ui, sans-serif;
          display: none;
        }
        .wrap.on { display: block; animation: ask-pop .16s ease-out; }
        @keyframes ask-pop {
          from { opacity: 0; transform: translateX(-50%) translateY(-6px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        .head { font-size: 9.5px; font-weight: 800; letter-spacing: .08em; color: #7fd4ff; margin-bottom: 6px; }
        .q { font-size: 13.5px; color: #f0f6ff; margin-bottom: 10px; }
        .opts { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 9px; }
        .opt {
          padding: 6px 12px; border-radius: 999px; cursor: pointer;
          background: rgba(56,189,248,.14); border: 1px solid rgba(56,189,248,.4);
          color: #cdeeff; font: 600 12px "Segoe UI", system-ui, sans-serif;
        }
        .opt:hover { background: rgba(56,189,248,.26); }
        .opt-danger { background: rgba(248,113,113,.14); border-color: rgba(248,113,113,.45); color: #fecaca; }
        .opt-danger:hover { background: rgba(248,113,113,.28); }
        .row { display: flex; gap: 8px; }
        .inp {
          flex: 1; min-width: 0;
          padding: 7px 10px; border-radius: 9px;
          background: rgba(8,14,26,.85); border: 1px solid #2e4170;
          color: #fff; font: 500 12.5px "Segoe UI", system-ui, sans-serif; outline: none;
        }
        .inp:focus { border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56,189,248,.2); }
        .go, .skip { padding: 7px 14px; border-radius: 9px; cursor: pointer;
          font: 700 12px "Segoe UI", system-ui, sans-serif; }
        .go { background: linear-gradient(135deg,#38bdf8,#0ea5e9); border: 0; color: #04121f; }
        .go:hover { filter: brightness(1.08); }
        .skip { background: transparent; border: 1px solid #2e4170; color: #8b9bb8; }
        .skip:hover { color: #fecaca; border-color: rgba(248,113,113,.5); }
      </style>
      <div class="wrap" part="wrap">
        <div class="head">🤝 PRIVYSE NEEDS YOUR INPUT</div>
        <div class="q"></div>
        <div class="opts"></div>
        <div class="row">
          <input class="inp" type="text" autocomplete="off" />
          <button class="go" type="button">Answer</button>
          <button class="skip" type="button">Skip</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(host);

    this.host = host;
    this.root = root;
    this.qEl = root.querySelector(".q") as HTMLElement;
    this.optsEl = root.querySelector(".opts") as HTMLElement;
    this.inputEl = root.querySelector(".inp") as HTMLInputElement;
    const wrap = root.querySelector(".wrap") as HTMLElement;
    const go = root.querySelector(".go") as HTMLButtonElement;
    const skip = root.querySelector(".skip") as HTMLButtonElement;
    const onInput = () => {
      const v = this.inputEl?.value.trim() ?? "";
      if (v) this.respond(v);
    };
    go.addEventListener("click", onInput);
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") onInput();
    });
    skip.addEventListener("click", () => this.respond(""));

    // Track the wrap for visibility toggling.
    (this.root as unknown as { wrapEl?: HTMLElement }).wrapEl = wrap;
  }

  private applyVisibility() {
    if (!this.root) return;
    const wrap = (this.root as unknown as { wrapEl?: HTMLElement }).wrapEl;
    if (!wrap) return;
    wrap.classList.toggle("on", this.enabled && this.visible && this.active);
    if (this.inputEl && this.active) {
      // Focus the answer box so the user can type without clicking first.
      timeoutFocus(this.inputEl);
    }
  }
}

function timeoutFocus(el: HTMLInputElement) {
  window.setTimeout(() => {
    try {
      el.focus();
    } catch {
      /* input may be detached */
    }
  }, 30);
}

export const askBanner = new AskBanner();