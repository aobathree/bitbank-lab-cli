// 税務調査用: private GET の生レスポンス（envelope ごと）を取得する薄いクライアント。
// - 参照系 GET のみ。POST は一切行わない。
// - Zod パースを通さず res.json() をそのまま返す（キー・構造の無変換を保証）。
// - 逐次実行前提。429/5xx は指数バックオフでリトライ。
// - 認証情報は repo の resolveCredentials() を再利用。ログ・成果物に一切出さない。
import { authHeadersGet } from "../../../cli/auth.js";
import { resolveCredentials } from "../../../cli/profiles-resolver.js";

const BASE = "https://api.bitbank.cc/v1";
const MIN_INTERVAL_MS = 400; // 逐次スロットル
const TIMEOUT_MS = 30_000; // 1 リクエストの上限。無応答で採取が止まるのを防ぐ

let lastCallAt = 0;

export async function rawGet(
  path: string,
  params?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const r = resolveCredentials();
  if (!r.success) throw new Error(`credentials: ${r.error}`);

  const qs =
    params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  const url = `${BASE}${path}${qs}`;

  for (let attempt = 0; ; attempt++) {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    lastCallAt = Date.now();

    const headers = authHeadersGet(r.data, path, qs);
    // タイムアウトが無いと応答が返らないときに無限待機し、採取が黙って止まる
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 5) throw new Error(`HTTP ${res.status} after ${attempt + 1} attempts: ${path}`);
      const backoff = 2 ** attempt * 1000;
      console.error(`HTTP ${res.status} on ${path}, backoff ${backoff}ms`);
      await new Promise((res2) => setTimeout(res2, backoff));
      continue;
    }
    const body = await res.json();
    return { status: res.status, body };
  }
}

export function stamp(): string {
  // ファイル名用 UTC タイムスタンプ
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}
