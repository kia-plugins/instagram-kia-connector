/**
 * Shared bearer-token fetch core with retry, timeout, and backoff. Vendored
 * verbatim (minus the Google-only retry predicate) from the app's
 * connectors/http-shared/bearer-fetch — pure `fetch`, no dependencies.
 *
 * The Instagram client (client.ts) is the only caller here; it pins the retry
 * predicate (isRetryableGraph), error prefix and log tag.
 */

// 4 attempts with exponential backoff = max ~30s per failed request (1+2+4+8 =
// 15s of waiting + 4 × timeoutMs worst case).
const MAX_ATTEMPTS = 4;
// Default per-attempt abort timeout. Node's global fetch() has no built-in
// timeout, so a half-dead keep-alive socket can hang a request forever.
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;

export type ResponseType = 'json' | 'text' | 'bytes';

export type FetchLike = typeof fetch;

export interface BearerFetchOpts {
  timeoutMs?: number;
  /** How to read a 2xx body: parsed JSON (default), text, or a Buffer. */
  responseType?: ResponseType;
  /** Merged after the Authorization header (e.g. graph's Accept header). */
  extraHeaders?: Record<string, string>;
  /** Retry policy for HTTP (non-2xx) responses. Network errors and timeouts
   * are always retryable. */
  isRetryable: (status: number, body: string) => boolean;
  /**
   * Prefix for thrown HTTP-failure messages. CONTRACT: the thrown message is
   * exactly `${errorPrefix} ${status} ${url} ${body}`.
   */
  errorPrefix: string;
  /** When set, each retry logs `${logTag} <reason> <url> — retry n/4 after Xms`. */
  logTag?: string;
}

export async function bearerFetch<T>(
  url: string,
  getToken: () => Promise<string>,
  opts: BearerFetchOpts,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const responseType = opts.responseType ?? 'json';
  for (let attempt = 0; ; attempt++) {
    const token = await getToken(); // fresh per attempt (also handles retries after expiry)
    const controller = new AbortController();
    const handle = setTimeout(() => controller.abort(), timeoutMs);
    // The abort signal must remain armed across BOTH header read and body read:
    // fetch() resolves as soon as headers arrive, so an early clearTimeout
    // leaves r.json() / r.text() unprotected.
    let parsed: T | undefined;
    let httpFail:
      | { status: number; body: string; retryAfter: string | null }
      | undefined;
    let netError: Error | undefined;
    try {
      const r = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.extraHeaders ?? {}),
        },
        signal: controller.signal,
      });
      if (r.ok) {
        if (responseType === 'json') parsed = (await r.json()) as T;
        else if (responseType === 'text')
          parsed = (await r.text()) as unknown as T;
        else parsed = Buffer.from(await r.arrayBuffer()) as unknown as T;
      } else {
        httpFail = {
          status: r.status,
          body: await r.text(),
          retryAfter: r.headers.get('retry-after'),
        };
      }
    } catch (e) {
      netError = e as Error;
    } finally {
      clearTimeout(handle);
    }

    if (parsed !== undefined) return parsed;

    if (netError) {
      if (attempt < MAX_ATTEMPTS) {
        const delay =
          Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 250;
        if (opts.logTag) {
          const reason =
            netError.name === 'AbortError'
              ? `timeout(${timeoutMs}ms)`
              : netError.message;
          console.warn(
            `${opts.logTag} ${reason} ${url} — retry ${attempt + 1}/${MAX_ATTEMPTS} after ${Math.round(delay)}ms`,
          );
        }
        await new Promise((res) => setTimeout(res, delay));
        continue;
      }
      throw netError;
    }

    // Reaching here means we got an HTTP status >= 400 with a body.
    const { status, body, retryAfter } = httpFail!;
    if (attempt < MAX_ATTEMPTS && opts.isRetryable(status, body)) {
      const retryAfterMs = Number(retryAfter);
      const delay =
        Number.isFinite(retryAfterMs) && retryAfterMs > 0
          ? retryAfterMs * 1000
          : Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 250;
      if (opts.logTag) {
        console.warn(
          `${opts.logTag} ${status} ${url} — retry ${attempt + 1}/${MAX_ATTEMPTS} after ${Math.round(delay)}ms`,
        );
      }
      await new Promise((res) => setTimeout(res, delay));
      continue;
    }
    throw new Error(`${opts.errorPrefix} ${status} ${url} ${body}`);
  }
}
