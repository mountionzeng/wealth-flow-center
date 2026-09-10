import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudAuth, safeAuthReturnTo } from './cloudAuth.js';

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
};

const user = { id: 'google-user-id', email: 'Jane@example.com', user_metadata: { full_name: 'Jane Zeng' } };

test('keeps OAuth return destinations inside the four application sections', () => {
  assert.equal(safeAuthReturnTo('#/knowledge'), '#/knowledge');
  assert.equal(safeAuthReturnTo('https://evil.example'), '#/today');
  assert.equal(safeAuthReturnTo('#/unknown'), '#/today');
});

test('restores a Google identity by immutable id instead of mutable email casing', async () => {
  const auth = createCloudAuth({ auth: { getSession: async () => ({ data: { session: { user } }, error: null }) } });
  const result = await auth.bootstrap();

  assert.equal(result.status, 'authenticated');
  assert.equal(result.account.id, 'google-user-id');
  assert.equal(result.account.email, 'Jane@example.com');
  assert.equal(result.account.auth_mode, 'google');
});

test('starts Google OAuth with minimal profile scopes and a same-origin callback', async () => {
  const calls = [];
  const storage = memoryStorage();
  const auth = createCloudAuth({ auth: {
    signInWithOAuth: async input => { calls.push(input); return { data: {}, error: null }; },
  } }, { storage, location: { origin: 'https://berichmyfriend.com', hash: '#/knowledge' } });

  await auth.startGoogleLogin();

  assert.equal(storage.getItem('berich.cloud.oauth.return-to.v1'), '#/knowledge');
  assert.deepEqual(calls[0], {
    provider: 'google',
    options: {
      redirectTo: 'https://berichmyfriend.com/auth/callback',
      scopes: 'openid email profile',
    },
  });
});

test('exchanges an OAuth code once and removes callback parameters from the address bar', async () => {
  const storage = memoryStorage();
  storage.setItem('berich.cloud.oauth.return-to.v1', '#/spring-wind');
  const replaced = [];
  const auth = createCloudAuth({ auth: {
    exchangeCodeForSession: async code => ({ data: { session: code === 'one-time-code' ? { user } : null }, error: null }),
  } }, {
    storage,
    location: { search: '?code=one-time-code', pathname: '/auth/callback' },
    history: { replaceState: (...args) => replaced.push(args) },
  });

  const result = await auth.completeCallback();
  assert.equal(result.account.id, 'google-user-id');
  assert.equal(storage.getItem('berich.cloud.oauth.return-to.v1'), null);
  assert.equal(replaced.at(-1)[2], '/#/spring-wind');
  await assert.rejects(auth.completeCallback(), /已处理/);
});
