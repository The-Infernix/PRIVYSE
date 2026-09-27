// Server endpoint for the agent loop. Local FastAPI dev server by default.
// Overridable at runtime from the side panel (Advanced → Server URL); the value
// lives in browser.storage.local under `sihServerUrl` so both the background
// worker and the panel read the SAME endpoint without a rebuild.

export const DEFAULT_SERVER_URL = "http://127.0.0.1:8000";
export const STORAGE_SERVER_URL = "sihServerUrl";

/** Normalize a user-supplied endpoint: keep scheme + host + optional path,
 *  strip trailing slashes. Throws on garbage so callers can fall back. */
export function normalizeServerUrl(raw: string): string {
  return new URL(raw.trim()).toString().replace(/\/+$/, "");
}

/** Resolve the configured server URL (storage takes precedence over default).
 *  No caching — the background worker and side panel both read fresh so a
 *  change in the panel takes effect on the next step immediately. */
export async function getServerUrl(): Promise<string> {
  try {
    const { [STORAGE_SERVER_URL]: v } = (await browser.storage.local.get(
      STORAGE_SERVER_URL,
    )) as { [STORAGE_SERVER_URL]?: string };
    if (typeof v === "string" && v.trim()) return normalizeServerUrl(v);
  } catch {
    /* storage unavailable — fall through to default */
  }
  return DEFAULT_SERVER_URL;
}