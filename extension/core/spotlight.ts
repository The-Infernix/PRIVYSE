// Page-wide "spotlight" command palette. Lives on the browser page in a
// shadow-DOM host (like the virtual cursor) so Alt+K from any page pops a
// real overlay in the current tab — independent of the side panel.

import { SERVER_URL } from "./config";

const HOST_ID = "sih-spotlight-host";
const STORAGE_TASK = "sihTask";
const STORAGE_CURSOR = "sihCursorEnabled";
const STORAGE_MODEL = "sihModel";
const STORAGE_LESSONS = "sihLessons";

interface SpotlightCommand {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  run: () => void | Promise<void>;
}

export class SpotlightOverlay {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private input: HTMLInputElement | null = null;
  private list: HTMLUListElement | null = null;
  private box: HTMLDivElement | null = null;
  private selIndex = 0;
  private task = "";

  private ensureHost() {
    if (this.host) return;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483647;display:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host-context(body), * { box-sizing: border-box; }
        .backdrop {
          position: fixed; inset: 0;
          background: rgba(6, 12, 26, 0.55);
          backdrop-filter: blur(3px);
          display: grid;
          place-items: start center;
          padding: 12vh 16px 0;
          font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        }
        .palette {
          width: min(430px, 92vw);
          position: fixed;
          background: #111a2e;
          border: 1px solid #2e4170;
          border-radius: 14px;
          box-shadow: 0 18px 50px rgba(0,0,0,0.6);
          overflow: hidden;
          animation: sih-pop .14s ease-out;
        }
        @keyframes sih-pop {
          from { opacity: 0; transform: translateY(-8px) scale(.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .palette input {
          width: 100%; padding: 13px 15px;
          font-size: 14px; color: #e5edf8;
          background: #0b1322;
          border: 0; border-bottom: 1px solid #22304d;
          outline: none; border-radius: 0;
        }
        .palette input::placeholder { color: #5b6b8c; }
        ul { list-style: none; margin: 0; padding: 6px; max-height: 280px; overflow-y: auto; }
        li { margin: 0; padding: 0; }
        li button {
          width: 100%; display: flex; align-items: center;
          justify-content: space-between; gap: 12px;
          padding: 9px 12px; border: 0; border-radius: 8px;
          background: transparent; color: #e5edf8;
          font-size: 13px; text-align: left; cursor: pointer;
        }
        li button.sel, li button:hover { background: #1c2a48; }
        li button:focus-visible { outline: 1px solid #38bdf8; }
        .hint {
          color: #8b9bb8; font-size: 10.5px; font-weight: 600;
          font-variant-caps: all-small-caps; letter-spacing: .06em;
        }
        .icon { color: #38bdf8; font-size: 12px; min-width: 18px; }
        .empty { color: #8b9bb8; font-size: 12px; padding: 12px; }
        .foots {
          display: flex; gap: 14px; justify-content: center;
          padding: 8px; font-size: 10px; color: #8b9bb8;
          border-top: 1px solid #22304d; background: #0b1322;
        }
        .foots kbd {
          font-family: inherit; font-size: 10px; font-weight: 600;
          color: #aeb8cc; background: #16203a; border: 1px solid #2e4170;
          border-bottom-width: 2px; border-radius: 4px; padding: 1px 5px; margin: 0 1px;
        }
        .toast {
          margin: 8px; padding: 9px 12px; border-radius: 8px;
          font-size: 12px; color: #d1fae5; background: #123d33;
          border: 1px solid #22c55e33;
        }
        .toast.err { color: #fecaca; background: #431c22; border-color: #ef444433; }
      </style>
      <div class="backdrop" data-role="backdrop">
        <div class="palette" data-role="box">
          <input placeholder="Type a command or a task to run…" spellcheck="false" />
          <ul></ul>
          <div class="foots">
            <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
            <span><kbd>Enter</kbd> run</span>
            <span><kbd>Esc</kbd> close</span>
          </div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(host);

    this.host = host;
    this.root = root;
    this.input = root.querySelector("input");
    this.list = root.querySelector("ul");
    this.box = root.querySelector<HTMLDivElement>("[data-role=box]");

    const backdrop = root.querySelector<HTMLDivElement>("[data-role=backdrop]")!;
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) this.close();
    });

    this.input!.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const n = this.list!.children.length;
        if (n) this.selIndex = (this.selIndex + 1) % n;
        this.render();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const n = this.list!.children.length;
        if (n) this.selIndex = (this.selIndex - 1 + n) % n;
        this.render();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const btns = this.list!.querySelectorAll("button");
        const b = btns[this.selIndex];
        if (b) this.run(this.list!.children[this.selIndex] as HTMLElement);
      }
    });
    this.input!.addEventListener("input", () => {
      this.selIndex = 0;
      this.render();
    });
    this.input!.addEventListener("blur", () => this.close());
  }

  private async storageTask(): Promise<string> {
    const { [STORAGE_TASK]: t } = (await browser.storage.local.get(STORAGE_TASK)) as {
      [STORAGE_TASK]?: string;
    };
    return (t || "").trim();
  }

  async open(anchor?: { x: number; y: number }) {
    this.ensureHost();
    try {
      this.task = await this.storageTask();
    } catch {
      this.task = "";
    }
    this.host!.style.display = "block";
    this.input!.value = "";
    this.selIndex = 0;
    this.render();
    this.positionPalette(anchor);
    // Focus on the next frame so the panel doesn't steal it mid-open.
    requestAnimationFrame(() => this.input!.focus());
  }

  /** Place the palette near the cursor, clamped to the viewport. */
  private positionPalette(anchor?: { x: number; y: number }) {
    const box = this.box;
    if (!box) return;
    const W = Math.min(430, window.innerWidth - 16);
    const H = 300;
    const pad = 14;
    let left: number;
    let top: number;
    if (anchor) {
      // Prefer opening right-below the cursor like a context menu.
      left = anchor.x + 22;
      top = anchor.y + 18;
    } else {
      left = (window.innerWidth - W) / 2;
      top = window.innerHeight * 0.14;
    }
    left = Math.max(pad, Math.min(left, window.innerWidth - W - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - H - pad));
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  }

  private close() {
    if (this.host) this.host.style.display = "none";
    this.clearToast();
  }

  private commands(query: string): SpotlightCommand[] {
    const q = query.trim().toLowerCase();
    const taskLabel = (q ? query.trim() : this.task) || "";
    const list: SpotlightCommand[] = [
      {
        id: "run-task",
        label: taskLabel ? `Run task: "${taskLabel}"` : "Run task… (type a task)",
        hint: "loop",
        keywords: "run task execute loop",
        run: async () => {
          if (!taskLabel) return;
          await browser.storage.local.set({ [STORAGE_TASK]: taskLabel });
          await browser.runtime.sendMessage({ type: "start-loop", task: taskLabel });
        },
      },
      {
        id: "start-loop",
        label: "Start agent loop",
        hint: "loop",
        keywords: "start loop begin auto run",
        run: async () => {
          await browser.storage.local.set({
            [STORAGE_TASK]: this.task || "Scroll down the page",
          });
          await browser.runtime.sendMessage({
            type: "start-loop",
            task: this.task || "Scroll down the page",
          });
        },
      },
      {
        id: "stop-loop",
        label: "Stop agent loop",
        hint: "stop",
        keywords: "stop loop halt cancel abort",
        run: () => browser.runtime.sendMessage({ type: "stop-loop" }),
      },
      {
        id: "step",
        label: "Run one step",
        hint: "step",
        keywords: "step single one execute action",
        run: async () => {
          await browser.runtime.sendMessage({
            type: "run-step",
            task: this.task || "Scroll down the page",
          });
        },
      },
      {
        id: "open-panel",
        label: "Open agent side panel",
        hint: "panel",
        keywords: "open panel side extension sidebar",
        run: () => browser.runtime.sendMessage({ type: "open-panel" }),
      },
      {
        id: "cursor-toggle",
        label: "Toggle agent cursor",
        hint: "cursor",
        keywords: "cursor ghost toggle clicky pointer",
        run: async () => {
          const { [STORAGE_CURSOR]: enabled } = (await browser.storage.local.get(
            STORAGE_CURSOR,
          )) as { [STORAGE_CURSOR]?: boolean };
          const next = enabled !== false ? false : true;
          await browser.storage.local.set({ [STORAGE_CURSOR]: next });
          await browser.runtime.sendMessage({ type: "cursor-toggle", enabled: next });
        },
      },
      {
        id: "health",
        label: "Check server health",
        hint: "health",
        keywords: "server health vlm status ping check diagnostics",
        run: async () => {
          try {
            const r = await fetch(`${SERVER_URL}/health`);
            const j = (await r.json()) as {
              status: string;
              vlm_connected: boolean;
              vlm_model: string;
            };
            this.toast(
              `Server ${j.status} · VLM ${j.vlm_connected ? "online" : "offline"} (${j.vlm_model})`,
              false,
            );
          } catch {
            this.toast(`Server unreachable at ${SERVER_URL}`, true);
          }
        },
      },
    {
        id: "model",
        label: "Switch model",
        hint: "model",
        keywords: "model vlm switch 3b 7b llm accent strong fast",
        run: async () => {
          const { [STORAGE_MODEL]: cur } = (await browser.storage.local.get(
            STORAGE_MODEL,
          )) as { [STORAGE_MODEL]?: string };
          const next = cur === "qwen2.5vl:7b" ? "qwen2.5vl:3b" : "qwen2.5vl:7b";
          await browser.storage.local.set({ [STORAGE_MODEL]: next });
          this.toast(`model → ${next}`, false);
        },
      },
      {
        id: "lessons",
        label: "Clear learned lessons",
        hint: "reset",
        keywords: "clear lessons learning memory reset forget site",
        run: async () => {
          await browser.storage.local.remove(STORAGE_LESSONS);
          this.toast("cleared all learned lessons", false);
        },
      },
    ];
    if (!q) return list;
    return list.filter(
      (c) => `${c.label} ${c.keywords}`.toLowerCase().includes(q),
    );
  }

  private render() {
    const ul = this.list!;
    ul.innerHTML = "";
    const list = this.commands(this.input!.value);
    this.selIndex = Math.min(this.selIndex, Math.max(0, list.length - 1));
    if (list.length === 0) {
      const li = document.createElement("li");
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No matching commands.";
      li.appendChild(p);
      ul.appendChild(li);
      return;
    }
    list.forEach((c, i) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.cmd = c.id;
      if (i === this.selIndex) btn.classList.add("sel");
      const label = document.createElement("span");
      label.textContent = c.label;
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = c.hint;
      btn.append(label, hint);
      li.appendChild(btn);
      ul.appendChild(li);
    });
    const sel = ul.querySelector<HTMLButtonElement>("button.sel");
    sel?.scrollIntoView({ block: "nearest" });
  }

  private run(li: HTMLElement) {
    const q = this.input!.value;
    const cmd = this.commands(q).find(
      (c) => c.id === li.querySelector("button")?.dataset.cmd,
    );
    if (!cmd) return;
    const before = this.host!.style.display;
    this.close();
    if (before !== "none") void cmd.run();
  }

  private toast(text: string, isError: boolean) {
    if (!this.root || !this.box) return;
    this.clearToast();
    const div = document.createElement("div");
    div.className = `toast${isError ? " err" : ""}`;
    div.textContent = text;
    this.box!.appendChild(div);
  }

  private clearToast() {
    this.box?.querySelector(".toast")?.remove();
  }
}

export const spotlight = new SpotlightOverlay();