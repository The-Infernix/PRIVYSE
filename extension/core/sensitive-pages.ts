// Sensitive-page privacy guard (borrowed from clicky-windows' window-title
// blocklist). BEFORE we capture + send a screenshot, we check the page URL and
// title against a blocklist of high-risk categories (banking, credentials,
// government IDs, etc.). On a hit we skip the screenshot entirely — belt-and-
// suspenders on top of the PII sanitizer, which only redacts AFTER capture.
//
// This is the extension's equivalent of clicky's "if the window title matches
// a sensitive regex, don't even take the screenshot." The raw pixels of a
// banking session never reach the VLM, let alone the OCR or face path.
//
// Precision tiers (web URLs are noisier than desktop window titles):
//  - STRONG terms block anywhere in URL or title: `login`, `netbanking`,
//    `sbi`, `hdfc`, `checkout`, `aadhaar`, ... These are high-confidence
//    signals — a page with "login" in the URL/title IS a login page.
//  - MEDIUM terms (generic `bank`, `banking`, `payment`, `upi`, `wallet`)
//    only block when they appear in the HOST labels, never alone in a title —
//    so a Wikipedia article titled "Banking" or a blog about "online payments"
//    is NOT flagged, but `netbanking.hdfcbank.com` and `paytm.com` are.
import type { ServerActRequest } from "./protocol";

export interface SensitiveMatch {
  reason: string;
  /** e.g. "URL" or "title" — which signal matched. */
  source: "url" | "title";
  /** The substring that matched. */
  matched: string;
}

const STRONG: { reason: string; re: RegExp }[] = [
  { reason: "credentials / login", re: /(?:^|[\s\/:._-])(login|log\s?in|sign\s?in|signin|logout|log\s?out|signout|authenticator|sso|otp|password|passwd|credential|2fa|two\s?factor)(?:$|[\s\/:._-])/i },
  { reason: "banking / netbanking", re: /(?:^|[\s\/:._-])(netbanking|internetbanking)(?:$|[\s\/:._-])/i },
  { reason: "payment / checkout", re: /(?:^|[\s\/:._-])(checkout|payment\s?gateway|payment\s?page)(?:$|[\s\/:._-])/i },
  { reason: "bank apps / wallets", re: /(?:^|[\s\/:._-])(paytm|phonepe|gpay|razorpay|paypal|venmo|stripe)(?:$|[\s\/:._-])/i },
  { reason: "Indian banks", re: /(?:^|[\s\/:._-])(\bhdfc\b|\bicici\b|\bsbi\b|\baxis\b|\bkotak\b)(?:$|[\s\/:._-])/i },
  { reason: "password managers", re: /(?:^|[\s\/:._-])(keepass|bitwarden|1password|lastpass|dashlane)(?:$|[\s\/:._-])/i },
  { reason: "government IDs / income tax", re: /(?:^|[\s\/:._-])(aadhaar|pan\s?card|\bpancard\b|income\s?tax|incometax|passport|voter\s?id|driving\s?licence|driving\s?license)(?:$|[\s\/:._-])/i },
  { reason: "secrets / config", re: /\.env\b|api[_-]?key|\bsecret\b|\btoken\b/i },
];

// Generic terms — host labels only (see module docstring).
const MEDIUM_HOST: { reason: string; re: RegExp }[] = [
  { reason: "banking / payments", re: /(?:^|[\s\/:._-])(bank|banking|payment|payments|upi|wallet)(?:$|[\s\/:._-])/i },
];

// Content sites where a generic word like "banking" in the path/title is a
// harmless article, not a live session. Host labels are matched as whole
// segments, so "wikipedia.org" also covers "en.wikipedia.org".
const CONTENT_HOSTS = ["wikipedia", "fandom", "wordpress", "medium", "substack", "github.io", "readthedocs", "stackoverflow", "w3schools", "mdn"];

function hostHasGenericBanking(host: string): SensitiveMatch | null {
  const labels = host.toLowerCase().split(".");
  for (const label of labels) {
    for (const { reason, re } of MEDIUM_HOST) {
      if (re.test(label)) return { reason, source: "url", matched: label };
    }
  }
  return null;
}

function matchStrong(text: string, source: "url" | "title"): SensitiveMatch | null {
  for (const { reason, re } of STRONG) {
    const m = re.exec(text);
    if (m) return { reason, source, matched: m[0] };
  }
  return null;
}

/**
 * Decide whether a page is sensitive enough that we should NOT send any
 * screenshot to the VLM. Returns a human-readable reason, or null if safe.
 */
export function isSensitivePage(url: string, title: string): SensitiveMatch | null {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, "");
    path = u.pathname + (u.search || "");
  } catch {
    host = url;
  }

  // Strong terms block anywhere (URL or title) — a URL with "login" in it IS
  // a login page regardless of which site it is.
  const urlStrong = matchStrong(host + " " + path, "url");
  if (urlStrong) return urlStrong;
  const titleStrong = matchStrong(title, "title");
  if (titleStrong) return titleStrong;

  // Generic banking terms: only when they are host labels, and only on real
  // transaction/bank sites — never on content sites like Wikipedia.
  if (!CONTENT_HOSTS.some((c) => host.includes(c))) {
    const hostHit = hostHasGenericBanking(host);
    if (hostHit) return hostHit;
  }

  return null;
}

// False-positive battery — a generic e-commerce checkout IS sensitive (payment),
// but a recipe/blog/Wikipedia page must NOT be flagged. Kept here so the guard
// stays verifiable and reviewable without spinning up a browser.
export const SENSITIVE_URL_CASES: { url: string; title: string; expect: boolean }[] = [
  { url: "https://netbanking.hdfcbank.com/", title: "NetBanking", expect: true },
  { url: "https://www.amazon.in/gp/buy/checkout", title: "Checkout", expect: true },
  { url: "https://onlinesbi.sbi.co.in/login", title: "SBI Online - Customer Login", expect: true },
  { url: "https://www.incometax.gov.in/iec/foportal/", title: "Income Tax e-Filing", expect: true },
  { url: "https://accounts.google.com/signin", title: "Sign in - Google Accounts", expect: true },
  { url: "https://paytm.com", title: "Paytm Payments", expect: true },
  { url: "https://example.com/recipe/butter-chicken", title: "Butter Chicken Recipe", expect: false },
  { url: "https://github.com/myorg/myapi", title: "myapi - GitHub", expect: false },
  { url: "https://en.wikipedia.org/wiki/Banking", title: "Banking - Wikipedia", expect: false },
  { url: "https://news.ycombinator.com/", title: "Hacker News", expect: false },
  { url: "https://medium.com/p/how-to-do-online-banking", title: "How to do online banking", expect: false },
  { url: "https://login.microsoftonline.com/", title: "Sign in to your account", expect: true },
  { url: "https://keepass.info/download.html", title: "KeePass Downloads", expect: true },
];