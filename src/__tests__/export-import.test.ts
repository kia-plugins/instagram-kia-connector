/** @jest-environment node */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { ProgressSink } from '@kiagent/connector-sdk';
import {
  fixMetaMojibake,
  parseThreadJson,
  importExportFolder,
} from '../export-import';
import { mediaDir } from '../media-dir';
import { captureHost } from './mocks';

test('fixMetaMojibake repairs double-encoded UTF-8', () => {
  const broken = Buffer.from('café', 'utf8').toString('latin1');
  expect(fixMetaMojibake(broken)).toBe('café');
});

test('parseThreadJson maps inbox JSON to thread + messages', () => {
  const raw = {
    participants: [{ name: 'Alice' }, { name: 'me' }],
    thread_path: 'inbox/alice_123',
    messages: [
      { sender_name: 'Alice', timestamp_ms: 1749810000000, content: 'hi' },
      { sender_name: 'me', timestamp_ms: 1749810001000, content: 'yo' },
    ],
  };
  const { thread, messages } = parseThreadJson(raw, 'alice_123');
  expect(thread.id).toBe('alice_123');
  expect(thread.name).toBe('Alice, me');
  expect(messages).toHaveLength(2);
  expect(messages[0].text).toBe('hi');
  expect(messages[0].ts_ms).toBe(1749810000000);
});

test('message ids stay unique across paginated files (no cross-file collision)', () => {
  const f1 = parseThreadJson(
    {
      messages: [
        { sender_name: 'A', timestamp_ms: 1749810000000, content: 'one' },
      ],
    },
    'thr',
    'message_1.json:',
  );
  const f2 = parseThreadJson(
    {
      messages: [
        { sender_name: 'A', timestamp_ms: 1749810000000, content: 'two' },
      ],
    },
    'thr',
    'message_2.json:',
  );
  expect(f1.messages[0].id).not.toBe(f2.messages[0].id);
});

test('importExportFolder end-to-end: parses temp dir and upserts chat-day docs', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-export-test-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-data-'));
  const inboxDir = path.join(
    tmpRoot,
    'your_instagram_activity',
    'messages',
    'inbox',
    'bob_456',
  );
  fs.mkdirSync(inboxDir, { recursive: true });

  const rawThread = {
    participants: [{ name: 'Bob' }, { name: 'me' }],
    thread_path: 'inbox/bob_456',
    messages: [
      { sender_name: 'Bob', timestamp_ms: 1749810000000, content: 'hello' },
      { sender_name: 'me', timestamp_ms: 1749810060000, content: 'hey' },
    ],
  };
  fs.writeFileSync(
    path.join(inboxDir, 'message_1.json'),
    JSON.stringify(rawThread),
    'utf8',
  );

  const { ctx, docs } = captureHost();
  const progressUpdates: [number, number][] = [];
  const progress: ProgressSink = {
    update: (done, total) => progressUpdates.push([done, total ?? -1]),
    log: () => {},
  };

  const result = await importExportFolder(ctx, tmpRoot, progress, {
    baseDir: mediaDir(dataRoot),
  });

  expect(result.threads).toBe(1);
  expect(result.days).toBe(1); // both messages on the same day
  expect(result.media).toBe(0); // no media attachments in this thread
  expect(progressUpdates).toEqual([[1, 1]]);
  expect(docs.length).toBeGreaterThan(0);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
