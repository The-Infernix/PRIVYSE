// SIH 26171 — Forensic Exhibit: interactive redaction map.
//
// Renders every redaction bbox from the privacy message as a tappable overlay
// on top of a side-panel screenshot (sanitized OR original). Clicking a region
// opens an audit card explaining which detector found it, what tier protection
// was applied, and the stable token it maps to.
//
// Pure DOM — no network, no backend. All values are the masked form; the raw
// PII never reaches this module.

import type { RedactionView } from "@/core/protocol";

export interface RegionDescriptor extends RedactionView {
  /** Stable index within the step (used for aria labels + ids). */
  i: number;
}

/** Human label for the detector that produced the region. */
export function detectorLabel(source: RedactionView["source"]): string {
  switch (source) {
    case "dom":
      return "DOM rule · labelled field / value scan";
    case "text":
      return "text-node sweep · visible prose";
    case "vision":
      return "on-device vision · face / OCR";
    case "perception":
      return "local ViT · region escalation";
    default:
      return "on-device sanitizer";
  }
}

/** Compact classification label + tier colour class for a region. */
export function tierMeta(tier: RedactionView["tier"]): {
  label: string;
  cls: string;
} {
  switch (tier) {
    case "A":
      return { label: "Tier A · blackout", cls: "tier-a" };
    case "B":
      return { label: "Tier B · stable token", cls: "tier-b" };
    case "C":
      return { label: "Tier C · blur / taint", cls: "tier-c" };
  }
}

/**
 * Mount clickable region boxes over `img` (which lives inside `stage`, a
 * position:relative wrapper). Regions use percentage coordinates so they track
 * the CSS-scaled image automatically. Returns a destroy() to tear down.
 */
export function renderRegionOverlay(
  stage: HTMLElement,
  img: HTMLImageElement,
  regions: RedactionView[],
  onInspect: (region: RegionDescriptor, anchor: HTMLElement) => void,
): { layer: HTMLElement; destroy: () => void } {
  const layerId = `region-layer-${Math.random().toString(36).slice(2, 9)}`;
  let layer = stage.querySelector<HTMLElement>(`.region-layer[data-layer="${layerId}"]`);
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "region-layer";
    layer.dataset.layer = layerId;
    stage.appendChild(layer);
  } else {
    layer.innerHTML = "";
  }

  // Natural dimensions are 0 before the image decodes (data URLs are async),
  // and setting a NEW src resets them to 0 until the fresh decode lands. So we
  // rebuild the boxes from scratch on every 'load' — this keeps the map aligned
  // when a filmstrip frame swaps the screenshot under the overlay.
  const place = () => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (w === 0 || h === 0) return;
    layer!.innerHTML = "";
    for (const r of regions) {
      const box = document.createElement("button");
      box.type = "button";
      box.className = `region-box ${tierMeta(r.tier).cls}`;
      box.style.left = `${(r.bbox[0] / w) * 100}%`;
      box.style.top = `${(r.bbox[1] / h) * 100}%`;
      box.style.width = `${(r.bbox[2] / w) * 100}%`;
      box.style.height = `${(r.bbox[3] / h) * 100}%`;
      box.title = `${r.type} · ${detectorLabel(r.source)}`;
      box.setAttribute("role", "button");
      box.setAttribute("aria-label", `Inspect redacted ${r.type} region`);
      const desc: RegionDescriptor = { ...r, i: 0 };
      box.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onInspect(desc, box);
      });
      layer!.appendChild(box);
    }
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    img.removeEventListener("load", place);
    img.removeEventListener("error", onError);
    layer?.remove();
  };
  const onError = cleanup;

  img.addEventListener("load", place);
  img.addEventListener("error", onError);
  place();

  return {
    layer,
    destroy: cleanup,
  };
}

/** Audit popover content — the "why redacted" evidence card. */
export function buildAuditCard(region: RegionDescriptor): HTMLElement {
  const card = document.createElement("div");
  card.className = "audit-card";
  const meta = tierMeta(region.tier);

  const head = document.createElement("div");
  head.className = "audit-head";
  const type = document.createElement("b");
  type.className = "audit-type";
  type.textContent = region.type.replace(/_/g, " ").toUpperCase();
  const tier = document.createElement("span");
  tier.className = `audit-tier ${meta.cls}`;
  tier.textContent = meta.label;
  head.append(type, tier);

  const rows = document.createElement("dl");
  rows.className = "audit-rows";

  const row = (k: string, v: string, mono = false) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    if (mono) dd.className = "mono";
    dd.textContent = v;
    rows.append(dt, dd);
  };

  row("Detector", detectorLabel(region.source));
  if (region.masked) row("Value", region.masked, true);
  if (region.token) row("Stable token", region.token, true);
  const dims = `${Math.round(region.bbox[2])} × ${Math.round(region.bbox[3])} px`;
  row("Region", dims);

  card.append(head, rows);
  return card;
}