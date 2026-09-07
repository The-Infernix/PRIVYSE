// SIH 26171 — shared protocol (frozen at v1 per build plan §1d).
// The same action shapes are used by: extension background, content script,
// and the FastAPI server. Any change must bump PROTOCOL_VERSION.

export const PROTOCOL_VERSION = 1;

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
  | { type: "done"; answer?: string };

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
  /** JPEG base64, ALREADY SANITIZED — sanitizer gate is the only producer. */
  screenshot_b64: string;
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
  | { type: "think-end"; thought: string };

/** background → content script */
export interface ExecuteActionMsg {
  type: "execute-action";
  action: AgentAction;
}
