import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMigrationSummary, summariesMatch } from './migrationSummary.js';

const state = {
  schema_version: 2,
  quests: [
    { id: 1, status: 'done', actual_duration_minutes: 3461, completed_at: '2026-09-09T08:00:00.000Z' },
    { id: 2, status: 'planned', planned_duration_minutes: 30 },
  ],
  daily_balance: { check_ins: [{ id: 'c1', date: '2026-09-10' }], spring_wind: { report: { content: 'private text' } } },
  knowledge_base: { notes: [{ id: 1, content: 'private note', review_cards: [{ id: 'card', question: '问题', answer: '答案' }] }] },
};

test('creates a content-free migration summary with counts, minutes and freshness', async () => {
  const summary = await buildMigrationSummary(state);

  assert.equal(summary.total_minutes, 3461);
  assert.equal(summary.categories.learning_records.count, 2);
  assert.equal(summary.categories.body_check_ins.count, 1);
  assert.equal(summary.categories.spring_wind_reports.count, 1);
  assert.equal(summary.categories.knowledge_notes.count, 1);
  assert.equal(summary.categories.review_cards.count, 1);
  assert.equal(JSON.stringify(summary).includes('private text'), false);
  assert.equal(JSON.stringify(summary).includes('private note'), false);
  assert.match(summary.content_hash, /^[a-f0-9]{64}$/);
});

test('compares migration summaries by canonical hash and visible counts', async () => {
  const first = await buildMigrationSummary(state);
  const same = await buildMigrationSummary(structuredClone(state));
  const changed = structuredClone(state);
  changed.knowledge_base.notes[0].content = 'different private note';
  const different = await buildMigrationSummary(changed);

  assert.equal(summariesMatch(first, same), true);
  assert.equal(summariesMatch(first, different), false);
});
