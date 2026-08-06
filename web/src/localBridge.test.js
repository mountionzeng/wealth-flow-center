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
