// Set-of-Marks overlay (build plan §1c).
// Draws numbered colored tags on the screenshot canvas so the VLM can
// reference element IDs visually. Tags are compact circles positioned at
// each element's bbox top-left, color-coded by role.

import type { DomElement } from "./protocol";

const TAG_R = 8;
const TAG_D = TAG_R * 2;
const PAD = 3;

const ROLE_COLORS: Record<string, string> = {
  link: "#3b82f6",
  button: "#22c55e",
  text: "#a855f7",
  email: "#f97316",
  phone: "#f97316",
  password: "#ef4444",
  submit: "#22c55e",
  reset: "#ef4444",
  combobox: "#06b6d4",
  textbox: "#06b6d4",
  checkbox: "#eab308",
  radio: "#eab308",
  image: "#ec4899",
  heading: "#8b5cf6",
};

const DEFAULT_COLOR = "#64748b";

function colorFor(role: string): string {
  const lower = role.toLowerCase();
  if (ROLE_COLORS[lower]) return ROLE_COLORS[lower];
  for (const [key, color] of Object.entries(ROLE_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return DEFAULT_COLOR;
}

function drawTag(
  ctx: CanvasRenderingContext2D,
  id: number,
  x: number,
  y: number,
  color: string,
  canvasW: number,
  canvasH: number,
) {
  const label = String(id);

  // Clamp so the tag stays fully on-screen
  const tx = Math.max(TAG_R + 1, Math.min(x, canvasW - TAG_R - 1));
  const ty = Math.max(TAG_R + 1, Math.min(y, canvasH - TAG_R - 1));

  ctx.save();
  ctx.font = "bold 9px monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  const textW = ctx.measureText(label).width;
  const pillW = Math.max(TAG_D, textW + 6);

  // Rounded-rect background pill
  const px = tx - pillW / 2;
  const py = ty - TAG_R;
  const r = 4;
  ctx.beginPath();
  ctx.moveTo(px + r, py);
  ctx.lineTo(px + pillW - r, py);
  ctx.quadraticCurveTo(px + pillW, py, px + pillW, py + r);
  ctx.lineTo(px + pillW, py + TAG_D - r);
  ctx.quadraticCurveTo(px + pillW, py + TAG_D, px + pillW - r, py + TAG_D);
  ctx.lineTo(px + r, py + TAG_D);
  ctx.quadraticCurveTo(px, py + TAG_D, px, py + TAG_D - r);
  ctx.lineTo(px, py + r);
  ctx.quadraticCurveTo(px, py, px + r, py);
  ctx.closePath();

  ctx.fillStyle = color;
  ctx.fill();

  // Subtle outline for contrast on dark screenshots
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 0.75;
  ctx.stroke();

  // Number text
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, tx, ty + 0.5);

  ctx.restore();
}

/**
 * Draw SoM tags onto an existing canvas context. Call AFTER PII redaction
 * so tags are visible on top of the sanitized image.
 */
export function drawSoMOverlay(
  ctx: CanvasRenderingContext2D,
  dom: DomElement[],
  canvasW: number,
  canvasH: number,
) {
  for (const el of dom) {
    const [bx, by] = el.bbox;
    const color = colorFor(el.role);
    // Tag sits at the top-left corner of the element bbox, offset outward
    // so it doesn't overlap the element itself.
    drawTag(ctx, el.id, bx - TAG_R - 2, by - TAG_R - 2, color, canvasW, canvasH);
  }
}
