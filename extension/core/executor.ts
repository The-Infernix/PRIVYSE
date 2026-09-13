import type { AgentAction, VerifiedTarget } from "./protocol";
import { cursor } from "./virtual-cursor";
import { forEachElement, indexOfElement } from "./dom-common";
import { validateNavigationUrl, isFileInput, trySubmitForm } from "./action-guards";

// Deterministic element findings the executor confirmed this run (e.g. the
// real <input> it auto-descended into from a non-typeable wrapper). background
// reads these after each action and injects them into the VLM prompt as
// "use verbatim" overrides — so the VLM never re-guesses a known-good target.
// Mirrors clicky-windows' "DETECTED ELEMENT use verbatim" pattern.
const verifiedThisRun: VerifiedTarget[] = [];

/** Reset the per-run verified-target memory (call at loop/step start). */
export function resetVerifiedTargets(): void {
  verifiedThisRun.length = 0;
}

/** Snapshot of verified targets for this run (deduped by id). */
export function getVerifiedTargets(): VerifiedTarget[] {
  const byId = new Map<number, VerifiedTarget>();
  for (const t of verifiedThisRun) byId.set(t.id, t);
  return [...byId.values()];
}

function recordVerified(id: number, desc: string) {
  if (!verifiedThisRun.some((t) => t.id === id)) {
    verifiedThisRun.push({ id, desc });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Clicked-typeable memory — the executor knows deterministically whether a
// click landed on (or focused) a real text field. When the VLM keeps CLICKING
// the same input instead of following up with a `type`, this lets background
// catch the "forgot to type" failure on the SECOND repeat (sooner + with an
// explicit hint) instead of the generic same-action 3x recovery.
// ─────────────────────────────────────────────────────────────────────────────

const clickedTypeables = new Map<number, string>();

function recordClickedTypeable(id: number, desc: string): void {
  if (!clickedTypeables.has(id)) clickedTypeables.set(id, desc);
}

/** Reset the per-run clicked-typeable memory (call at loop/step start). */
export function resetClickedTypeables(): void {
  clickedTypeables.clear();
}

/** True if the executor deterministically clicked/focused this element and it
 * is a real text field (input/textarea/select/contenteditable). */
export function isKnownTypeable(id: number): boolean {
  return clickedTypeables.has(id);
}

/** Human-readable description of a known-typeable element. */
export function describeKnownTypeable(id: number): string {
  return clickedTypeables.get(id) ?? `target #${id}`;
}

function findElementById(id: number): Element | null {
  let count = 0;
  let found: Element | null = null;
  forEachElement((el) => {
    if (found) return;
    if (count === id) found = el;
    count++;
  });
  return found;
}

/**
 * Resolve the element to type into. The VLM often targets a wrapper
 * (<yt-searchbox>, a <button>, a <div>) instead of the real <input>. If the
 * given element isn't itself typeable, descend to the first inner typeable
 * element so the action still works instead of throwing.
 */
function resolveTypeable(el: Element): Element | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return el;
  }
  if (el instanceof HTMLElement && el.isContentEditable) return el;
  return el.querySelector(
    "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
  ) as Element | null;
}

function describeTypeTarget(el: Element): string {
  const id = indexOfElement(el);
  const label = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim();
  const desc = `<${el.tagName.toLowerCase()}>` + (id >= 0 ? ` #${id}` : "") + (label ? ` "${label}"` : "");
  return desc;
}

function dispatchMouseEvent(el: Element, kind: "down" | "up" | "click") {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const base: MouseEventInit = {
    bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0,
  };
  el.dispatchEvent(new PointerEvent(`pointer${kind}`, { ...base, pointerId: 1, pointerType: "mouse" }));
  el.dispatchEvent(new MouseEvent(kind, base));
}

function dispatchClick(el: Element) {
  dispatchMouseEvent(el, "down");
  dispatchMouseEvent(el, "up");
  dispatchMouseEvent(el, "click");
  if (el instanceof HTMLElement) el.click();
}

async function clickElement(el: Element, knownId = -1) {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  cursor.observe("observe");
  await cursor.flyTo(el, knownId >= 0 ? `SOM ${knownId}` : undefined);
  cursor.click();
  dispatchClick(el);

  // Deterministic record for the "forgot to type" guard: this click made a real
  // text field the active target. If the VLM clicks it again without a `type`,
  // background steers toward typing (or auto-types) instead of looping.
  // Recorded under the id the VLM actually clicked so the guard always matches.
  const active =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable)
      ? el
      : (resolveTypeable(el) as Element | null);
  if (active) {
    const aid = knownId >= 0 ? knownId : indexOfElement(active);
    if (aid >= 0) recordClickedTypeable(aid, describeTypeTarget(active));
  }

  // Container clicks (e.g. <yt-searchbox>) don't focus the inner input by
  // themselves — focus the first typeable descendant too so the dropdown opens.
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
    const inner = resolveTypeable(el);
    if (inner && inner !== el && inner instanceof HTMLElement) {
      inner.focus();
    }
  }
  cursor.returnToMouse();
}

async function typeInto(el: Element, text: string) {
  const target = resolveTypeable(el);
  if (!target) {
    throw new Error(
      `type failed: ${describeTypeTarget(el)} is not typeable and has no inner input. ` +
        `A 'type' action must target an <input>/<textarea>/<select> element directly.`,
    );
  }
  const descended = target !== el;
  const typedRef = describeTypeTarget(target);

  target.scrollIntoView({ block: "center", behavior: "smooth" });

  cursor.observe("observe");
  await cursor.flyTo(target, `SOM ${indexOfElement(target)}`);
  cursor.click();

  // Click the element first to focus + activate it (important for SPAs)
  if (target instanceof HTMLElement) {
    (target as HTMLElement).focus();
    dispatchClick(target);
    // Re-focus after click (some SPAs steal focus)
    (target as HTMLElement).focus();
  }

  const insertText = () => {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      // Method 1: execCommand — works with React controlled inputs (YouTube, etc.)
      (target as HTMLInputElement | HTMLTextAreaElement).select();
      const ok = document.execCommand("insertText", false, text);
      if (ok) return;

      // Method 2: native value setter fallback
      const proto = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(target, text);
      else (target as HTMLInputElement).value = text;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (target instanceof HTMLSelectElement) {
      const option = Array.from(target.options).find(
        (o) => o.text.toLowerCase() === text.toLowerCase(),
      );
      if (option) target.value = option.value;
      else target.value = text;
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (target instanceof HTMLElement && target.isContentEditable) {
      target.focus();
      const ok = document.execCommand("insertText", false, text);
      if (!ok) {
        target.textContent = text;
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }

    throw new Error(`type failed: cannot type into <${target.tagName.toLowerCase()}>`);
  };

  insertText();
  cursor.typeText(text);
  cursor.returnToMouse();

  // The executor confirmed this target works. Record it so background injects
  // it into the VLM prompt as "use verbatim" — the model won't re-pick the
  // non-typeable wrapper next time.
  if (target instanceof Element) {
    const tid = indexOfElement(target);
    if (tid >= 0) recordVerified(tid, describeTypeTarget(target));
  }

  const note = descended
    ? `typed "${text}" into ${typedRef} (auto-descended from <${el.tagName.toLowerCase()}>#${indexOfElement(el)})`
    : `typed "${text}" into ${typedRef}`;
  return note;
}

function pressKey(key: string) {
  const normalized = normalizeKey(key);
  const opts: KeyboardEventInit = {
    key: normalized.key,
    code: normalized.code,
    bubbles: true,
    cancelable: true,
  };

  // Dispatch on the currently focused element (not window) so SPAs receive it
  const target = document.activeElement || window;
  target.dispatchEvent(new KeyboardEvent("keydown", opts));
  target.dispatchEvent(new KeyboardEvent("keyup", opts));
  cursor.pressKey(normalized.key);

  // Synthetic (untrusted) key events never trigger native form submission,
  // so Enter in a real search form would silently do nothing (Google etc.
  // rely on the default action). Deterministic fallback: submit the enclosing
  // form with requestSubmit() — guarded by action-guards (a javascript:/data:
  // form action is an exfiltration primitive and is refused, see trySubmitForm).
  if (normalized.key === "Enter") {
    const inForm =
      document.activeElement instanceof HTMLElement
        ? (document.activeElement.closest("form") as HTMLFormElement | null)
        : null;
    trySubmitForm(inForm);
  }
}

function normalizeKey(key: string): { key: string; code: string } {
  const map: Record<string, { key: string; code: string }> = {
    enter: { key: "Enter", code: "Enter" },
    tab: { key: "Tab", code: "Tab" },
    escape: { key: "Escape", code: "Escape" },
    backspace: { key: "Backspace", code: "Backspace" },
    delete: { key: "Delete", code: "Delete" },
    arrowup: { key: "ArrowUp", code: "ArrowUp" },
    arrowdown: { key: "ArrowDown", code: "ArrowDown" },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft" },
    arrowright: { key: "ArrowRight", code: "ArrowRight" },
    space: { key: " ", code: "Space" },
  };
  const k = key.toLowerCase().trim();
  if (map[k]) return map[k];
  if (key.length === 1) return { key, code: key.toUpperCase() };
  return { key: key[0].toUpperCase() + key.slice(1), code: key[0].toUpperCase() + key.slice(1) };
}

export async function executeAction(action: AgentAction): Promise<string> {
  cursor.ensure();
  switch (action.type) {
    case "scroll": {
      const amount = action.amount ?? 600;
      window.scrollBy({ top: action.direction === "down" ? amount : -amount, behavior: "smooth" });
      cursor.scroll(action.direction);
      return `scrolled ${action.direction} by ${amount}px`;
    }
    case "navigate": {
      const g = validateNavigationUrl(action.url);
      if (!g.ok) {
        throw new Error(`navigate refused: ${g.reason}`);
      }
      window.location.href = action.url;
      return `navigating to ${action.url}`;
    }
    case "wait": {
      const ms = Math.min(action.ms ?? 500, 5000);
      await new Promise((r) => setTimeout(r, ms));
      return `waited ${ms}ms`;
    }
    case "click": {
      const el = findElementById(action.target);
      if (!el) throw new Error(`click: element #${action.target} not found`);
      if (isFileInput(el)) {
        throw new Error(
          `click refused: target is <input type="file"> — opening a picker / forcing a file selection without a user gesture is a guard breach`,
        );
      }
      await clickElement(el, action.target);
      return `clicked #${action.target} (${el.tagName.toLowerCase()})`;
    }
    case "type": {
      const el = findElementById(action.target);
      if (!el) throw new Error(`type: element #${action.target} not found`);
      return await typeInto(el, action.text);
    }
    case "press":
      pressKey(action.key);
      return `pressed ${action.key}`;
    case "extract":
      return `extract: ${action.text ?? ""}`;
    case "done":
      cursor.notify("Done");
      return `done: ${action.answer ?? ""}`;
    default:
      return `unknown action: ${JSON.stringify(action)}`;
  }
}
