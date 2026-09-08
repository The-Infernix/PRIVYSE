"""
SIH 26171 — PRIVYSE Presentation Generator
Dark theme, gradient-style backgrounds, bold accent colors.
"""

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
import math

# ── Theme colors ──────────────────────────────────────────────
BG_DARK      = RGBColor(0x0B, 0x0E, 0x17)   # Deep navy
BG_CARD      = RGBColor(0x12, 0x17, 0x25)   # Slightly lighter card
ACCENT_BLUE  = RGBColor(0x00, 0xB4, 0xD8)   # Electric cyan
ACCENT_GREEN = RGBColor(0x00, 0xE6, 0x76)   # Neon green
ACCENT_PURPLE= RGBColor(0x7C, 0x3A, 0xED)   # Vivid purple
ACCENT_ORANGE= RGBColor(0xFF, 0x6B, 0x35)   # Warm orange
ACCENT_RED   = RGBColor(0xEF, 0x44, 0x44)   # Alert red
WHITE        = RGBColor(0xFF, 0xFF, 0xFF)
GRAY_LIGHT   = RGBColor(0xA0, 0xAE, 0xC0)
GRAY_MID     = RGBColor(0x60, 0x6B, 0x80)
YELLOW       = RGBColor(0xFF, 0xD6, 0x00)

prs = Presentation()
prs.slide_width  = Inches(13.333)
prs.slide_height = Inches(7.5)
W = prs.slide_width
H = prs.slide_height


# ── Helpers ───────────────────────────────────────────────────
def add_bg(slide, color=BG_DARK):
    bg = slide.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = color

def add_rect(slide, left, top, width, height, fill_color, border_color=None, border_width=Pt(0)):
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_color
    if border_color:
        shape.line.color.rgb = border_color
        shape.line.width = border_width
    else:
        shape.line.fill.background()
    # Smaller corner radius
    shape.adjustments[0] = 0.05
    return shape

def add_circle(slide, left, top, size, fill_color, border_color=None):
    shape = slide.shapes.add_shape(MSO_SHAPE.OVAL, left, top, size, size)
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_color
    if border_color:
        shape.line.color.rgb = border_color
        shape.line.width = Pt(2)
    else:
        shape.line.fill.background()
    return shape

def add_text(slide, text, left, top, width, height, font_size=18, color=WHITE,
             bold=False, alignment=PP_ALIGN.LEFT, font_name="Segoe UI"):
    txBox = slide.shapes.add_textbox(left, top, width, height)
    tf = txBox.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = text
    p.font.size = Pt(font_size)
    p.font.color.rgb = color
    p.font.bold = bold
    p.font.name = font_name
    p.alignment = alignment
    return txBox

def add_multiline(slide, lines, left, top, width, height, font_size=16, color=WHITE,
                  line_spacing=1.5, bold=False):
    txBox = slide.shapes.add_textbox(left, top, width, height)
    tf = txBox.text_frame
    tf.word_wrap = True
    for i, line in enumerate(lines):
        if i == 0:
            p = tf.paragraphs[0]
        else:
            p = tf.add_paragraph()
        p.text = line
        p.font.size = Pt(font_size)
        p.font.color.rgb = color
        p.font.bold = bold
        p.font.name = "Segoe UI"
        p.space_after = Pt(font_size * (line_spacing - 1))
    return txBox

def add_bullet_list(slide, items, left, top, width, height, font_size=16, color=WHITE, bullet_color=ACCENT_BLUE):
    txBox = slide.shapes.add_textbox(left, top, width, height)
    tf = txBox.text_frame
    tf.word_wrap = True
    for i, item in enumerate(items):
        if i == 0:
            p = tf.paragraphs[0]
        else:
            p = tf.add_paragraph()
        p.text = item
        p.font.size = Pt(font_size)
        p.font.color.rgb = color
        p.font.name = "Segoe UI"
        p.space_after = Pt(8)
        p.level = 0
        # Manual bullet via prefix
        p.text = "▸  " + item
    return txBox

def add_accent_line(slide, left, top, width, color=ACCENT_BLUE, thickness=Pt(3)):
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, thickness)
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    shape.line.fill.background()
    return shape

def add_metric_card(slide, left, top, width, height, value, label, accent=ACCENT_BLUE):
    card = add_rect(slide, left, top, width, height, BG_CARD, accent, Pt(2))
    add_text(slide, value, left + Inches(0.3), top + Inches(0.3), width - Inches(0.6), Inches(0.8),
             font_size=32, color=accent, bold=True)
    add_text(slide, label, left + Inches(0.3), top + Inches(1.0), width - Inches(0.6), Inches(0.5),
             font_size=13, color=GRAY_LIGHT)


# ══════════════════════════════════════════════════════════════
# SLIDE 1 — Title
# ══════════════════════════════════════════════════════════════
slide = prs.slides.add_slide(prs.slide_layouts[6])  # Blank
add_bg(slide)

# Decorative circles
add_circle(slide, Inches(-1.5), Inches(-1.5), Inches(5), RGBColor(0x00, 0x15, 0x30))
add_circle(slide, Inches(10), Inches(4), Inches(5), RGBColor(0x10, 0x08, 0x30))

# Accent bar
add_rect(slide, Inches(1.5), Inches(1.8), Inches(0.08), Inches(2.5), ACCENT_BLUE)

# Title
add_text(slide, "PRIVYSE", Inches(2.0), Inches(1.8), Inches(9), Inches(1.2),
         font_size=56, color=WHITE, bold=True)
add_text(slide, "On-device Visual Perception for\nLight-weight Browser Agents",
         Inches(2.0), Inches(3.0), Inches(9), Inches(1.5),
         font_size=24, color=GRAY_LIGHT)

# Tags
add_accent_line(slide, Inches(2.0), Inches(4.8), Inches(3), ACCENT_BLUE)

# SIH badge
add_rect(slide, Inches(2.0), Inches(5.3), Inches(3.5), Inches(0.5), BG_CARD, ACCENT_BLUE, Pt(1))
add_text(slide, "SIH 2026  ·  Research Track  ·  Problem #26171",
         Inches(2.1), Inches(5.32), Inches(3.4), Inches(0.45),
         font_size=11, color=ACCENT_BLUE, bold=True)

add_text(slide, "Privacy-Preserving Browser Automation",
         Inches(2.0), Inches(6.1), Inches(8), Inches(0.5),
         font_size=16, color=GRAY_MID)


# ══════════════════════════════════════════════════════════════
# SLIDE 2 — The Problem
# ══════════════════════════════════════════════════════════════
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_bg(slide)

add_text(slide, "THE PROBLEM", Inches(0.8), Inches(0.5), Inches(5), Inches(0.6),
         font_size=14, color=ACCENT_BLUE, bold=True)
add_text(slide, "Browser Agents Leak Everything",
         Inches(0.8), Inches(1.0), Inches(10), Inches(0.8),
         font_size=36, color=WHITE, bold=True)
add_accent_line(slide, Inches(0.8), Inches(1.85), Inches(2.5), ACCENT_RED)

# Problem cards
problems = [
    ("Cloud Agents Send\nRaw Screenshots", "Every form fill, Aadhaar number,\nand bank detail is visible to\nthe cloud provider.", ACCENT_RED, "📤"),
    ("Local Agents Have\nNo Redaction", "The VLM runs locally but\nraw unsanitized screenshots\nare sent to it.", ACCENT_ORANGE, "🔓"),
    ("No Ground-Truth\nEvaluation", "Existing agents lack\nreproducible PII detection\nbenchmarks.", YELLOW, "📊"),
]

for i, (title, desc, accent, icon) in enumerate(problems):
    x = Inches(0.8 + i * 4.0)
    y = Inches(2.8)
    card = add_rect(slide, x, y, Inches(3.6), Inches(3.5), BG_CARD, accent, Pt(1.5))
    add_text(slide, icon, x + Inches(0.4), y + Inches(0.3), Inches(1), Inches(0.7),
             font_size=36, color=accent)
    add_text(slide, title, x + Inches(0.4), y + Inches(1.1), Inches(2.8), Inches(1.0),
             font_size=20, color=WHITE, bold=True)
    add_text(slide, desc, x + Inches(0.4), y + Inches(2.2), Inches(2.8), Inches(1.2),
             font_size=13, color=GRAY_LIGHT)


# ══════════════════════════════════════════════════════════════
# SLIDE 3 — Our Solution
# ══════════════════════════════════════════════════════════════
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_bg(slide)

add_text(slide, "OUR SOLUTION", Inches(0.8), Inches(0.5), Inches(5), Inches(0.6),
         font_size=14, color=ACCENT_GREEN, bold=True)
add_text(slide, "Sanitize Before You Send",
         Inches(0.8), Inches(1.0), Inches(10), Inches(0.8),
         font_size=36, color=WHITE, bold=True)
add_accent_line(slide, Inches(0.8), Inches(1.85), Inches(2.5), ACCENT_GREEN)

# Three pillars
pillars = [
    ("ON-DEVICE\nREDACTION", "PII detected & redacted\non the user's own machine\nbefore anything leaves.", "01", ACCENT_BLUE),
    ("LOCAL VLM\nPROCESSING", "Qwen2.5-VL runs via Ollama\nlocally — zero cloud\ndependency.", "02", ACCENT_GREEN),
    ("ZERO-LEAK\nGUARANTEE", "Two fail-closed gates:\nDOM regex + OCR of\nsanitized pixels.", "03", ACCENT_PURPLE),
]

for i, (title, desc, num, accent) in enumerate(pillars):
    x = Inches(0.8 + i * 4.0)
    y = Inches(2.8)
    card = add_rect(slide, x, y, Inches(3.6), Inches(3.8), BG_CARD, accent, Pt(1.5))
    # Number circle
    circle = add_circle(slide, x + Inches(0.3), y + Inches(0.4), Inches(0.7), accent)
    add_text(slide, num, x + Inches(0.3), y + Inches(0.45), Inches(0.7), Inches(0.6),
             font_size=24, color=BG_DARK, bold=True, alignment=PP_ALIGN.CENTER)
    # Title
    add_text(slide, title, x + Inches(0.3), y + Inches(1.4), Inches(3.0), Inches(1.0),
             font_size=18, color=WHITE, bold=True)
    add_text(slide, desc, x + Inches(0.3), y + Inches(2.5), Inches(3.0), Inches(1.2),
             font_size=13, color=GRAY_LIGHT)


# ══════════════════════════════════════════════════════════════
# SLIDE 4 — Architecture Flow
# ══════════════════════════════════════════════════════════════
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_bg(slide)

add_text(slide, "ARCHITECTURE", Inches(0.8), Inches(0.5), Inches(5), Inches(0.6),
         font_size=14, color=ACCENT_BLUE, bold=True)
add_text(slide, "How It Works — End-to-End Flow",
         Inches(0.8), Inches(1.0), Inches(10), Inches(0.8),
         font_size=32, color=WHITE, bold=True)
add_accent_line(slide, Inches(0.8), Inches(1.8), Inches(2.5), ACCENT_BLUE)

# Flow boxes — left to right
flow_steps = [
    ("CAPTURE", "Screenshot +\nDOM Snapshot", ACCENT_BLUE),
    ("SANITIZE", "3-Tier PII\nRedaction", ACCENT_GREEN),
    ("ZERO-LEAK", "DOM Regex +\nOCR Gate", ACCENT_PURPLE),
    ("VLM", "Local Qwen2.5-VL\nvia Ollama", ACCENT_ORANGE),
    ("EXECUTE", "Action in\nBrowser Tab", YELLOW),
]

box_w = Inches(2.1)
box_h = Inches(1.6)
start_x = Inches(0.5)
y_top = Inches(2.8)

for i, (title, desc, accent) in enumerate(flow_steps):
    x = start_x + Inches(i * 2.5)
    card = add_rect(slide, x, y_top, box_w, box_h, BG_CARD, accent, Pt(2))
    add_text(slide, title, x + Inches(0.15), y_top + Inches(0.15), box_w - Inches(0.3), Inches(0.5),
             font_size=16, color=accent, bold=True, alignment=PP_ALIGN.CENTER)
    add_text(slide, desc, x + Inches(0.15), y_top + Inches(0.7), box_w - Inches(0.3), Inches(0.8),
             font_size=12, color=GRAY_LIGHT, alignment=PP_ALIGN.CENTER)

    # Arrow between boxes
    if i < len(flow_steps) - 1:
        arrow_x = x + box_w + Inches(0.05)
        add_text(slide, "→", arrow_x, y_top + Inches(0.5), Inches(0.35), Inches(0.5),
                 font_size=24, color=GRAY_MID, bold=True, alignment=PP_ALIGN.CENTER)

# Loop arrow
add_text(slide, "↻  Loop repeats until task is done", Inches(2.5), Inches(4.7), Inches(8), Inches(0.5),
         font_size=14, color=GRAY_MID, alignment=PP_ALIGN.CENTER)

# Bottom details
details = [
    ("Chrome Extension", "WXT + TypeScript\nMV3 · Offscreen Vision\n~21.4 MB bundled", ACCENT_BLUE),
    ("FastAPI Server", "Python · /act · /rethink\nSSE streaming\nModel routing 3B/7B", ACCENT_GREEN),
    ("Local VLM", "Qwen2.5-VL 3B/7B\nOllama · keep_alive\n4GB GPU capable", ACCENT_PURPLE),
]

for i, (title, desc, accent) in enumerate(details):
    x = Inches(0.8 + i * 4.0)
    y = Inches(5.5)
    card = add_rect(slide, x, y, Inches(3.6), Inches(1.5), BG_CARD, accent, Pt(1))
    add_text(slide, title, x + Inches(0.3), y + Inches(0.15), Inches(3.0), Inches(0.4),
             font_size=14, color=accent, bold=True)
    add_text(slide, desc, x + Inches(0.3), y + Inches(0.55), Inches(3.0), Inches(0.9),
             font_size=11, color=GRAY_LIGHT)


# ══════════════════════════════════════════════════════════════
# SLIDE 5 — Three-Tier Redaction
# ══════════════════════════════════════════════════════════════
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_bg(slide)

add_text(slide, "PRIVACY ENGINE", Inches(0.8), Inches(0.5), Inches(5), Inches(0.6),
         font_size=14, color=ACCENT_PURPLE, bold=True)
add_text(slide, "Three-Tier On-Device Redaction",
         Inches(0.8), Inches(1.0), Inches(10), Inches(0.8),
         font_size=36, color=WHITE, bold=True)
add_accent_line(slide, Inches(0.8), Inches(1.85), Inches(2.5), ACCENT_PURPLE)

tiers = [
    ("TIER A", "Passwords & Secrets",
     ["• Passwords, CVV, OTP, PINs",
      "• API keys, tokens, secrets",
      "• Solid black box — no text, no token",
      "• Never useful to VLM, always sensitive"],
     ACCENT_RED),
    ("TIER B", "Regex-Detectable PII",
     ["• Email → [EMAIL_1], Phone → [PHONE_1]",
      "• Aadhaar → [AADHAAR_1], PAN → [PAN_1]",
      "• Credit Card → [CARD_1] (Luhn-validated)",
      "• Same value → same token (VLM continuity)"],
     ACCENT_ORANGE),
    ("TIER C", "Vision-Based Redaction",
     ["• Faces → MediaPipe BlazeFace → blur",
      "• Canvas/image PII → Tesseract OCR",
      "• Whole-region taint policy",
      "• Crushed-blur: irreversible face destruction"],
     ACCENT_PURPLE),
]

for i, (tier, title, items, accent) in enumerate(tiers):
    x = Inches(0.8 + i * 4.0)
    y = Inches(2.5)
    card = add_rect(slide, x, y, Inches(3.6), Inches(4.5), BG_CARD, accent, Pt(1.5))
    # Tier badge
    add_rect(slide, x + Inches(0.3), y + Inches(0.3), Inches(1.2), Inches(0.4), accent)
    add_text(slide, tier, x + Inches(0.3), y + Inches(0.32), Inches(1.2), Inches(0.35),
             font_size=12, color=BG_DARK, bold=True, alignment=PP_ALIGN.CENTER)
    add_text(slide, title, x + Inches(0.3), y + Inches(0.9), Inches(3.0), Inches(0.5),
             font_size=18, color=WHITE, bold=True)
    add_bullet_list(slide, items, x + Inches(0.3), y + Inches(1.6), Inches(3.0), Inches(2.5),
                    font_size=12, color=GRAY_LIGHT)


# ══════════════════════════════════════════════════════════════
# SLIDE 6 — Key Results
# ══════════════════════════════════════════════════════════════
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_bg(slide)

add_text(slide, "MEASURED RESULTS", Inches(0.8), Inches(0.5), Inches(5), Inches(0.6),
         font_size=14, color=ACCENT_GREEN, bold=True)
add_text(slide, "Performance That Speaks",
         Inches(0.8), Inches(1.0), Inches(10), Inches(0.8),
         font_size=36, color=WHITE, bold=True)
add_accent_line(slide, Inches(0.8), Inches(1.85), Inches(2.5), ACCENT_GREEN)

# Top row — 4 big metrics
metrics_top = [
    ("0.979", "PII Detection F1", ACCENT_BLUE),
    ("0.959", "Redaction Precision", ACCENT_GREEN),
    ("3/3", "Tasks Completed", ACCENT_PURPLE),
    ("PASS", "Zero-Leak Gate", ACCENT_ORANGE),
]

for i, (val, label, accent) in enumerate(metrics_top):
    x = Inches(0.6 + i * 3.1)
    y = Inches(2.5)
    add_metric_card(slide, x, y, Inches(2.8), Inches(1.7), val, label, accent)

# Bottom row
metrics_bottom = [
    ("100%", "Recall (0 missed PII)", ACCENT_GREEN),
    ("1.0", "Face Detection F1", ACCENT_BLUE),
    ("12.7s", "Avg Step Latency (routed)", ACCENT_ORANGE),
    ("21.4 MB", "Total On-Device Assets", ACCENT_PURPLE),
]

for i, (val, label, accent) in enumerate(metrics_bottom):
    x = Inches(0.6 + i * 3.1)
    y = Inches(4.6)
    add_metric_card(slide, x, y, Inches(2.8), Inches(1.7), val, label, accent)


# ══════════════════════════════════════════════════════════════
# SLIDE 7 — Benchmark Breakdown
# ══════════════════════════════════════════════════════════════
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_bg(slide)

add_text(slide, "BENCHMARKS", Inches(0.8), Inches(0.5), Inches(5), Inches(0.6),
         font_size=14, color=ACCENT_BLUE, bold=True)
add_text(slide, "Automated, Reproducible, Scoring-Aligned",
         Inches(0.8), Inches(1.0), Inches(10), Inches(0.8),
         font_size=32, color=WHITE, bold=True)
add_accent_line(slide, Inches(0.8), Inches(1.8), Inches(2.5), ACCENT_BLUE)

# Table header
table_data = [
    ("Scoring Criterion", "Weight", "Our Result", ""),
    ("Visual-context accuracy", "25%", "3/3 tasks (100%)", ACCENT_GREEN),
    ("PII detection recall & precision", "20%", "F1 = 0.979", ACCENT_GREEN),
    ("Redaction precision", "20%", "0.959 pixel-level", ACCENT_GREEN),
    ("Client resource utilization", "20%", "2.2 MB weights, 21.4 MB total", ACCENT_GREEN),
    ("End-to-end latency", "15%", "~12.7 s/step (routed 3B/7B)", ACCENT_ORANGE),
]

# Draw as cards instead of a table
for i, (col1, col2, col3, *rest) in enumerate(table_data):
    accent = rest[0] if rest else ACCENT_BLUE
    y = Inches(2.4 + i * 0.75)
    if i == 0:
        # Header row
        add_rect(slide, Inches(0.8), y, Inches(11.5), Inches(0.65), RGBColor(0x1A, 0x20, 0x35))
        add_text(slide, col1, Inches(1.0), y + Inches(0.1), Inches(4.5), Inches(0.45),
                 font_size=13, color=GRAY_MID, bold=True)
        add_text(slide, col2, Inches(5.5), y + Inches(0.1), Inches(1.5), Inches(0.45),
                 font_size=13, color=GRAY_MID, bold=True, alignment=PP_ALIGN.CENTER)
        add_text(slide, col3, Inches(7.5), y + Inches(0.1), Inches(4.5), Inches(0.45),
                 font_size=13, color=GRAY_MID, bold=True)
    else:
        bg = BG_CARD if i % 2 == 0 else RGBColor(0x0F, 0x14, 0x20)
        add_rect(slide, Inches(0.8), y, Inches(11.5), Inches(0.65), bg)
        add_text(slide, col1, Inches(1.0), y + Inches(0.1), Inches(4.5), Inches(0.45),
                 font_size=14, color=WHITE)
        add_text(slide, col2, Inches(5.5), y + Inches(0.1), Inches(1.5), Inches(0.45),
                 font_size=14, color=GRAY_LIGHT, alignment=PP_ALIGN.CENTER)
        add_text(slide, col3, Inches(7.5), y + Inches(0.1), Inches(4.5), Inches(0.45),
                 font_size=14, color=accent, bold=True)

# Additional metrics
add_text(slide, "Additional Verification", Inches(0.8), Inches(5.2), Inches(5), Inches(0.5),
         font_size=16, color=WHITE, bold=True)

extras = [
    "Face Detection F1 = 1.0  (2/2 faces blurred)",
    "Canvas PII via OCR: Account 2/2, IFSC 1/1  (F1 = 1.0)",
    "Zero-Leak Gate: DOM regex ✓  |  OCR of sanitized pixels ✓",
    "Model Routing: 3B (interactive) → 7B (read/report)  =  32% faster, 100% accuracy",
]
add_bullet_list(slide, extras, Inches(0.8), Inches(5.7), Inches(11), Inches(1.5),
                font_size=13, color=GRAY_LIGHT)


# ══════════════════════════════════════════════════════════════
# SLIDE 8 — Tech Stack
# ══════════════════════════════════════════════════════════════
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_bg(slide)

add_text(slide, "TECH STACK", Inches(0.8), Inches(0.5), Inches(5), Inches(0.6),
         font_size=14, color=ACCENT_ORANGE, bold=True)
add_text(slide, "Built for Privacy & Performance",
         Inches(0.8), Inches(1.0), Inches(10), Inches(0.8),
         font_size=36, color=WHITE, bold=True)
add_accent_line(slide, Inches(0.8), Inches(1.85), Inches(2.5), ACCENT_ORANGE)

stack = [
    ("EXTENSION", "WXT · TypeScript\nChrome MV3", "Cross-browser framework\nType-safe action protocol\nOffscreen vision host", ACCENT_BLUE),
    ("VISION", "MediaPipe · Tesseract\nWASM", "BlazeFace face detection\nOCR on image/canvas regions\nAll weights bundled (2.2 MB)", ACCENT_GREEN),
    ("SERVER", "FastAPI · Python\nOllama", "/act · /rethink · SSE streaming\nOpenAI-compatible API\nModel routing 3B ↔ 7B", ACCENT_ORANGE),
    ("VLM", "Qwen2.5-VL\n3B / 7B", "Local inference only\nkeep_alive pinned\n4 GB GPU capable", ACCENT_PURPLE),
]

for i, (title, tech, desc, accent) in enumerate(stack):
    x = Inches(0.5 + i * 3.15)
    y = Inches(2.5)
    card = add_rect(slide, x, y, Inches(2.9), Inches(4.3), BG_CARD, accent, Pt(1.5))
    add_text(slide, title, x + Inches(0.3), y + Inches(0.25), Inches(2.3), Inches(0.4),
             font_size=12, color=accent, bold=True)
    add_text(slide, tech, x + Inches(0.3), y + Inches(0.7), Inches(2.3), Inches(0.8),
             font_size=17, color=WHITE, bold=True)
    add_accent_line(slide, x + Inches(0.3), y + Inches(1.7), Inches(1.5), accent, Pt(1.5))
    add_text(slide, desc, x + Inches(0.3), y + Inches(2.0), Inches(2.3), Inches(2.0),
             font_size=12, color=GRAY_LIGHT)


# ══════════════════════════════════════════════════════════════
# SLIDE 9 — What Makes Us Different
# ══════════════════════════════════════════════════════════════
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_bg(slide)

add_text(slide, "COMPETITIVE EDGE", Inches(0.8), Inches(0.5), Inches(5), Inches(0.6),
         font_size=14, color=ACCENT_PURPLE, bold=True)
add_text(slide, "What No Other Agent Does",
         Inches(0.8), Inches(1.0), Inches(10), Inches(0.8),
         font_size=36, color=WHITE, bold=True)
add_accent_line(slide, Inches(0.8), Inches(1.85), Inches(2.5), ACCENT_PURPLE)

# Comparison table
headers = ["Feature", "Commercial\nAgents", "Open-Source\nLocal Agents", "PRIVYSE"]
rows = [
    ("Raw PII to VLM?", "Yes", "Yes", "No ✓"),
    ("Cloud dependency?", "Yes", "No", "No ✓"),
    ("Runs on 4GB GPU?", "N/A", "No", "Yes ✓"),
    ("PII detection benchmark?", "No", "No", "Yes ✓"),
    ("Zero-leak guarantee?", "No", "No", "Yes ✓"),
    ("Adaptive recovery?", "Limited", "No", "Yes ✓"),
]

col_widths = [Inches(3.0), Inches(2.5), Inches(2.5), Inches(2.5)]
col_x = [Inches(0.8), Inches(3.8), Inches(6.3), Inches(8.8)]

# Header
y_start = Inches(2.5)
for j, (header, cx) in enumerate(zip(headers, col_x)):
    accent = [GRAY_MID, GRAY_MID, GRAY_MID, ACCENT_GREEN][j]
    add_rect(slide, cx, y_start, col_widths[j], Inches(0.6), RGBColor(0x1A, 0x20, 0x35))
    add_text(slide, header, cx + Inches(0.15), y_start + Inches(0.05), col_widths[j] - Inches(0.3), Inches(0.5),
             font_size=12, color=accent, bold=True, alignment=PP_ALIGN.CENTER)

for i, (feat, c1, c2, c3) in enumerate(rows):
    y = y_start + Inches(0.65 + i * 0.6)
    bg = BG_CARD if i % 2 == 0 else RGBColor(0x0F, 0x14, 0x20)
    vals = [feat, c1, c2, c3]
    colors = [WHITE, GRAY_LIGHT, GRAY_LIGHT, ACCENT_GREEN]
    bolds = [True, False, False, True]
    for j, (val, cx) in enumerate(zip(vals, col_x)):
        add_rect(slide, cx, y, col_widths[j], Inches(0.55), bg)
        add_text(slide, val, cx + Inches(0.15), y + Inches(0.08), col_widths[j] - Inches(0.3), Inches(0.4),
                 font_size=13, color=colors[j], bold=bolds[j], alignment=PP_ALIGN.CENTER)

# Bottom callout
add_rect(slide, Inches(1.5), Inches(6.5), Inches(10), Inches(0.6), BG_CARD, ACCENT_GREEN, Pt(1.5))
add_text(slide, "The gap we fill: a privacy-preserving browser agent that is BOTH local AND redacts before the VLM sees anything.",
         Inches(1.8), Inches(6.52), Inches(9.5), Inches(0.5),
         font_size=13, color=ACCENT_GREEN, bold=True, alignment=PP_ALIGN.CENTER)


# ══════════════════════════════════════════════════════════════
# SLIDE 10 — Latency Engineering
# ══════════════════════════════════════════════════════════════
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_bg(slide)

add_text(slide, "LATENCY ENGINEERING", Inches(0.8), Inches(0.5), Inches(5), Inches(0.6),
         font_size=14, color=ACCENT_ORANGE, bold=True)
add_text(slide, "Optimized for Modest Hardware",
         Inches(0.8), Inches(1.0), Inches(10), Inches(0.8),
         font_size=36, color=WHITE, bold=True)
add_accent_line(slide, Inches(0.8), Inches(1.85), Inches(2.5), ACCENT_ORANGE)

# Optimization levers
levers = [
    ("VLM_MAX_TOKENS = 128", "Halved max decode length;\nshort JSON actions need few tokens", "~50% decode savings"),
    ("COMPACT SYSTEM PROMPT", "~60% fewer system tokens;\nidentical behavior, shorter context", "60% token reduction"),
    ("IMAGE_RESIZE = 800px", "Caps longest JPEG dimension;\nreduces vision encoder tokens", "Smaller payload"),
    ("keep_alive = -1", "Pins model in VRAM between steps;\navoids 20–60s cold-load", "Zero cold-start"),
    ("3B/7B ROUTING", "Interactive → fast 3B model;\nread/report → accurate 7B model", "32% faster, 100% acc"),
]

for i, (lever, desc, effect) in enumerate(levers):
    y = Inches(2.5 + i * 0.95)
    # Lever name
    add_rect(slide, Inches(0.8), y, Inches(3.5), Inches(0.8), BG_CARD, ACCENT_BLUE, Pt(1))
    add_text(slide, lever, Inches(1.0), y + Inches(0.15), Inches(3.1), Inches(0.5),
             font_size=13, color=ACCENT_BLUE, bold=True)
    # Description
    add_text(slide, desc, Inches(4.6), y + Inches(0.05), Inches(5.0), Inches(0.7),
             font_size=12, color=GRAY_LIGHT)
    # Effect badge
    add_rect(slide, Inches(10.0), y + Inches(0.15), Inches(2.5), Inches(0.5), RGBColor(0x0A, 0x2A, 0x0A), ACCENT_GREEN, Pt(1))
    add_text(slide, effect, Inches(10.1), y + Inches(0.18), Inches(2.3), Inches(0.45),
             font_size=11, color=ACCENT_GREEN, bold=True, alignment=PP_ALIGN.CENTER)

# Bottom note
add_rect(slide, Inches(0.8), Inches(6.5), Inches(11.5), Inches(0.6), BG_CARD)
add_text(slide, "Hardware reality: RTX 3050 4GB VRAM → 7B runs 75% CPU / 25% GPU. Sub-5s target needs VRAM ≥ model size (judge-class GPU).",
         Inches(1.0), Inches(6.55), Inches(11.0), Inches(0.5),
         font_size=12, color=GRAY_MID, alignment=PP_ALIGN.CENTER)


# ══════════════════════════════════════════════════════════════
# SLIDE 11 — Zero-Leak Guarantee
# ══════════════════════════════════════════════════════════════
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_bg(slide)

add_text(slide, "ZERO-LEAK GUARANTEE", Inches(0.8), Inches(0.5), Inches(5), Inches(0.6),
         font_size=14, color=ACCENT_RED, bold=True)
add_text(slide, "Defense in Depth — No Soft Fail",
         Inches(0.8), Inches(1.0), Inches(10), Inches(0.8),
         font_size=36, color=WHITE, bold=True)
add_accent_line(slide, Inches(0.8), Inches(1.85), Inches(2.5), ACCENT_RED)

# Defense layers
layers = [
    ("LAYER 1", "Tier A/B/C Redaction", "Regex + field labels + vision", ACCENT_BLUE),
    ("LAYER 2", "Sanitized Screenshot OCR", "Tesseract scans output pixels", ACCENT_GREEN),
    ("LAYER 3", "DOM Regex Gate", "Scans outbound JSON for PII", ACCENT_PURPLE),
    ("LAYER 4", "Image OCR Gate", "OCR of what would actually upload", ACCENT_ORANGE),
    ("LAYER 5", "Fail-Closed Default", "Gate can't run → upload blocked", ACCENT_RED),
]

for i, (layer, title, desc, accent) in enumerate(layers):
    y = Inches(2.4 + i * 0.95)
    # Layer number
    circle = add_circle(slide, Inches(1.0), y + Inches(0.05), Inches(0.7), accent)
    add_text(slide, str(i+1), Inches(1.0), y + Inches(0.1), Inches(0.7), Inches(0.6),
             font_size=20, color=BG_DARK, bold=True, alignment=PP_ALIGN.CENTER)
    # Card
    add_rect(slide, Inches(2.0), y, Inches(9.5), Inches(0.8), BG_CARD, accent, Pt(1))
    add_text(slide, title, Inches(2.3), y + Inches(0.1), Inches(3.5), Inches(0.6),
             font_size=16, color=WHITE, bold=True)
    add_text(slide, desc, Inches(6.0), y + Inches(0.15), Inches(5.0), Inches(0.5),
             font_size=13, color=GRAY_LIGHT)

# Callout
add_rect(slide, Inches(2.0), Inches(6.3), Inches(9.5), Inches(0.7), BG_CARD, ACCENT_RED, Pt(2))
add_text(slide, "A gate that cannot run must not silently approve. Every failure blocks the upload.",
         Inches(2.3), Inches(6.38), Inches(9.0), Inches(0.5),
         font_size=14, color=ACCENT_RED, bold=True, alignment=PP_ALIGN.CENTER)


# ══════════════════════════════════════════════════════════════
# SLIDE 12 — Impact & Vision
# ══════════════════════════════════════════════════════════════
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_bg(slide)

add_text(slide, "IMPACT", Inches(0.8), Inches(0.5), Inches(5), Inches(0.6),
         font_size=14, color=ACCENT_GREEN, bold=True)
add_text(slide, "Why This Matters",
         Inches(0.8), Inches(1.0), Inches(10), Inches(0.8),
         font_size=36, color=WHITE, bold=True)
add_accent_line(slide, Inches(0.8), Inches(1.85), Inches(2.5), ACCENT_GREEN)

impacts = [
    ("PRIVACY", "Raw screenshots never leave the machine.\nPII redacted on-device. No cloud, no\nper-token cost, no data brokers.", ACCENT_RED, "🔒"),
    ("PRODUCTIVITY", "Lightweight, ownable browser agent.\nAutomate form-filling, data entry,\nflow regression — locally.", ACCENT_GREEN, "⚡"),
    ("ACCESSIBILITY", "Works on 4GB GPU. Zero API costs.\nOffline capable. Anyone can run it\nwithout commercial subscriptions.", ACCENT_BLUE, "🌍"),
    ("RESEARCH", "Reproducible benchmarks. Ground-truth\ntest site. Metric-ready for judges.\nDemo-provable architecture.", ACCENT_PURPLE, "🔬"),
]

for i, (title, desc, accent, icon) in enumerate(impacts):
    x = Inches(0.5 + i * 3.15)
    y = Inches(2.6)
    card = add_rect(slide, x, y, Inches(2.9), Inches(4.0), BG_CARD, accent, Pt(1.5))
    add_text(slide, icon, x + Inches(0.3), y + Inches(0.3), Inches(0.6), Inches(0.6),
             font_size=28, color=accent)
    add_text(slide, title, x + Inches(1.0), y + Inches(0.35), Inches(1.8), Inches(0.5),
             font_size=16, color=accent, bold=True)
    add_accent_line(slide, x + Inches(0.3), y + Inches(1.1), Inches(2.3), accent, Pt(1.5))
    add_text(slide, desc, x + Inches(0.3), y + Inches(1.4), Inches(2.3), Inches(2.2),
             font_size=12, color=GRAY_LIGHT)


# ══════════════════════════════════════════════════════════════
# SLIDE 13 — Demo Script
# ══════════════════════════════════════════════════════════════
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_bg(slide)

add_text(slide, "DEMO", Inches(0.8), Inches(0.5), Inches(5), Inches(0.6),
         font_size=14, color=ACCENT_BLUE, bold=True)
add_text(slide, "Live Walkthrough — 3 Minutes",
         Inches(0.8), Inches(1.0), Inches(10), Inches(0.8),
         font_size=36, color=WHITE, bold=True)
add_accent_line(slide, Inches(0.8), Inches(1.85), Inches(2.5), ACCENT_BLUE)

demo_steps = [
    ("STEP 1", "Open test site", "Launch the ground-truth\nflight booking page with\nembedded PII fields.", "30s"),
    ("STEP 2", "Run agent", "Type a task in the side panel.\nAgent captures, sanitizes,\nsends to local VLM.", "60s"),
    ("STEP 3", "Show Network tab", "Proof: only sanitized payloads\nleave the extension.\nNo raw screenshots.", "30s"),
    ("STEP 4", "Show redaction", "Side-by-side: original vs\nsanitized image with\nSoM tags + black boxes.", "30s"),
]

for i, (step, title, desc, time) in enumerate(demo_steps):
    x = Inches(0.5 + i * 3.15)
    y = Inches(2.6)
    card = add_rect(slide, x, y, Inches(2.9), Inches(3.8), BG_CARD, ACCENT_BLUE, Pt(1))
    # Step number
    circle = add_circle(slide, x + Inches(1.1), y + Inches(0.3), Inches(0.7), ACCENT_BLUE)
    add_text(slide, str(i+1), x + Inches(1.1), y + Inches(0.35), Inches(0.7), Inches(0.6),
             font_size=24, color=BG_DARK, bold=True, alignment=PP_ALIGN.CENTER)
    add_text(slide, title, x + Inches(0.3), y + Inches(1.2), Inches(2.3), Inches(0.5),
             font_size=18, color=WHITE, bold=True, alignment=PP_ALIGN.CENTER)
    add_text(slide, desc, x + Inches(0.3), y + Inches(1.8), Inches(2.3), Inches(1.3),
             font_size=12, color=GRAY_LIGHT, alignment=PP_ALIGN.CENTER)
    # Time badge
    add_rect(slide, x + Inches(0.9), y + Inches(3.2), Inches(1.1), Inches(0.4), RGBColor(0x0A, 0x15, 0x2A), ACCENT_BLUE, Pt(1))
    add_text(slide, time, x + Inches(0.9), y + Inches(3.22), Inches(1.1), Inches(0.35),
             font_size=11, color=ACCENT_BLUE, bold=True, alignment=PP_ALIGN.CENTER)

# Key demo points
add_text(slide, "Key talking points during demo:", Inches(0.8), Inches(6.6), Inches(5), Inches(0.4),
         font_size=14, color=WHITE, bold=True)
add_text(slide, "Network tab shows only redacted payloads  ·  Side panel shows live VLM thinking  ·  Face blur visible in real-time",
         Inches(0.8), Inches(7.0), Inches(11), Inches(0.4),
         font_size=12, color=GRAY_MID)


# ══════════════════════════════════════════════════════════════
# SLIDE 14 — Thank You
# ══════════════════════════════════════════════════════════════
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_bg(slide)

# Decorative
add_circle(slide, Inches(4), Inches(0.5), Inches(8), RGBColor(0x08, 0x12, 0x25))

add_text(slide, "Thank You", Inches(2), Inches(2.0), Inches(9), Inches(1.2),
         font_size=56, color=WHITE, bold=True, alignment=PP_ALIGN.CENTER)
add_accent_line(slide, Inches(5.5), Inches(3.3), Inches(2.5), ACCENT_BLUE, Pt(3))
add_text(slide, "PRIVYSE — On-device Visual Perception\nfor Light-weight Browser Agents",
         Inches(2), Inches(3.8), Inches(9), Inches(1.0),
         font_size=20, color=GRAY_LIGHT, alignment=PP_ALIGN.CENTER)

# Social / contact
add_text(slide, "SIH 2026  ·  Research Track  ·  Problem #26171",
         Inches(2), Inches(5.2), Inches(9), Inches(0.5),
         font_size=14, color=GRAY_MID, alignment=PP_ALIGN.CENTER)

add_text(slide, "Questions?", Inches(2), Inches(6.2), Inches(9), Inches(0.6),
         font_size=28, color=ACCENT_BLUE, bold=True, alignment=PP_ALIGN.CENTER)


# ── Speaker notes ─────────────────────────────────────────────
slide_notes = {
    0: (
        "Good morning judges. I'm presenting PRIVYSE.\n\n"
        "One-line intro: 'A privacy-preserving browser agent that redacts your personal data "
        "on your own device BEFORE anything is sent to an AI model.'\n\n"
        "SIH 2026, Research Track, Problem #26171."
    ),
    1: (
        "THE PROBLEM — Browser agents today leak everything.\n\n"
        "• Cloud agents (browser-use, OpenAI Operator, etc.) send raw screenshots to GPT-4V/Claude. "
        "Every Aadhaar number, PAN, card and face on screen goes to a cloud provider.\n"
        "• Local agents without redaction still feed the raw screenshot to the (local) VLM — if the model "
        "compromises or memorises, the PII is exposed.\n"
        "• And almost nobody has a reproducible PII benchmark — judges can't verify claims.\n\n"
        "PAUSE. 'None of these work for a country that runs on Aadhaar and UPI — the stakes are real personal data.'"
    ),
    2: (
        "OUR SOLUTION — 'Sanitize before you send.'\n\n"
        "Three pillars (point to each):\n"
        "• 01 - All PII detected and redacted on-device, single choke-point architecture.\n"
        "• 02 - The VLM runs locally via Ollama — zero cloud, zero token cost, works offline.\n"
        "• 03 - Two independent fail-closed gates guarantee nothing leaks — not even pixels."
    ),
    3: (
        "ARCHITECTURE — walk the loop left to right.\n\n"
        "1. CAPTURE: screenshot + DOM snapshot (shadow-root aware, numbered elements).\n"
        "2. SANITIZE: 3-tier PII redaction happens HERE, on device.\n"
        "3. ZERO-LEAK: DOM regex scan + OCR of the sanitized pixels. Fail-closed.\n"
        "4. VLM: local Qwen2.5-VL returns ONE JSON action.\n"
        "5. EXECUTE: action fires in the tab.\n"
        "↻ Loop repeats till done. Bottom row: 3 implementation layers.\n\n"
        "KEY LINE: 'Only redacted pixels + a numbered DOM ever leave — and in our demo they go to 127.0.0.1.'"
    ),
    4: (
        "PRIVACY ENGINE — the 3-tier redaction.\n\n"
        "• Tier A: passwords/CVV/OTP/PIN — solid black box, no token. Never useful to the VLM.\n"
        "• Tier B: regex PII — email/phone/Aadhaar/PAN/card (Luhn-validated → no false positives). "
        "Same value maps to the SAME token ([EMAIL_1]) so the VLM keeps continuity across steps without seeing the secret.\n"
        "• Tier C: faces via MediaPipe BlazeFace (crushed-blur, irreversible); PII inside images/canvas via Tesseract OCR, "
        "whole-region taint policy — we over-redact rather than leak."
    ),
    5: (
        "RESULTS — the numbers that earn the 80% of the rubric.\n\n"
        "Top row (read deliberately):\n"
        "• PII detection F1 0.979 (recall 1.000 = we caught EVERY ground-truth PII element).\n"
        "• Redaction precision 0.959 — VLM still sees enough context to act.\n"
        "• 3/3 tasks completed at 100% visual-context accuracy.\n"
        "• Zero-leak gate: PASS on both channels.\n\n"
        "Bottom row: 2.2MB weights, 21.4MB total, 12.7s/step on a 4GB GPU.\n\n"
        "ALL numbers regenerate from our automated benchmark harness."
    ),
    6: (
        "BENCHMARKS — mapped exactly to the 5 scoring criteria with weights.\n\n"
        "This is the slide judges audit. Emphasize:\n"
        "• Visual-context accuracy 25% → 3/3 tasks, avg 1.0 step.\n"
        "• PII detection 20% → F1 0.979.\n"
        "• Redaction precision 20% → 0.959 pixel-level on rasterized masks.\n"
        "• Client resources 20% → 2.2MB weights, 0MB off-device fetches.\n"
        "• Latency 15% → 12.7s/step routed; <5s target on judge-class GPU.\n\n"
        "Extra verification bullets: face F1 1.0, canvas OCR F1 1.0, dual zero-leak gates, "
        "routing gives 32% faster while holding 100% accuracy."
    ),
    7: (
        "TECH STACK — four boxes, one line each (don't over-explain).\n\n"
        "• Extension: WXT + TypeScript, Chrome MV3, offscreen vision host.\n"
        "• Vision: MediaPipe BlazeFace + Tesseract WASM, all weights bundled, no CDN.\n"
        "• Server: FastAPI + Ollama, SSE streaming for live 'thinking'.\n"
        "• VLM: Qwen2.5-VL 3B/7B, model pinning (keep_alive), runs on 4GB GPU."
    ),
    8: (
        "COMPETITIVE EDGE — the 'why us' slide.\n\n"
        "Row by row: commercial agents send raw PII to the cloud; open-source local agents still send raw "
        "screenshots to the VLM; PRIVYSE is BOTH local AND redacts before the VLM sees anything.\n\n"
        "Read the bottom callout verbatim: 'The gap we fill — a privacy-preserving browser agent that is BOTH "
        "local AND redacts before the VLM sees anything. No existing agent does this.'"
    ),
    9: (
        "LATENCY ENGINEERING — this is how we hit usable latency on a 4GB laptop GPU.\n\n"
        "Quick walk: token cap 128, compact prompt (−60% system tokens), image resize to 800px, "
        "keep_alive pins the model (no 20–60s cold start), and 3B/7B routing = interactive steps use the fast "
        "3B model, read/report steps use the accurate 7B model.\n"
        "Bottom honesty line: on our dev laptop 7B runs 75% CPU/25% GPU; sub-5s needs VRAM ≥ model size "
        "(judge-class hardware) — routing is the low-memory fallback."
    ),
    10: (
        "ZERO-LEAK GUARANTEE — defense in depth, 5 layers.\n\n"
        "• L1: Tier A/B/C redaction.\n"
        "• L2: OCR of the sanitized screenshot (what would actually upload).\n"
        "• L3: regex scan of the outbound DOM JSON.\n"
        "• L4: pixel-level OCR gate.\n"
        "• L5: fail-closed default — if any gate cannot run, upload is BLOCKED.\n\n"
        "BOTTOM LINE (read verbatim): 'A gate that cannot run must not silently approve. Every failure blocks the upload.'"
    ),
    11: (
        "IMPACT — why this matters beyond the hackathon.\n\n"
        "• Privacy: raw screenshots never leave the machine. No cloud, no data brokers.\n"
        "• Productivity: ownable local automation — forms, data entry, banking flows, offline.\n"
        "• Accessibility: 4GB GPU, zero API cost, offline — anyone can run it.\n"
        "• Research: fully reproducible metrics, GT test site, metric-ready for judges."
    ),
    12: (
        "DEMO — 3 minutes, four beats.\n\n"
        "1. Open the test site (GT-labelled pages with embedded PII).\n"
        "2. Type a task, run the agent — show the loop working.\n"
        "3. Open the Network tab: PROOF only sanitized payloads leave (to 127.0.0.1).\n"
        "4. Side-by-side original vs sanitized: black boxes, [EMAIL_1] tokens, blurred faces, SoM numbers.\n\n"
        "While waiting for VLM: point at live 'thinking' tokens streaming via SSE."
    ),
    13: (
        "CLOSE — thank the judges, restate the one-line pitch.\n\n"
        "'PRIVYSE: on-device redaction + local VLM + zero-leak gates — the only browser agent that never "
        "lets your Aadhaar, PAN or face leave your machine. Open to questions.'\n\n"
        "Be ready for: 'Why not just use a cloud agent?' → data sovereignty. "
        "'How do you prove zero-leak?' → Network tab + fail-closed gate. "
        "'Can it run here?' → yes, 4GB GPU, all local."
    ),
}

for idx, notes in slide_notes.items():
    prs.slides[idx].notes_slide.notes_text_frame.text = notes
    prs.slides[idx].notes_slide.notes_text_frame.paragraphs[0].font.size = Pt(12)

# ── Save ──────────────────────────────────────────────────────
output_path = r"C:\SIH\26171\PRIVYSE_SIH26171_Presentation.pptx"
prs.save(output_path)
print(f"Presentation saved to: {output_path}")
print(f"Total slides: {len(prs.slides)}")
