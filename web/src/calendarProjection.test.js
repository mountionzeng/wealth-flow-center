import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCalendarProjection } from './calendarProjection.js';

const projection = state => ({
  entity_id: 'body-1',
  operation_id: 'plan-body-1',
  state,
  kind: 'plan',
  title: '养身｜散步',
  start: '2026-08-05T10:00:00',
  end: '2026-08-05T10:20:00',
});

test('ambiguous writes reconcile without blindly writing again', async () => {
  let writes = 0;
  const bridge = {
    reconcileCalendar: async () => ({ status: 'retryable_failure', matches: 0, operation_id: 'plan-body-1' }),
    writeCalendar: async () => { writes += 1; return { status: 'succeeded' }; },
  };

  const outcome = await resolveCalendarProjection(bridge, projection('ambiguous'));

  assert.equal(outcome.result.status, 'retryable_failure');
  assert.equal(outcome.wrote, false);
  assert.equal(writes, 0);
});

test('retryable writes reuse the stable operation id after a zero-match reconcile', async () => {
  const calls = [];
  const bridge = {
    reconcileCalendar: async input => { calls.push(['reconcile', input]); return { status: 'retryable_failure', matches: 0, operation_id: input.operation_id }; },
    writeCalendar: async input => { calls.push(['write', input]); return { status: 'succeeded', event_id: 'event-1', operation_id: input.operation_id }; },
  };

  const outcome = await resolveCalendarProjection(bridge, projection('retryable_failure'));

  assert.equal(outcome.result.status, 'succeeded');
  assert.equal(outcome.wrote, true);
  assert.deepEqual(calls.map(call => call[0]), ['reconcile', 'write']);
  assert.equal(calls[0][1].operation_id, 'plan-body-1');
  assert.equal(calls[1][1].operation_id, 'plan-body-1');
});

test('a successful reconciliation never creates another event', async () => {
  let writes = 0;
  const bridge = {
    reconcileCalendar: async () => ({ status: 'succeeded', operation_id: 'plan-body-1' }),
    writeCalendar: async () => { writes += 1; return { status: 'succeeded' }; },
  };

  const outcome = await resolveCalendarProjection(bridge, projection('retryable_failure'));

  assert.equal(outcome.result.status, 'succeeded');
  assert.equal(outcome.wrote, false);
  assert.equal(writes, 0);
});
