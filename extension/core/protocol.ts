// SIH 26171 — shared protocol (frozen at v1 per build plan §1d).
// The same action shapes are used by: extension background, content script,
// and the FastAPI server. Any change must bump PROTOCOL_VERSION.

export const PROTOCOL_VERSION = 2;

/** Live agent phase, surfaced as the header status + pipeline strip. */
export type AgentStage =
  | "ready"
  | "capturing"
  | "sanitizing"
  | "verifying"
  | "reasoning"
  | "acting"
  | "done";

// ---------------------------------------------------------------------------
// Action protocol — the only thing the server may ask the client to do.
// ---------------------------------------------------------------------------

export type AgentAction =
  | { type: "click"; target: number }
  | { type: "type"; target: number; text: string }
  | { type: "press"; key: string }
  | { type: "scroll"; direction: "up" | "down"; amount?: number }
  | { type: "navigate"; url: string }
  | { type: "wait"; ms: number }
  | { type: "extract"; text: string }
  | { type: "done"; answer?: string }
  // Human-in-the-loop: the VLM pauses the loop and asks the user a realtime
  // question (decision, validation, preference). NEVER dispatched to the
  // content script — the background intercepts it, surfaces it in the side
  // panel + page banner, and feeds the answer back into the VLM context.
  | { type: "ask"; question: string; options?: string[] };

// ---------------------------------------------------------------------------
// On-device screen perception (PS §1: "local ViT reads the screen")
// ---------------------------------------------------------------------------

export type PerceptionTag =
  | "photo" // photographic / illustrative (identity imagery)
  | "ui" // another screen inside the page
  | "document" // printed / wallet / doc-like
  | "data" // meter / clock / scoreboard
  | "blank" // text / whitespace heavy
  | "uncertain"; // low-confidence graphic

export interface PerceptionTile {
  x: number;
  y: number;
  w: number;
  h: number;
  tag: PerceptionTag;
  cls: number;
  label: string;
  conf: number;
}

export interface PerceptionRegionDecision {
  region: [number, number, number, number];
  tags: PerceptionTag[];
  reason: string;
}

/**
 * On-device MobileViT screen perception — produced in the browser by the local
 * ViT before anything leaves the device. Shipped as a compact semantic map to
 * the server so the VLM reasons from locally-observed structure (improves
 * visual-context accuracy without sending redacted pixels).
 */
export interface ScreenPerception {
  version: 1;
  model: string;
  enabled: boolean;
  tiles: PerceptionTile[];
  summary: Partial<Record<PerceptionTag, number>>;
  decisions: {
    escalate: PerceptionRegionDecision[];
    ocrPriority: PerceptionRegionDecision[];
    captchaLike: PerceptionRegionDecision[];
  };
  ms: number;
  modelMB: number;
}

// ---------------------------------------------------------------------------
// DOM snapshot — produced by the content-script serializer (Phase 1).
// bbox is [x, y, w, h] in CAPTURED SCREENSHOT pixel space (CSS px × devicePixelRatio).
// ---------------------------------------------------------------------------

export interface DomElement {
  id: number;
  tag: string;
  role: string;
  /** Visible text, truncated to 80 chars, PII already tokenized (Phase 1). */
  text: string;
  /** Resolved via <label for>, aria-label, placeholder, autocomplete. */
  label: string;
  bbox: [number, number, number, number];
  /** Present only for input elements; sensitive values are tokenized. */
  value?: string;
}

// ---------------------------------------------------------------------------
// Redaction log view — device-local audit metadata for the side-panel
// "Forensic Exhibit". Mirrors core/sanitizer.ts RedactionLogEntry but carries
// only the masked form (never the raw value) and stays inside the panel.
// ---------------------------------------------------------------------------

export interface RedactionView {
  type: string;
  tier: "A" | "B" | "C";
  token?: string;
  /** [x, y, w, h] in captured-screenshot pixel space. */
  bbox: [number, number, number, number];
  /** Which detector produced it: dom · text · vision (face/OCR) · perception. */
  source: "dom" | "text" | "vision" | "perception";
  /** Partially-masked display of the raw value (ON-DEVICE only). */
  masked?: string;
}

export interface HistoryStep {
  action: AgentAction;
  result: string;
  /** The model's stated sub-goal for this step (kept in history so the agent
   * stays on track and can be reminded of its plan across steps). */
  subgoal?: string;
  /** True when this step was blocked — triggers the recovery/rethink path. */
  blocked?: boolean;
}

// ---------------------------------------------------------------------------
// Server contract: POST /act
// ---------------------------------------------------------------------------

export interface ServerActRequest {
  task: string;
  /** Last K steps only (bounded for latency). */
  history: HistoryStep[];
  /** Base64, ALREADY SANITIZED — sanitizer gate is the only producer. */
  screenshot_b64: string;
  /** MIME type of the sanitized screenshot (e.g. "image/webp", "image/jpeg"). */
  imageMime?: string;
  /** Set-of-Marks annotated element registry, tokenized. */
  dom: DomElement[];
  /** Optional VLM model override (e.g. "qwen2.5vl:3b"). */
  model?: string;
  /** Learned lessons from previous runs on this site (verified only). */
  lessons?: string[];
  /** Persistent within-run memory: actions already tried that failed or were
   * repeated without progress. Injected into the prompt so the model never
   * re-fires them. */
  warnings?: string[];
  /** Deterministic element findings the executor verified (e.g. the real
   * <input> it auto-descended into from a non-typeable wrapper). Injected as
   * "DETECTED ELEMENT — use verbatim" so the VLM targets the known-good
   * element instead of re-guessing. (Borrowed from clicky-windows.) */
  verifiedTargets?: VerifiedTarget[];
  /** Compact on-device semantic map computed by the local MobileViT before
   * upload. The server is aware of the redaction scheme AND the local vision. */
  screenPerception?: ScreenPerception;
}

/** A {"target": id} override the executor confirmed works. */
export interface VerifiedTarget {
  id: number;
  desc: string;
}

export interface ServerActResponse {
  thought: string;
  action: AgentAction;
  done: boolean;
  /** The model's stated sub-goal for this step. */
  subgoal?: string;
  /** True when this step was blocked and a change of approach is needed. */
  blocked?: boolean;
  /** The model that actually answered (perception-driven routing echoes it). */
  model_used?: string;
}

// ---------------------------------------------------------------------------
// Internal extension messages
// ---------------------------------------------------------------------------

export type ExtMessage =
  | { type: "run-step"; task: string }
  | { type: "start-loop"; task: string }
  | { type: "stop-loop" }
  | { type: "serialize-dom" }
  | { type: "cursor-hide" }
  | { type: "cursor-show" }
  | { type: "cursor-toggle"; enabled: boolean }
  | {
      type: "agent-log";
      level: "info" | "error" | "success";
      text: string;
      /** Optional data-URL thumbnail of the capture. */
      screenshot?: string;
    }
  | {
      type: "loop-status";
      running: boolean;
      step: number;
      maxSteps: number;
    }
  | { type: "spotlight" }
  | { type: "open-panel" }
  // VLM "thinking" stream → side panel live readout
  | { type: "think-start" }
  | { type: "think-delta"; text: string }
  | { type: "think-end"; thought: string }
  // Live agent phase (header status + pipeline strip)
  | { type: "agent-stage"; stage: AgentStage; text?: string }
  // Privacy gate summary for the hero card (device-local, judged-friendly)
  | {
      type: "privacy";
      detected: number;
      redacted: number;
      faces: number;
      facesBlurred: number;
      /** true = gate passed, null = image gate not run this step, false = blocked */
      zeroLeak: boolean | null;
      /** Human-facing gate verdict. */
      gate: "pass" | "block" | "skip";
      /** Always 0 while assertNoLeaks is the hard gate. */
      rawValuesSent: number;
      byType: { type: string; count: number }[];
      /** Stable-token map: masked raw value → [TOKEN_n] (device-local, never sent). */
      tokens: { type: string; masked: string; token: string }[];
      /** Per-region audit log for the interactive exhibit (device-local only). */
      redactions: RedactionView[];
      /** On-device ViT screen-perception summary (tile tags + escalations). */
      perception?: {
        enabled: boolean;
        ms: number;
        summary: Partial<Record<PerceptionTag, number>>;
        escalate: number;
        /** Execution provider running the ViT ("webgpu" when the GPU was used). */
        backend?: "webgpu" | "wasm" | "none";
      };
    }
  // Structured decision trace (index-card version of the raw reasoning)
  | {
      type: "decision";
      observed: number;
      protected: number;
      subgoal?: string;
      thought: string;
      action: string;
      target?: { id: number; desc: string };
    }
  // Post-execution result for the decision card's Result row
  | { type: "decision-result"; result: string }
  // Before/after proof for the "What the AI sees" card. The ORIGINAL capture
  // is shown only on-device (this panel) — nothing outbound changed.
  | {
      type: "capture-preview";
      original: string;
      sanitized: string;
      payloadKb: number;
      protected: number;
    }
  // Human-in-the-loop: the agent paused the loop to ask the user a realtime
  // question. The side panel card AND the page banner both consume this.
  | {
      type: "ask-user";
      question: string;
      options: string[];
      /** "decide" = VLM-driven question, "confirm" = safety gate (Proceed/Cancel). */
      kind: "decide" | "confirm";
      /** True when sent as a runtime broadcast intended ONLY for the side panel;
       * content scripts must ignore these (the banner gets its own targeted
       * tabs.sendMessage so it never appears on every tab). */
      viaPanel?: boolean;
    }
  // User answered the pending ask (panel/banner → background).
  | { type: "ask-answer"; answer: string }
  // User skipped the pending ask (panel/banner → background).
  | { type: "ask-skip" }
  // Background → content: the pending question was resolved elsewhere (user
  // answered in the side panel, stopped the loop, or the safety-net timer
  // fired). Dismisses the in-page banner if it is still showing.
  | { type: "ask-hide" };

/** background → content script */
export interface ExecuteActionMsg {
  type: "execute-action";
  action: AgentAction;
}
