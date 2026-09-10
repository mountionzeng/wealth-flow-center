import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createGoogleAccountRepository } from './accountRepository.js';
import { createIndexedDbAccountStore } from './indexedDbAccountStore.js';

const repository = userId => createGoogleAccountRepository({
  userId,
  store: createIndexedDbAccountStore({ indexedDB, dbName: `berich-repository-${crypto.randomUUID()}` }),
});

test('queues a local Google edit with its snapshot and device overlay before reporting success', async () => {
  const repo = repository('google-user-a');
  const saved = await repo.saveLocalChange({
    snapshot: { schema_version: 1, quests: [{ id: 7, title: 'Module 7' }] },
    overlay: { device: 'MacBook' },
    operation: { id: 'operation-7', base_revision: 0, payload_hash: 'hash-7' },
  });

  assert.equal(saved.outbox.length, 1);
  assert.equal(saved.outbox[0].id, 'operation-7');
  assert.equal((await repo.load()).snapshot.quests[0].title, 'Module 7');
});

test('accepts a cloud confirmation only for the active user and acknowledged operation', async () => {
  const repo = repository('google-user-a');
  await repo.saveLocalChange({ snapshot: { schema_version: 1 }, overlay: {}, operation: { id: 'operation-1', payload_hash: 'hash-1' } });

  await repo.confirmCloudWrite({ operationId: 'operation-1', revision: 2, generation: 1 });
  const state = await repo.load();
  assert.equal(state.outbox.length, 0);
  assert.equal(state.revision, 2);
  await assert.rejects(repo.confirmCloudWrite({ operationId: 'another-operation', revision: 3, generation: 1 }), /待同步/);
});
