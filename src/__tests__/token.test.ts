import {
  encodeInstagramTokenForStorage,
  decodeInstagramTokenFromStorage,
} from '../token';
import type { InstagramToken } from '../types';
import { fakeSafeStorage } from './mocks';

test('round-trips an instagram token through the encrypted blob', () => {
  const ss = fakeSafeStorage();
  const tok: InstagramToken = {
    access_token: 'IGQ...',
    ig_user_id: '178',
    username: 'eldar',
    app_id: '99',
  };
  const blob = encodeInstagramTokenForStorage(tok, ss);
  expect(decodeInstagramTokenFromStorage(blob, ss)).toEqual(tok);
});
