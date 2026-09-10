import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createIndexedDbAccountStore } from './indexedDbAccountStore.js';

const storeFor = name => createIndexedDbAccountStore({ indexedDB, dbName: `berich-test-${name}-${crypto.randomUUID()}` });

test('stores one Google user snapshot, device overlay and outbox atomically', async () => {
  const store = storeFor('atomic');
  await store.commit('google-user-a', {
    snapshot: { schema_version: 1, quests: [{ id: 1 }] },
    overlay: { selected_calendar: 'Calendar A' },
    outbox: [{ id: 'operation-1', snapshot_hash: 'hash-1' }],
    revision: 3,
    generation: 1,
  });

  assert.deepEqual(await store.read('google-user-a'), {
    snapshot: { schema_version: 1, quests: [{ id: 1 }] },
    overlay: { selected_calendar: 'Calendar A' },
    outbox: [{ id: 'operation-1', snapshot_hash: 'hash-1' }],
    revision: 3,
    generation: 1,
  });
});

test('keeps Google users isolated and clears only the requested local mirror', async () => {
  const store = storeFor('isolation');
  await store.commit('google-user-a', { snapshot: { owner: 'A' }, overlay: {}, outbox: [], revision: 1, generation: 1 });
  await store.commit('google-user-b', { snapshot: { owner: 'B' }, overlay: {}, outbox: [], revision: 1, generation: 1 });

  await store.clear('google-user-a');

  assert.equal(await store.read('google-user-a'), null);
  assert.equal((await store.read('google-user-b')).snapshot.owner, 'B');
});

test('rejects an unavailable database and malformed account records without writing partial data', async () => {
  assert.throws(() => createIndexedDbAccountStore({ indexedDB: null }), /IndexedDB/);
  const store = storeFor('validation');
  await assert.rejects(store.commit('', { snapshot: {}, overlay: {}, outbox: [], revision: 1, generation: 1 }), /用户/);
  await assert.rejects(store.commit('google-user-a', { snapshot: {}, overlay: {}, outbox: 'not-an-array', revision: 1, generation: 1 }), /outbox/);
  assert.equal(await store.read('google-user-a'), null);
});
