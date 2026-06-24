import type { SafeStorageLike } from '@alpha-cent/connector-sdk';
import {
  decodeJsonFromStorage,
  encodeJsonForStorage,
} from './safe-storage-blob';
import type { InstagramToken } from './types';

export function encodeInstagramTokenForStorage(
  t: InstagramToken,
  ss: SafeStorageLike,
): Buffer {
  return encodeJsonForStorage(t, ss);
}

export function decodeInstagramTokenFromStorage(
  blob: Buffer,
  ss: SafeStorageLike,
): InstagramToken {
  return decodeJsonFromStorage<InstagramToken>(blob, ss);
}
