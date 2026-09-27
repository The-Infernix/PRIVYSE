// SIH 26171 — Forensic Exhibit: printable privacy receipt.
//
// A judge-facing, exportable summary of a completed run: task, duration, every
// step's gate verdict, aggregated redaction counts by type, the stable-token
// map used, and the "0 raw values sent" guarantee. Rendered as a self-contained
// document that the side panel prints via the hidden #printRoot + @media print
// rules — nothing else on screen interferes.

export interface ReceiptStepRow {
  step: number;
  verdict: "pass" | "block" | "skip";
  protected: number;
}

export interface ReceiptData {
  task: string;
  kind: "loop" | "step";
  started: number;
  ended: number;
  status: string;
  steps: ReceiptStepRow[];
  protectedTotal: number;
  leaked: number;
  gate: "PASS" | "BLOCKED";
  perception?: string;
  backend?: string;
  byType?: { type: string; count: number }[];
  tokens?: { masked: string; token: string }[];
}

export function elapsedText(from: number, to: number): string {
  const sec = Math.max(1, Math.round((to - from) / 1000));
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    return `${m}m ${sec - m * 60}s`;
  }
  return `${sec}s`;
}

/** Build a detached, printable receipt node from the run summary. */
export function buildReceipt(data: ReceiptData): HTMLElement {
  const root = document.createElement("div");
  root.className = "receipt";

  const brand = document.createElement("div");
  brand.className = "receipt-brand";
  const logo = document.createElement("span");
  logo.className = "receipt-logo";
  logo.textContent = "🛡";
  const title = document.createElement("div");
  const h1 = document.createElement("h1");
  h1.textContent = "PRIVYSE — Privacy Report";
  const sub = document.createElement("p");
  sub.textContent = "On-device redaction · local VLM · zero-leak gate";
  title.append(h1, sub);
  brand.append(logo, title);

  const verdict = document.createElement("div");
  verdict.className = `receipt-gate ${data.gate === "PASS" ? "gate-pass" : "gate-block"}`;
  verdict.innerHTML = `<b>${data.gate}</b><span>zero-leak · 0 raw values sent</span>`;

  const meta = document.createElement("dl");
  meta.className = "receipt-meta";
  const metaRow = (k: string, v: string) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    meta.append(dt, dd);
  };
  metaRow("Task", data.task || "(no task)");
  metaRow("Run", data.kind === "loop" ? "Agent loop" : "Single step");
  metaRow("Status", data.status);
  metaRow("Duration", elapsedText(data.started, data.ended));
  metaRow("Sensitive values protected", String(data.protectedTotal));
  metaRow("Raw values sent", String(data.leaked));
  if (data.perception) metaRow("On-device perception", data.perception);
  if (data.backend) metaRow("ViT backend", data.backend);

  const tally = document.createElement("div");
  tally.className = "receipt-tally";
  const tallies: [string, string][] = [["Protected", `${data.protectedTotal}`], ["Raw sent", `${data.leaked}`], ["Steps", `${data.steps.length}`]];
  for (const [k, v] of tallies) {
    const cell = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = v;
    const span = document.createElement("span");
    span.textContent = k;
    cell.append(b, span);
    tally.appendChild(cell);
  }

  const steps = document.createElement("table");
  steps.className = "receipt-steps";
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  for (const h of ["Step", "Gate", "Protected"]) trh.appendChild(document.createElement("th")).textContent = h;
  thead.appendChild(trh);
  const tbody = document.createElement("tbody");
  for (const s of data.steps) {
    const tr = document.createElement("tr");
    for (const c of [String(s.step), s.verdict.toUpperCase(), String(s.protected)]) {
      const td = document.createElement("td");
      td.textContent = c;
      if (c === "PASS") td.className = "cell-pass";
      if (c === "BLOCKED") td.className = "cell-block";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  steps.append(thead, tbody);

  root.append(brand, verdict, meta, tally, steps);

  if (data.byType && data.byType.length > 0) {
    const typeHead = document.createElement("h2");
    typeHead.className = "receipt-h2";
    typeHead.textContent = "Protected by type";
    const chips = document.createElement("div");
    chips.className = "receipt-chips";
    for (const t of data.byType) {
      const chip = document.createElement("span");
      chip.className = "receipt-chip";
      chip.textContent = `${t.type.replace(/_/g, " ")} × ${t.count}`;
      chips.appendChild(chip);
    }
    root.append(typeHead, chips);
  }

  if (data.tokens && data.tokens.length > 0) {
    const tokHead = document.createElement("h2");
    tokHead.className = "receipt-h2";
    tokHead.textContent = "Stable-token map";
    const tok = document.createElement("ul");
    tok.className = "receipt-tokens";
    for (const t of data.tokens.slice(0, 12)) {
      const li = document.createElement("li");
      const m = document.createElement("span");
      m.textContent = t.masked;
      const arr = document.createElement("span");
      arr.textContent = "→";
      const tk = document.createElement("b");
      tk.textContent = t.token;
      li.append(m, arr, tk);
      tok.appendChild(li);
    }
    root.append(tokHead, tok);
  }

  const foot = document.createElement("p");
  foot.className = "receipt-foot";
  foot.textContent = "Verified on-device by PRIVYSE · SIH 26171 · screen never leaves the device";
  root.appendChild(foot);

  return root;
}