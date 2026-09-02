import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addKnowledgeNote,
  appendKnowledgeAddition,
  createKnowledgeState,
  normalizeKnowledgeState,
  recordKnowledgeReview,
  removeObsidianTaskDraft,
  selectDailyKnowledgeReview,
  storeObsidianReviewCards,
  upsertObsidianTaskDraft,
} from './knowledgeData.js';

test('AI material is appended without rewriting the existing note', () => {
  const now = new Date('2026-09-02T09:00:00+08:00');
  let state = addKnowledgeNote(createKnowledgeState(), { title: '复杂系统', content: '原始判断：反馈回路影响系统行为。' }, now);
  const original = state.notes[0].content;
  state = appendKnowledgeAddition(state, state.notes[0].id, {
    source_label: '课程第三讲',
    source_text: '延迟会让反馈难以观察。',
    addition_markdown: '延迟可能掩盖反馈回路，应同时记录时间尺度。',
    review_cards: [{ question: '为什么要记录时间尺度？', answer: '因为延迟会掩盖反馈。' }],
  }, now);
  assert.ok(state.notes[0].content.startsWith(original));
  assert.match(state.notes[0].content, /增补 · 课程第三讲/);
  assert.equal(state.notes[0].revisions[0].content, original);
  assert.equal(state.notes[0].sources[0].excerpt, '延迟会让反馈难以观察。');
});

test('daily review card becomes due and reschedules from the chosen grade', () => {
  const now = new Date('2026-09-02T09:00:00+08:00');
  let state = addKnowledgeNote(createKnowledgeState(), { title: '复利', content: '长期重复带来复利。' }, now);
  const review = selectDailyKnowledgeReview(state, now);
  assert.equal(review.note_title, '复利');
  assert.match(review.card.question, /复利/);
  state = recordKnowledgeReview(state, review.note_id, 'good', now);
  assert.equal(state.notes[0].review.due_date, '2026-09-05');
  assert.equal(selectDailyKnowledgeReview(state, now), null);
});

test('legacy backups gain an empty knowledge base without losing compatibility', () => {
  assert.deepEqual(normalizeKnowledgeState(undefined), createKnowledgeState());
});

test('an Obsidian-imported bottom keeps its source link for later review cards', () => {
  const state = addKnowledgeNote(createKnowledgeState(), {
    title: '来自 Obsidian', content: '原文内容', source_label: 'Vault/原文', source_text: '原文内容', source_link: 'obsidian://open?vault=Vault&file=原文',
  }, new Date('2026-09-02T09:00:00+08:00'));
  assert.equal(state.notes[0].sources[0].link, 'obsidian://open?vault=Vault&file=原文');
  assert.equal(selectDailyKnowledgeReview(state, new Date('2026-09-02T09:00:00+08:00')).card.source_link, 'obsidian://open?vault=Vault&file=原文');
});

test('generated Obsidian cards keep one review record per source file', () => {
  const now = new Date('2026-09-02T09:00:00+08:00');
  const input = {
    title: '第一课', content: '文件正文', source_label: '课程/第一课',
    source_link: 'obsidian://open?vault=Vault&file=课程%2F第一课',
    review_cards: [{ question: '问题一', answer: '答案一' }],
  };
  let state = storeObsidianReviewCards(createKnowledgeState(), input, now);
  state = storeObsidianReviewCards(state, { ...input, content: '更新后的正文', review_cards: [{ question: '新问题', answer: '新答案' }] }, now);
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].content, '更新后的正文');
  assert.equal(state.notes[0].review_cards[0].question, '新问题');
  assert.equal(selectDailyKnowledgeReview(state, now).card.source_link, input.source_link);
});

test('repeated Obsidian saves update one pending task instead of duplicating it', () => {
  const firstSave = new Date('2026-09-03T09:00:00+08:00');
  const secondSave = new Date('2026-09-03T09:05:00+08:00');
  const draft = {
    source_key: 'vault-1:CS520/Module 10.md', vault_id: 'vault-1', path: 'CS520/Module 10.md',
    course_name: 'CS520', title: 'Module 10', source_link: 'obsidian://open?vault=x&file=y', content_hash: 'hash-1',
  };

  let state = upsertObsidianTaskDraft(createKnowledgeState(), draft, firstSave);
  state = upsertObsidianTaskDraft(state, { ...draft, title: 'Module 10 文件系统', content_hash: 'hash-2' }, secondSave);

  assert.equal(state.task_drafts.length, 1);
  assert.equal(state.task_drafts[0].title, 'Module 10 文件系统');
  assert.equal(state.task_drafts[0].content_hash, 'hash-2');
  assert.equal(state.task_drafts[0].save_count, 2);
  assert.equal(state.task_drafts[0].created_at, firstSave.toISOString());
  assert.equal(state.task_drafts[0].updated_at, secondSave.toISOString());

  state = removeObsidianTaskDraft(state, draft.source_key);
  assert.equal(state.task_drafts.length, 0);
});
