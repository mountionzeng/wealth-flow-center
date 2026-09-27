import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklyTimeline, buildWorkTimeline } from './weeklyTimeline.js';

test('builds seven local calendar days and combines check-ins, advice completions, and quests', () => {
  const days = buildWeeklyTimeline({
    now: new Date(2026, 8, 25, 20, 30),
    quests: [{ id: 7, status: 'done', title: '操作系统复习', course_name: 'CS520', completed_at: '2026-09-24 18:40', actual_duration_minutes: 45 }],
    daily: {
      check_ins: [{ id: 'ci', date: '2026-09-25', discomfort: '肩颈' }],
      advice: [{ date: '2026-09-25', suggestions: [{ id: 'body-1', kind: 'body', title: '晚间舒展' }] }],
      completions: [{ id: 'done-1', source_id: 'body-1', actual_end: '2026-09-25 19:15', actual_duration_minutes: 12, feeling: '肩背松开了' }],
    },
  });

  assert.equal(days.length, 7);
  assert.equal(days[0].key, '2026-09-19');
  assert.equal(days[6].key, '2026-09-25');
  assert.equal(days[6].label, '今天');
  assert.deepEqual(days[5].entries.map(item => item.title), ['操作系统复习']);
  assert.deepEqual(days[6].entries.map(item => item.title), ['晚间舒展', '身体签到']);
  assert.equal(days[6].entries[0].minutes, 12);
  assert.equal(days[6].entries[0].kind, 'body');
});

test('keeps empty days visible and ignores plans that were not completed', () => {
  const days = buildWeeklyTimeline({
    now: new Date(2026, 8, 25, 8, 0),
    quests: [{ id: 1, status: 'todo', title: '尚未完成', start: '2026-09-25 10:00' }],
    daily: { plans: [{ id: 'plan', suggestion_id: 'learning-1', status: 'confirmed' }] },
  });

  assert.ok(days.every(day => day.entries.length === 0));
});

test('builds a separate work timeline from completed work tasks only', () => {
  const days = buildWorkTimeline({
    now: new Date(2026, 8, 27, 12, 0),
    work: {
      projects: [{ id: 3, title: '网站上线', tasks: [
        { id: 7, title: '检查域名', status: 'done', completed_at: '2026-09-27T09:30:00.000Z' },
        { id: 8, title: '尚未完成', status: 'todo', completed_at: '' },
      ] }],
    },
  });

  assert.equal(days[6].entries.length, 1);
  assert.equal(days[6].entries[0].title, '检查域名');
  assert.equal(days[6].entries[0].detail, '网站上线');
  assert.equal(days[6].entries[0].kind, 'work');
});
