// PII detection rules — built at Phase 1b of the build plan.
// Two layers:
//   - detectPii(text): regex-based detection for arbitrary text (DOM text,
//     input values, OCR output, canvas regions).
//   - sensitiveFieldName(name/id/autocomplete): label-based heuristic to flag
//     a field as sensitive even when its current value is empty.
//
// Classification tiers:
//   Tier A — passwords / secret hidden fields: solid black box, no token.
//   Tier B — PII: black box + stable token like [EMAIL_1]. Same value ⇒ same
//            token so the VLM keeps continuity across steps.

export interface PiiMatch {
  type: string; // e.g. "email" | "phone" | "aadhaar" | "pan" | "card" | "name" | "address"
  tier: "A" | "B";
  label: string;
  /** Match location in the source text. */
  start: number;
  end: number;
  value: string;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE =
  /(?<![\d])(?:\+91[\s-]?)?(?:\d{5}[\s-]?\d{5}|(?:\d[\s-]?){10})(?![\d])/g;
const AADHAAR_RE =
  /(?<![\d])[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?![\s-]?\d)/g;
const PAN_RE = /(?<![A-Z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Z0-9])/g;
// Credit card: 13-16 digits grouped 4s, Luhn-validated below.
const CARD_CANDIDATE_RE = /(?<![\d])\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}(?![\d])/g;
// Utility account numbers (EB-CA989766 style). Too loose for DOM prose (any
// dashed alnum token would match), so it only runs on OCR-extracted image
// text where over-redaction is safe and there is no label context to lean on.
const ACCOUNT_OCR_RE = /\b[A-Z]{2,4}-[A-Z]{1,4}\d{4,}\b/g;

function luhnValid(num: string): boolean {
  const digits = num.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = +digits[i];
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const TIER_A_EXACT =
  /^(password|passwd|pwd|cpassword|confirmpassword|retypepassword|secret|currentpassword|newpassword|cvv|otp|pin)$/i;
const TIER_A_CONTAINS = /(api[_-]?key|secret|token|cvv|otp)/i;
const TIER_B_FIELDS: Record<string, string> = {
  // Name family first so labels like "name on card" map to "name", not "card".
  names: "name",
  fullname: "name",
  "given-name": "name",
  "family-name": "name",
  nickname: "name",
  name: "name",
  "cardholder-name": "name",
  username: "name",
  userid: "name",
  // Address family
  address: "address",
  "street-address": "address",
  "address-line1": "address",
  "address-line2": "address",
  city: "address",
  zipcode: "address",
  postal: "address",
  // Email / phone
  email: "email",
  emailaddress: "email",
  phone: "phone",
  mobile: "phone",
  tel: "phone",
  telephone: "phone",
  // Government IDs
  aadhaar: "aadhaar",
  aadhar: "aadhaar",
  uid: "aadhaar",
  pan: "pan",
  dob: "dob",
  birthday: "dob",
  dateofbirth: "dob",
  // Bank account (label-only — prose account numbers are too loose to regex)
  account: "account",
  accountnumber: "account",
  accountno: "account",
  acct: "account",
  iban: "account",
  ifsc: "ifsc",
  // Card
  card: "card",
  cc: "card",
  cardnumber: "card",
  creditcard: "card",
  ssn: "ssn",
};

export function sensitiveFieldName(
  text: string,
): { type: string; tier: "A" | "B" } | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  // Match whole-word against a cleaned alias
  const cleaned = lower.replace(/[_\-\s]/g, "");
  if (TIER_A_EXACT.test(cleaned) || TIER_A_CONTAINS.test(lower)) {
    return { type: "password", tier: "A" };
  }
  // Exact alias match first across ALL keys, then substring — otherwise short
  // aliases ("cc") hijack longer field names ("account" contains "cc").
  for (const [key, type] of Object.entries(TIER_B_FIELDS)) {
    if (cleaned === key) return { type, tier: "B" };
  }
  for (const [key, type] of Object.entries(TIER_B_FIELDS)) {
    if (cleaned.includes(key)) {
      return { type, tier: "B" };
    }
  }
  return null;
}

export function detectPii(
  text: string,
  opts?: { ocr?: boolean },
): PiiMatch[] {
  const matches: PiiMatch[] = [];
  const ocr = opts?.ocr === true;

  // Email
  for (const m of text.matchAll(EMAIL_RE)) {
    matches.push({
      type: "email",
      tier: "B",
      label: "email",
      start: m.index!,
      end: m.index! + m[0].length,
      value: m[0],
    });
  }

  // Phone
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 10) continue;
    matches.push({
      type: "phone",
      tier: "B",
      label: "phone",
      start: m.index!,
      end: m.index! + m[0].length,
      value: m[0],
    });
  }

  // Aadhaar
  for (const m of text.matchAll(AADHAAR_RE)) {
    matches.push({
      type: "aadhaar",
      tier: "B",
      label: "aadhaar",
      start: m.index!,
      end: m.index! + m[0].length,
      value: m[0],
    });
  }

  // PAN
  for (const m of text.matchAll(PAN_RE)) {
    matches.push({
      type: "pan",
      tier: "B",
      label: "pan",
      start: m.index!,
      end: m.index! + m[0].length,
      value: m[0],
    });
  }

  // Card (Luhn-validated)
  for (const m of text.matchAll(CARD_CANDIDATE_RE)) {
    if (!luhnValid(m[0])) continue;
    matches.push({
      type: "card",
      tier: "B",
      label: "card",
      start: m.index!,
      end: m.index! + m[0].length,
      value: m[0],
    });
  }

  // Account numbers — OCR-only (see ACCOUNT_OCR_RE note)
  if (ocr) {
    for (const m of text.matchAll(ACCOUNT_OCR_RE)) {
      matches.push({
        type: "account",
        tier: "B",
        label: "account",
        start: m.index!,
        end: m.index! + m[0].length,
        value: m[0],
      });
    }
  }

  // Sort by start position
  matches.sort((a, b) => a.start - b.start);
  return matches;
}
