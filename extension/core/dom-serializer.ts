import type { DomElement } from "./protocol";
import { MAX_ELEMENTS, forEachElement } from "./dom-common";

const MAX_TEXT = 80;

/** textContent without embedded <style>/<script> leaking raw CSS/JS into the
 * model's view of an element (Google injects <style> inside visible
 * containers; its text otherwise pollutes every element label upstream). */
function cleanText(el: Element): string {
  const cl = el.cloneNode(true) as Element;
  cl.querySelectorAll("style, script, noscript, template").forEach((s) => s.remove());
  return (cl.textContent ?? "").trim();
}

function getRole(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "a":
      return "link";
    case "button":
      return "button";
    case "input":
      return (el as HTMLInputElement).type || "text";
    case "select":
      return "combobox";
    case "textarea":
      return "textbox";
    case "img":
      return "image";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    default:
      return tag;
  }
}

function resolveLabel(el: Element): string {
  const tag = el.tagName.toLowerCase();

  // Explicit aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  // <label for="id">
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) return cleanText(label) || "";
  }

  // Enclosing <label>
  if (tag !== "label") {
    const parentLabel = el.closest("label");
    if (parentLabel) {
      // Use text not including the element itself
      const clone = parentLabel.cloneNode(true) as HTMLLabelElement;
      clone.querySelectorAll("input, select, textarea, style, script").forEach((c) => c.remove());
      const text = clone.textContent?.trim();
      if (text) return text;
    }
  }

  // Input-specific attributes
  if (tag === "input" || tag === "textarea" || tag === "select") {
    const ph = el.getAttribute("placeholder");
    if (ph) return ph;
    const ac = el.getAttribute("autocomplete");
    if (ac) return ac;
    const name = el.getAttribute("name");
    if (name) return name;
  }

  return "";
}

function getText(el: Element): string {
  const tag = el.tagName.toLowerCase();

  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (input.type === "password" || input.type === "hidden") return "";
    return input.value || input.placeholder || "";
  }
  if (tag === "textarea") return (el as HTMLTextAreaElement).value || "";
  if (tag === "select") {
    const sel = el as HTMLSelectElement;
    return sel.options[sel.selectedIndex]?.text || "";
  }
  if (tag === "img") return el.getAttribute("alt") || "";

  const text = cleanText(el);
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "…" : text;
}

function getValue(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (input.type === "password" || input.type === "hidden") return "[SECRET]";
    if (input.type === "checkbox" || input.type === "radio")
      return input.checked ? "checked" : "unchecked";
    return input.value;
  }
  if (tag === "textarea") return (el as HTMLTextAreaElement).value;
  if (tag === "select") {
    const sel = el as HTMLSelectElement;
    return sel.value;
  }
  return undefined;
}

function toScreenshotBbox(
  rect: DOMRect,
  dpr: number,
): [number, number, number, number] {
  return [
    Math.round(rect.left * dpr),
    Math.round(rect.top * dpr),
    Math.round(rect.width * dpr),
    Math.round(rect.height * dpr),
  ];
}

function collectElements(elements: DomElement[], dpr: number) {
  forEachElement((node) => {
    if (elements.length >= MAX_ELEMENTS) return;
    const rect = node.getBoundingClientRect();
    elements.push({
      id: elements.length,
      tag: node.tagName.toLowerCase(),
      role: getRole(node),
      text: getText(node),
      label: resolveLabel(node),
      bbox: toScreenshotBbox(rect, dpr),
      value: getValue(node),
    });
  });
}

export function serializeDOM(): DomElement[] {
  const dpr = window.devicePixelRatio || 1;
  const elements: DomElement[] = [];
  collectElements(elements, dpr);
  return elements;
}
