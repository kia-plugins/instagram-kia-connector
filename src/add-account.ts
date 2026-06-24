import { GRAPH_BASE } from './client';
import type { InstagramToken } from './types';

export type ValidateInstagramResult =
  | { ok: true; token: InstagramToken }
  | { ok: false; error: string; message: string };

export async function validateInstagramToken(
  raw: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<ValidateInstagramResult> {
  const token = raw.trim();
  if (token.length < 5) {
    return {
      ok: false,
      error: 'invalid-token-format',
      message: 'Paste a valid long-lived Instagram access token.',
    };
  }
  let res: Response;
  try {
    res = await fetchFn(
      `${GRAPH_BASE}/me?fields=id,username&access_token=${encodeURIComponent(token)}`,
    );
  } catch {
    return {
      ok: false,
      error: 'network-failed',
      message: 'Could not reach Instagram. Check your connection.',
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: 'auth-failed',
      message:
        'Instagram rejected the token. Generate a fresh long-lived token.',
    };
  }
  const me = (await res.json()) as { id?: string; username?: string };
  if (!me.id) {
    return {
      ok: false,
      error: 'auth-failed',
      message: 'Instagram did not return an account id for this token.',
    };
  }
  return {
    ok: true,
    token: {
      access_token: token,
      ig_user_id: me.id,
      username: me.username ?? me.id,
    },
  };
}
