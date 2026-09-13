// Deterministic executor guards — pure, DOM-free surfaces kept out of
// executor.ts so they are testable in the bench harness without a browser,
// AND applied in the real page when the guard fires. Design: any action an
// attacker-controlled page (or prompt-injected VLM) could weaponize gets a
// explicit, deterministic block with a reason string instead of a silent pass.

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

/** Resolve a raw URL against a base; http/https only. Any other scheme
 * (javascript:, data:, file:, blob:, about:, chrome:) is refused. */
export function validateNavigationUrl(raw: string, base = "https://extension.local/"): GuardResult {
  try {
    const u = new URL(raw, base);
    const scheme = u.protocol.toLowerCase();
    if (scheme !== "http:" && scheme !== "https:") {
      return { ok: false, reason: `blocked scheme "${scheme}" (http/https only)` };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "malformed URL" };
  }
}

/** Guard a form's target (its raw `action` attribute, may be relative/null).
 * A `javascript:`/`data:`/`mailto:` action is an exfiltration primitive — the
 * page could POST typed PII to a scheme handler. Same-origin vs cross-origin
 * http(s) actions are BOTH allowed (the product legitimately submits to
 * payment/identity hosts); only non-web schemes are refused. */
export function validateFormAction(
  rawAction: string | null,
  pageOrigin: string,
): GuardResult {
  if (!rawAction) return { ok: true };
  try {
    const u = new URL(rawAction, pageOrigin);
    const scheme = u.protocol.toLowerCase();
    if (scheme !== "http:" && scheme !== "https:") {
      return { ok: false, reason: `form action blocked: "${scheme}" scheme` };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "form action malformed" };
  }
}

/** True if the element is a <input type="file">. Forcing a click on one opens
 * a native picker (annoyance) or, from an attacker-injected flow, attempts to
 * select a file the user never intended to share. Refuse outright. */
export function isFileInput(el: unknown): boolean {
  return (
    typeof HTMLInputElement !== "undefined" &&
    el instanceof HTMLInputElement &&
    el.type === "file"
  );
}

/** Last guard verdict (for the harness / console visibility). */
let lastGuardNotice: string | null = null;
export function getLastGuardNotice(): string | null {
  return lastGuardNotice;
}

/** Deterministic Enter-submission of the focused element's enclosing form.
 * Applies validateFormAction BEFORE requestSubmit; a refused action leaves a
 * notice and performs no submission. The original dataset+timeout dance from
 * pressKey() lives here so the guard and the submit are one atomic unit. */
export function trySubmitForm(form: HTMLFormElement | null): boolean {
  if (!form) return false;
  const g = validateFormAction(form.getAttribute("action"), form.ownerDocument.location.origin);
  if (!g.ok) {
    lastGuardNotice = `submit blocked: ${g.reason}`;
    return false;
  }
  const inForm = form;
  const hasContent = Array.from(inForm.elements).some(
    (el) =>
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
      (el.value || "").length > 0,
  );
  if (!hasContent) return false;
  if (inForm.dataset.sihSubmitted) return false;
  inForm.dataset.sihSubmitted = "1";
  setTimeout(() => {
    if (!inForm.dataset.sihSubmitted) {
      inForm.dataset.sihSubmitted = "1";
      inForm.requestSubmit();
    }
  }, 0);
  return true;
}

/** Reset guard state (per run). */
export function resetGuards(): void {
  lastGuardNotice = null;
}