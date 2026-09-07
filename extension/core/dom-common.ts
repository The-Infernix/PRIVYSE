// Shared DOM-walk semantics used by BOTH the serializer (which numbers elements
// in the screenshot the VLM sees) and the executor (which resolves those
// numbers back to live elements). Keeping the two identical guarantees the ID
// a click lands on is the same element the VLM picked from the overlay.

export const MAX_ELEMENTS = 120;

const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "details",
  "summary",
]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  )
    return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
}

export function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (HEADING_TAGS.has(tag)) return true;
  if (el.getAttribute("role")) return true;
  if (el.hasAttribute("onclick") || el.hasAttribute("onmousedown")) return true;
  if (tag === "img" && el.getAttribute("alt")) return true;
  if (el.getAttribute("tabindex")) return true;
  return false;
}

/**
 * Walk every accepted (visible + interactive) element in document order,
 * recursing into shadow roots exactly like the serializer's numbering pass.
 */
export function forEachElement(cb: (el: Element) => void) {
  function walk(root: Element | Document | ShadowRoot) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        const el = node as Element;
        if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
        if (!isInteractive(el)) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node: Element | null;
    while ((node = walker.nextNode() as Element | null)) {
      cb(node);
      if (node.shadowRoot) walk(node.shadowRoot);
    }
  }
  walk(document);
}

/** The element's index in the shared walk — i.e. the id the VLM saw. */
export function indexOfElement(el: Element): number {
  let found = -1;
  let count = 0;
  forEachElement((e) => {
    if (found >= 0) return;
    if (e === el) found = count;
    count++;
  });
  return found;
}

/**
 * Bboxes (in captured-screenshot pixel space, dpr-scaled like everywhere else)
 * of pixels whose text the DOM does NOT carry: canvases, images, videos.
 * The Phase 2 OCR layer runs only on these regions — DOM-covered areas are
 * already tokenized by the text sweep, so re-OCR'ing them is wasted budget.
 */
export function collectImageRegions(): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const dpr = window.devicePixelRatio || 1;
  const roots: (Element | Document | ShadowRoot)[] = [document];
  while (roots.length) {
    const root = roots.shift()!;
    const els = root.querySelectorAll("canvas, img, video") ?? [];
    for (const el of Array.from(els)) {
      if (el instanceof HTMLImageElement && !el.complete) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      out.push([
        Math.round(r.left * dpr),
        Math.round(r.top * dpr),
        Math.round(r.width * dpr),
        Math.round(r.height * dpr),
      ]);
    }
    const hosts = root.querySelectorAll("*") ?? [];
    for (const el of Array.from(hosts)) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  return out;
}