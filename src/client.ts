import { bearerFetch, type FetchLike } from './bearer-fetch';
import type { InstagramMessage, InstagramThread } from './types';

export const GRAPH_BASE = 'https://graph.instagram.com/v21.0';

// Graph rate-limit / transient error codes that can arrive inside a 200/400
// body rather than as an HTTP 429 (4 = app rate limit, 17 = user rate limit,
// 32 = page rate limit, 613 = custom-level throttle).
const GRAPH_THROTTLE_CODES = new Set([4, 17, 32, 613]);

export function isRetryableGraph(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  try {
    const code = JSON.parse(body)?.error?.code;
    if (typeof code === 'number' && GRAPH_THROTTLE_CODES.has(code)) return true;
  } catch {
    // non-JSON body → not a recognizable throttle response
  }
  return false;
}

interface ClientDeps {
  getToken: () => Promise<string>;
}

export class InstagramClient {
  constructor(
    private deps: ClientDeps,
    private fetchImpl: FetchLike = fetch,
  ) {}

  private async get<T>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const token = await this.deps.getToken();
    const qs = new URLSearchParams({
      ...params,
      access_token: token,
    }).toString();
    const url = `${GRAPH_BASE}${path}?${qs}`;
    return bearerFetch<T>(
      url,
      async () => '',
      {
        responseType: 'json',
        isRetryable: isRetryableGraph,
        errorPrefix: 'instagram-graph',
        logTag: 'instagram',
      },
      this.fetchImpl,
    );
  }

  async getMe(): Promise<{ id: string; username: string }> {
    return this.get('/me', { fields: 'id,username' });
  }

  async listThreads(): Promise<InstagramThread[]> {
    const res = await this.get<{
      data: {
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
    const res = await this.get<{
      data: {
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
