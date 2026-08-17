// User-facing error sanitizer. Strips absolute paths, control characters,
// and secret-shaped tokens (>=32 hex, apiKey=/secret= patterns) from
// messages before they reach stderr / JSON envelopes. Pure function; no I/O.
import { escapeControlChars } from "./sanitize-control.js";

const MAX_LENGTH = 500;
const TRUNCATE_SUFFIX = "...[truncated]";

// Absolute paths. Lookbehind `(?<![\w:/.~])` avoids matching URLs
// (https://...), relative paths (./foo, ../foo), and tilde paths (~/foo).
// Separators are `+` so a run of slashes (`/a/b//c` from a bad path join)
// stays inside one match: a match can never start just after a separator
// (the lookbehind blocks it), so a single-slash pattern would mask only the
// first path and leave the rest of the string untouched.
const UNIX_PATH_RE = /(?<![\w:/.~])\/+(?:[a-zA-Z0-9._-]+\/+)+[a-zA-Z0-9._-]+/g;
const WIN_PATH_RE = /(?<!\w)[A-Za-z]:[\\/]+(?:[a-zA-Z0-9._-]+[\\/]+)*[a-zA-Z0-9._-]+/g;

// >= 32 hex chars look like API keys / signatures / hashes.
const HEX_TOKEN_RE = /\b[0-9a-fA-F]{32,}\b/g;

// key=value where the key is a known secret name.
const SECRET_KV_RE =
  /\b(secret|api[-_]?key|apikey|password|nonce|signature|token)\s*[=:]\s*([^\s,;&"'`]+)/gi;

function toErrorString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err === null || err === undefined) return String(err);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function basename(p: string): string {
  const segs = p.split(/[\\/]+/).filter(Boolean);
  return segs[segs.length - 1] ?? "<path>";
}

function shortenPaths(input: string): string {
  return input.replace(UNIX_PATH_RE, basename).replace(WIN_PATH_RE, basename);
}

function maskSecrets(input: string): string {
  return input
    .replace(HEX_TOKEN_RE, "<redacted>")
    .replace(SECRET_KV_RE, (_m, key) => `${key}=<redacted>`);
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, max - TRUNCATE_SUFFIX.length) + TRUNCATE_SUFFIX;
}

export function sanitizeErrorMessage(err: unknown): string {
  let msg = toErrorString(err);
  msg = escapeControlChars(msg);
  msg = shortenPaths(msg);
  msg = maskSecrets(msg);
  msg = truncate(msg, MAX_LENGTH);
  return msg;
}
