import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalBridge } from './localBridge.js';

const response = (status, value) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return JSON.stringify(value); },
});

test('bridge sends process capability and purpose-limited JSON', async () => {
  const calls = [];
  const bridge = createLocalBridge({
    capability: 'token-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { ok: true, status: 'succeeded', events: [] });
    },
  });

  await bridge.calendarHistory(['学习']);

  assert.equal(calls[0].options.headers['X-Berich-Capability'], 'token-1');
  assert.deepEqual(JSON.parse(calls[0].options.body), { calendars: ['学习'] });
});

test('bridge maps unavailable and privacy-safe server errors', async () => {
  const bridge = createLocalBridge({ capability: 'token', fetchImpl: async () => response(503, { ok: false, error: 'provider_unavailable' }) });
  await assert.rejects(bridge.dailyAdvice({}), /provider_unavailable/);
});

test('calendar business statuses remain structured for reconciliation', async () => {
  const statuses = ['ambiguous', 'permission_denied', 'retryable_failure', 'unavailable'];
  for (const status of statuses) {
    const bridge = createLocalBridge({ capability: 'token', fetchImpl: async () => response(200, { ok: false, status, operation_id: 'op-1' }) });
    const result = await bridge.writeCalendar({ operation_id: 'op-1' });
    assert.equal(result.status, status);
    assert.equal(result.operation_id, 'op-1');
  }
});

test('missing bootstrap capability exposes setup state without a request', async () => {
  let called = false;
  const bridge = createLocalBridge({ capability: '', fetchImpl: async () => { called = true; } });
  await assert.rejects(bridge.listCalendars(), /bridge_unavailable/);
  assert.equal(called, false);
});

test('city search sends only the explicit city query and saved provider candidate id', async () => {
  let captured;
  const bridge = createLocalBridge({
    capability: 'token',
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return response(200, { ok: true, location: { status: 'confirmed' } });
    },
  });

  await bridge.searchCity({ query: '北京 通州', selected_id: 'openmeteo:one' });

  assert.equal(captured.url, '/api/environment/search');
  assert.deepEqual(captured.body, { query: '北京 通州', selected_id: 'openmeteo:one' });
});

test('legacy state is available only through the authenticated local bridge', async () => {
  const calls = [];
  const bridge = createLocalBridge({
    capability: 'cap',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true, data: { quests: [{ id: 1 }] } }), { status: 200 });
    },
  });
  const result = await bridge.legacyState();
  assert.deepEqual(result.data.quests, [{ id: 1 }]);
  assert.equal(calls[0].url, '/api/state');
  assert.equal(calls[0].options.headers['X-Berich-Capability'], 'cap');
});

test('knowledge refinement sends only the selected note and new material', async () => {
  let captured;
  const bridge = createLocalBridge({
    capability: 'cap',
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ ok: true, result: { addition_markdown: '新增内容' } }), { status: 200 });
    },
  });
  await bridge.refineKnowledge({
    note: { title: '系统思考', content: '原笔记' },
    material: { label: '课程', text: '新素材' },
  });
  assert.equal(captured.url, '/api/ai/knowledge-refine');
  assert.deepEqual(captured.body.note, { title: '系统思考', content: '原笔记' });
  assert.deepEqual(captured.body.material, { label: '课程', text: '新素材' });
});

test('Obsidian bridge uses the active local vault without exposing arbitrary file paths', async () => {
  const calls = [];
  const bridge = createLocalBridge({
    capability: 'cap',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      return response(200, { ok: true, data: {} });
    },
  });

  await bridge.listObsidianVaults();
  await bridge.loadObsidianTree('vault-1');
  await bridge.readObsidianNote('vault-1', '课程/第一课.md');
  await bridge.writeObsidianNote({ vaultId: 'vault-1', path: '课程/第一课.md', content: '新内容', expectedHash: 'hash-1' });

  assert.deepEqual(calls, [
    { url: '/api/obsidian/vaults', body: null },
    { url: '/api/obsidian/tree', body: { vault_id: 'vault-1' } },
    { url: '/api/obsidian/read', body: { vault_id: 'vault-1', path: '课程/第一课.md' } },
    { url: '/api/obsidian/write', body: { vault_id: 'vault-1', path: '课程/第一课.md', content: '新内容', expected_hash: 'hash-1' } },
  ]);
});

test('Obsidian conflicts keep a readable message and stable error code', async () => {
  const bridge = createLocalBridge({
    capability: 'cap',
    fetchImpl: async () => response(409, { ok: false, error: 'obsidian_conflict', message: '文件已在 Obsidian 中修改' }),
  });
  await assert.rejects(
    bridge.writeObsidianNote({ vaultId: 'v', path: 'a.md', content: 'draft', expectedHash: 'old' }),
    error => error.code === 'obsidian_conflict' && error.message === '文件已在 Obsidian 中修改',
  );
});

test('review card generation sends only the selected Obsidian note', async () => {
  let captured;
  const bridge = createLocalBridge({
    capability: 'cap',
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return response(200, { ok: true, result: { review_cards: [] } });
    },
  });
  await bridge.generateKnowledgeCards({ note: { title: '第一课', content: '正文' } });
  assert.deepEqual(captured, {
    url: '/api/ai/knowledge-cards',
    body: { note: { title: '第一课', content: '正文' } },
  });
});
