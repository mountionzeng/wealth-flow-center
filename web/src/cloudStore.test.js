import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudStore } from './cloudStore.js';

test('maps Supabase RPC results without accepting a browser-supplied owner id', async () => {
  const calls = [];
  const store = createCloudStore({ rpc: async (name, args = {}) => {
    calls.push({ name, args });
    return { data: name === 'cloud_read_account_state'
      ? [{ status: 'ready', generation: 1, revision: 2, schema_version: 1, snapshot: { schema_version: 1 } }]
      : [{ status: 'applied', generation: 1, revision: 3 }], error: null };
  } });

  const state = await store.read();
  await store.write({ operationId: 'operation-1', expectedRevision: 2, generation: 1, snapshot: { schema_version: 1 }, payloadHash: 'hash-1' });

  assert.equal(state.revision, 2);
  assert.equal(calls[0].name, 'cloud_read_account_state');
  assert.equal(Object.hasOwn(calls[1].args, 'owner_id'), false);
  assert.equal(calls[1].args.p_operation_id, 'operation-1');
});
