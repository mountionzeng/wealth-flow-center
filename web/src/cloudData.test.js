import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudContentHash, mergeCloudSnapshot, splitAccountState, validateCloudSnapshot } from './cloudData.js';

const accountFixture = () => ({
  schema_version: 2,
  revision: 19,
  player: { level: 3, total_minutes: 90 },
  next_id: 8,
  quests: [{ id: 7, title: 'Module 7', status: 'done', actual_duration_minutes: 90, task_type: 'course' }],
  daily_balance: {
    check_ins: [{ id: 'checkin-1', date: '2026-09-10', sleep: 4, energy: 3, mood: 4, discomfort: '', note: '肩颈紧' }],
    advice: [], plans: [], completions: [],
    projections: [{ entity_id: 'plan-1', operation_id: 'calendar-op-1', event_id: 'calendar-event-private', state: 'succeeded' }],
    calendar_preferences: { selected_calendars: ['calendar-private'] },
    consent: { purposes: { daily_advice: { granted: true, provider_name: 'DeepSeek', operation: 'chat', purpose: 'daily_advice', categories: ['body_check_in'], fields_version: 'v1', terms_version: 'v1' } } },
    spring_wind: {
      profile: { bazi: '甲子 乙丑', birth_city: '杭州', current_city: '上海', question: '今天该怎么安排？' },
      locations: { birth: { id: 'birth-provider-id' }, current: { id: 'current-provider-id' } },
      report: { content: '保持平衡' },
    },
  },
  knowledge_base: {
    version: 1, next_id: 2,
    notes: [{
      id: 1, title: '文件系统', content: 'inode 是索引节点', created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-02T00:00:00.000Z',
      sources: [{ id: 'source-1', label: '本地原文', excerpt: '...', link: 'obsidian://open?vault=private&file=CS583%2Fmodule.md', captured_at: '2026-09-01T00:00:00.000Z' }],
      revisions: [], review_cards: [{ id: 'card-1', question: 'inode 是什么？', answer: '索引节点', source_link: 'obsidian://open?vault=private&file=CS583%2Fmodule.md', source_label: '本地原文' }],
      review: { due_date: '2026-09-10', interval_days: 0, last_reviewed_at: '', last_grade: '', card_cursor: 0 },
    }],
    task_drafts: [{ source_key: 'private-source-key', vault_id: 'private-vault', path: 'CS583/module.md', title: 'Module 7', source_link: 'obsidian://open?vault=private&file=CS583%2Fmodule.md', course_name: 'CS583', content_hash: 'hash', save_count: 1, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-02T00:00:00.000Z' }],
    notifications: { last_notified_date: '2026-09-10' },
  },
  device_only: { ai_key: 'sk-never-upload' },
});

test('splits Calendar, AI and Obsidian connection fields out of the cloud snapshot', () => {
  const { snapshot, overlay } = splitAccountState(accountFixture());
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.schema_version, 1);
  assert.equal(serialized.includes('calendar-event-private'), false);
  assert.equal(serialized.includes('calendar-private'), false);
  assert.equal(serialized.includes('birth-provider-id'), false);
  assert.equal(serialized.includes('obsidian://'), false);
  assert.equal(serialized.includes('private-vault'), false);
  assert.equal(serialized.includes('sk-never-upload'), false);
  assert.equal(snapshot.knowledge_base.notes[0].content, 'inode 是索引节点');
  assert.equal(overlay.daily_balance.calendar_preferences.selected_calendars[0], 'calendar-private');
  assert.equal(overlay.knowledge.task_drafts[0].vault_id, 'private-vault');
});

test('round-trips portable state while applying the current device overlay', () => {
  const original = accountFixture();
  const { snapshot, overlay } = splitAccountState(original);
  const restored = mergeCloudSnapshot(snapshot, overlay);

  assert.equal(restored.quests[0].status, 'done');
  assert.equal(restored.quests[0].actual_duration_minutes, 90);
  assert.equal(restored.daily_balance.spring_wind.profile.current_city, '上海');
  assert.equal(restored.daily_balance.calendar_preferences.selected_calendars[0], 'calendar-private');
  assert.equal(restored.knowledge_base.notes[0].sources[0].link.startsWith('obsidian://'), true);
  assert.equal(restored.knowledge_base.task_drafts[0].path, 'CS583/module.md');
});

test('merges the same cloud state with each device own Calendar and Obsidian overlay', () => {
  const { snapshot, overlay } = splitAccountState(accountFixture());
  const secondDevice = structuredClone(overlay);
  secondDevice.daily_balance.calendar_preferences.selected_calendars = ['calendar-on-other-device'];
  secondDevice.knowledge.task_drafts = [];

  assert.deepEqual(mergeCloudSnapshot(snapshot, overlay).daily_balance.calendar_preferences.selected_calendars, ['calendar-private']);
  assert.deepEqual(mergeCloudSnapshot(snapshot, secondDevice).daily_balance.calendar_preferences.selected_calendars, ['calendar-on-other-device']);
  assert.equal(mergeCloudSnapshot(snapshot, secondDevice).knowledge_base.task_drafts.length, 0);
});

test('hashes content canonically instead of relying on category counts', async () => {
  const first = splitAccountState(accountFixture()).snapshot;
  const second = structuredClone(first);
  second.knowledge_base.notes[0].content = 'inode 的另一种解释';

  assert.notEqual(await cloudContentHash(first), await cloudContentHash(second));
});

test('rejects corrupted and unsupported cloud snapshots before they replace local data', () => {
  assert.throws(() => validateCloudSnapshot({ schema_version: 99 }), /版本/);
  assert.throws(() => validateCloudSnapshot({ schema_version: 1, quests: 'not-an-array' }), /无效/);
});
