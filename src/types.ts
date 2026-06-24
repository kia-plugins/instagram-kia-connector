export const DOC_TYPE = 'instagram_chat_day';

export interface InstagramToken {
  access_token: string;
  ig_user_id: string;
  username: string;
  app_id?: string;
}

export interface InstagramMessage {
  id: string;
  from_id: string;
  from_name: string;
  text: string;
  ts_ms: number;
  attachments: { type: string; url?: string; id?: string }[];
}

export interface InstagramThread {
  id: string;
  name: string;
  participants: string[];
  last_activity_ms: number;
}

export interface InstagramCursor {
  // newest observed thread activity across all threads, ISO string
  last_activity_iso: string;
}
