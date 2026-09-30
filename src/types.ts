/**
 * Domain types for the Instagram v2 source. Ported from v1 `src/types.ts`;
 * the wire shapes (InstagramMessage / InstagramThread / InstagramCursor) are
 * unchanged — metadata.messages persisted by v1 remains readable by v2's
 * merge. The v1 host-side types (InstagramToken, DOC_TYPE
 * 'instagram_chat_day') are replaced: the token now rides the engine vault
 * as `credentials.password`, and the document type moves to the v2 dotted
 * convention 'instagram.chat_day'.
 */

/** One chat-day document per conversation per LOCAL day. */
export const CHAT_DAY_DOC_TYPE = 'instagram.chat_day';

/** Media docs share the platform-wide 'file' type so the engine's
 *  deep-extraction classifier treats photos/PDFs as OCR/VLM candidates. */
export const FILE_DOC_TYPE = 'file';

export interface InstagramAttachment {
  type: string;
  url?: string;
  id?: string;
}

export interface InstagramMessage {
  id: string;
  from_id: string;
  from_name: string;
  text: string;
  ts_ms: number;
  attachments: InstagramAttachment[];
}

export interface InstagramThread {
  id: string;
  name: string;
  participants: string[];
  /** Participant ids (Instagram-scoped) with usernames — the reply
   *  recipient is chosen from these. */
  participantRefs?: Array<{ id: string; username: string }>;
  last_activity_ms: number;
}

export interface InstagramCursor {
  /** Newest observed thread `updated_time` across a COMPLETED sweep (ISO). */
  last_activity_iso: string;
  /** Set once a sweep re-read every thread with reply targets. Absent →
   *  the next sweep ignores `last_activity_iso` once. */
  outbound?: 1;
}

/** One conversation-day carrying the FULL merged message ledger (prior doc's
 *  metadata.messages ∪ the current API window) — toDocument renders the
 *  complete day from this item alone, no I/O. */
export interface ChatDayItem {
  kind: 'chat_day';
  thread: {
    id: string;
    name: string;
    participants: string[];
    /** The one other person in a 1:1 thread (Instagram-scoped id), frozen at
     *  sync — the reply recipient. Absent when the thread is not 1:1. */
    recipientId?: string;
  };
  /** Local-time YYYY-MM-DD (v1 dayKey). */
  day: string;
  messages: InstagramMessage[];
}

/** An eagerly-downloaded photo/PDF attachment. Bytes ride the item because
 *  the Graph CDN URLs are signed and short-lived — there is nothing durable
 *  to re-fetch later (hence no fetchBytes on the source). */
export interface MediaItem {
  kind: 'media';
  /** `live-media:<threadId>:<msgId>:<slot>` — stable across re-polls. */
  externalId: string;
  threadId: string;
  messageId: string;
  /** Local day of the carrying message — parents the item to its chat-day. */
  day: string;
  filename: string;
  mime: string;
  bytes: Uint8Array;
  sentAtMs: number;
}

export type InstagramItem = ChatDayItem | MediaItem;
