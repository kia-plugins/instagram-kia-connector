/**
 * v2 port of v1 `src/client.ts` + `src/bearer-fetch.ts` (both on `git show
 * 16fd254`), collapsed into one Graph client. Preserved verbatim from v1:
 *
 *  - API base https://graph.instagram.com/v21.0 and the three endpoints
 *    (`/me`, `/me/conversations`, `/{threadId}/messages`) with their field
 *    lists and response mappings.
 *  - Token transport: `access_token` QUERY PARAM (v1-authoritative — the
 *    Bearer header v1's bearerFetch also sent was ignored by Graph; v2 sends
 *    only the query param).
 *  - Retry policy: retries while attempt < 4 (so up to 5 requests total,
 *    matching v1's loop, not its "4 attempts" comment), backoff
 *    min(60s, 1000·2^n) + jitter, Retry-After honored (seconds), retried on
 *    HTTP 429 / any 5xx / body error.code ∈ {4, 17, 32, 613}
 *    (isRetryableGraph). Network errors are always retryable.
 *
 * Deltas from v1:
 *  1. All I/O goes through `deps.fetch` — the host's `net.fetch` surface —
 *     never the global fetch. The host resolves to a plain object (status /
 *     statusText / headers with lowercase keys / body: Uint8Array), so
 *     responses are parsed manually and `ok` is computed from `status`.
 *  2. DROPPED: the 90s AbortController per-attempt timeout — the host's
 *     net.fetch owns the transport (and its hang protection); the client no
 *     longer manages sockets.
 *  3. NEW (fixes a v1 gap): auth errors are recognized — HTTP 401 OR body
 *     error.code === 190 → InstagramAuthError, NEVER retried, always
 *     propagated (message ends "— reconnect the account") so the engine can
 *     flip the account to needsReauth.
 *  4. `sleep` is injectable so tests never wait out the backoff (v1's seam
 *     was the fetch mock alone). No `now` seam: unlike Notion there is no
 *     inter-request throttle interval, so nothing reads a clock.
 *  5. Retry logging goes to an injectable `log` (the source wires
 *     session.log('warn', …)) instead of v1's console.warn, and URLs are
 *     logged/thrown WITHOUT the access_token query param — the token must
 *     never reach logs or Account.lastError.
 */
import type { InstagramMessage, InstagramThread } from './types';

export type NetFetch = (url: string, init?: unknown) => Promise<unknown>;

export const GRAPH_BASE = 'https://graph.instagram.com/v21.0';

// Graph rate-limit / transient error codes that can arrive inside a 400 body
// rather than as an HTTP 429 (4 = app rate limit, 17 = user rate limit,
// 32 = page rate limit, 613 = custom-level throttle).
const GRAPH_THROTTLE_CODES = new Set([4, 17, 32, 613]);
/** Graph OAuthException code for an invalid/expired token. */
const GRAPH_AUTH_CODE = 190;
/** Retries happen while attempt < MAX_ATTEMPTS (v1 loop parity). */
const MAX_ATTEMPTS = 4;

/** The host `net.fetch` surface resolves to this shape — header keys are
 *  lowercase (built via Object.fromEntries(res.headers.entries())). */
interface HostResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

function parseGraphError(body: string): { code?: number; message?: string } {
  try {
    const err = (JSON.parse(body) as { error?: { code?: unknown; message?: unknown } })?.error;
    return {
      code: typeof err?.code === 'number' ? err.code : undefined,
      message: typeof err?.message === 'string' ? err.message : undefined,
    };
  } catch {
    return {}; // non-JSON body → no recognizable Graph error envelope
  }
}

/** v1 predicate, verbatim: consulted for non-2xx responses only. */
export function isRetryableGraph(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  const code = parseGraphError(body).code;
  return code !== undefined && GRAPH_THROTTLE_CODES.has(code);
}

/** HTTP 401 OR body error.code 190 → the token is dead; retrying is futile. */
export function isAuthErrorGraph(status: number, body: string): boolean {
  return status === 401 || parseGraphError(body).code === GRAPH_AUTH_CODE;
}

/** Never retried; always propagated so the engine flips the account to
 *  needsReauth. The message MUST end with "— reconnect the account". */
export class InstagramAuthError extends Error {
  constructor(
    public httpStatus: number,
    public graphCode: number | undefined,
    detail: string,
  ) {
    super(
      `instagram auth error (HTTP ${httpStatus}${
        graphCode !== undefined ? `, code ${graphCode}` : ''
      }): ${detail} — reconnect the account`,
    );
    this.name = 'InstagramAuthError';
  }
}

export interface InstagramClientDeps {
  fetch: NetFetch;
  token: string;
  /** Test seam: instant backoff. Production omits (real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Retry warnings; the source wires session.log('warn', …). */
  log?: (msg: string) => void;
}

export class InstagramClient {
  private readonly fetchFn: NetFetch;

  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(private readonly deps: InstagramClientDeps) {
    this.fetchFn = deps.fetch;
    this.sleepFn =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private backoff(attempt: number): number {
    return Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 250;
  }

  private async get<T>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const qs = new URLSearchParams({
      ...params,
      access_token: this.deps.token,
    }).toString();
    const url = `${GRAPH_BASE}${path}?${qs}`;
    // Token-free twin for thrown messages and retry logs (see header note 5).
    const safeUrl = `${GRAPH_BASE}${path}`;
    for (let attempt = 0; ; attempt++) {
      let res: HostResponse;
      try {
        res = (await this.fetchFn(url)) as HostResponse;
      } catch (e) {
        // Network errors and transport timeouts are always retryable.
        if (attempt < MAX_ATTEMPTS) {
          const delay = this.backoff(attempt);
          const reason = e instanceof Error ? e.message : String(e);
          this.deps.log?.(
            `instagram ${reason} ${safeUrl} — retry ${attempt + 1}/${MAX_ATTEMPTS} after ${Math.round(delay)}ms`,
          );
          await this.sleepFn(delay);
          continue;
        }
        throw e;
      }

      const body = new TextDecoder().decode(res.body);
      if (res.status >= 200 && res.status < 300) return JSON.parse(body) as T;

      // v2 fix (v1 had no auth handling): dead token → typed error, no retry.
      if (isAuthErrorGraph(res.status, body)) {
        const { code, message } = parseGraphError(body);
        throw new InstagramAuthError(
          res.status,
          code,
          message ?? `HTTP ${res.status}`,
        );
      }

      if (attempt < MAX_ATTEMPTS && isRetryableGraph(res.status, body)) {
        const retryAfterS = Number(res.headers['retry-after']);
        const delay =
          Number.isFinite(retryAfterS) && retryAfterS > 0
            ? retryAfterS * 1000
            : this.backoff(attempt);
        this.deps.log?.(
          `instagram ${res.status} ${safeUrl} — retry ${attempt + 1}/${MAX_ATTEMPTS} after ${Math.round(delay)}ms`,
        );
        await this.sleepFn(delay);
        continue;
      }

      // v1 message contract (`${errorPrefix} ${status} ${url} ${body}`),
      // minus the token-bearing query string.
      throw new Error(`instagram-graph ${res.status} ${safeUrl} ${body}`);
    }
  }

  async getMe(): Promise<{ id: string; username?: string }> {
    return this.get('/me', { fields: 'id,username' });
  }

  async listThreads(): Promise<InstagramThread[]> {
    const res = await this.get<{
      data?: {
        id: string;
        updated_time?: string;
        name?: string;
        participants?: { data: { username?: string }[] };
      }[];
    }>('/me/conversations', {
      platform: 'instagram',
      fields: 'id,updated_time,name,participants',
    });
    return (res.data ?? []).map((t) => ({
      id: t.id,
      name:
        t.name ??
        (t.participants?.data
          ?.map((p) => p.username)
          .filter(Boolean)
          .join(', ') ||
          t.id),
      participants: (t.participants?.data ?? [])
        .map((p) => p.username ?? '')
        .filter(Boolean),
      last_activity_ms: t.updated_time ? Date.parse(t.updated_time) : 0,
    }));
  }

  async listMessages(threadId: string): Promise<InstagramMessage[]> {
    // NO pagination: Graph returns only the last ~20 messages per thread —
    // that constraint drives the chat-day merge in source.ts.
    const res = await this.get<{
      data?: {
        id: string;
        created_time?: string;
        from?: { id: string; username?: string };
        message?: string;
        attachments?: {
          data: {
            type?: string;
            image_data?: { url: string };
            video_data?: { url: string };
            id?: string;
          }[];
        };
      }[];
    }>(`/${threadId}/messages`, {
      fields: 'id,created_time,from,message,attachments',
    });
    return (res.data ?? []).map((m) => ({
      id: m.id,
      from_id: m.from?.id ?? '',
      from_name: m.from?.username ?? m.from?.id ?? '',
      text: m.message ?? '',
      ts_ms: m.created_time ? Date.parse(m.created_time) : 0,
      attachments: (m.attachments?.data ?? []).map((a) => {
        const imageUrl = a.image_data?.url;
        const videoUrl = a.video_data?.url;
        return {
          // Derive a kind from which *_data block carried the CDN url so the
          // live-media downloader can tell photos (OCR candidates) from videos.
          type: a.type ?? (imageUrl ? 'photo' : videoUrl ? 'video' : 'media'),
          url: imageUrl ?? videoUrl,
          id: a.id,
        };
      }),
    }));
  }
}
