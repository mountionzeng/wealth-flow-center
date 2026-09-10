import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createCloudSync } from './cloudSync.js';
import { createGoogleAccountRepository } from './accountRepository.js';
import { createIndexedDbAccountStore } from './indexedDbAccountStore.js';

const snapshot = title => ({
  schema_version: 1, player: {}, next_id: 1, quests: [{ id: 1, title }],
  daily_balance: { check_ins: [], advice: [], plans: [], completions: [], projections: [], calendar_preferences: { selected_calendars: [] }, consent: { purposes: {} }, spring_wind: null },
  knowledge_base: { version: 1, next_id: 1, notes: [], task_drafts: [], notifications: { last_notified_date: '' } },
});

const makeRepository = () => createGoogleAccountRepository({
  userId: 'google-user-a',
  store: createIndexedDbAccountStore({ indexedDB, dbName: `berich-sync-${crypto.randomUUID()}` }),
});

test('keeps an offline change durable until one acknowledged cloud write', async () => {
  const repository = makeRepository();
  const writes = [];
  const sync = createCloudSync({
    repository,
    remote: { write: async input => { writes.push(input); return { status: 'applied', revision: 1, generation: 1 }; } },
    createOperationId: () => 'operation-1',
  });

  await sync.queueSnapshot(snapshot('offline edit'), { device: 'Mac' });
  assert.equal((await repository.load()).outbox.length, 1);
  await sync.flush();

  assert.equal(writes.length, 1);
  assert.equal((await repository.load()).outbox.length, 0);
  assert.equal(sync.state().status, 'synced');
});

test('preserves a CAS conflict without silently dequeuing the local candidate', async () => {
  const repository = makeRepository();
  const sync = createCloudSync({
    repository,
    remote: { write: async () => ({ status: 'conflict', revision: 4, generation: 1, conflict_id: 'conflict-1', snapshot: snapshot('remote edit') }) },
    createOperationId: () => 'operation-2',
  });

  await sync.queueSnapshot(snapshot('local edit'), {});
  await sync.flush();

  assert.equal(sync.state().status, 'conflict');
  assert.equal(sync.state().conflictId, 'conflict-1');
  assert.equal((await repository.load()).outbox.length, 1);
});

test('quarantines an old outbox after the server reports a stale deletion generation', async () => {
  const repository = makeRepository();
  const sync = createCloudSync({
    repository,
    remote: { write: async () => { const error = new Error('stale cloud generation'); error.code = 'stale_generation'; throw error; } },
    createOperationId: () => 'operation-3',
  });

  await sync.queueSnapshot(snapshot('old device edit'), {});
  await sync.flush();

  assert.equal(sync.state().status, 'quarantined');
  assert.equal((await repository.load()).outbox.length, 0);
});
