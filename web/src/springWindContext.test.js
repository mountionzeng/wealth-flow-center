import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpringWindContext } from './springWindContext.js';

const dailyFixture = () => ({
  check_ins: [
    { id: 'ci-old', date: '2026-06-01', sleep: 2, energy: 2, mood: 3, discomfort: '肩颈', note: '旧记录' },
    { id: 'ci-new', date: '2026-08-04', sleep: 4, energy: 3, mood: 4, discomfort: '无明显不适', note: '昨晚睡得不错' },
  ],
  advice: [
    { id: 'a-old', date: '2026-06-01', suggestions: [{ id: 's-old', kind: 'learning', title: '旧学习', planned_duration_minutes: 60 }] },
    { id: 'a-one', date: '2026-08-03', suggestions: [{ id: 's-one', kind: 'learning', title: '读书', planned_duration_minutes: 40 }] },
    { id: 'a-two', date: '2026-08-04', suggestions: [{ id: 's-two', kind: 'body', title: '散步', planned_duration_minutes: 30 }] },
  ],
  plans: [
    { id: 'p-old', suggestion_id: 's-old', planned_duration_minutes: 60, status: 'completed' },
    { id: 'p-one', suggestion_id: 's-one', planned_duration_minutes: 40, status: 'completed' },
    { id: 'p-two', suggestion_id: 's-two', planned_duration_minutes: 30, status: 'completed' },
  ],
  completions: [
    { id: 'c-old', source_id: 's-old', actual_duration_minutes: 50, variance_minutes: -10, completed_at: '2026-06-01 10:00', feeling: '旧感受' },
    { id: 'c-one', source_id: 's-one', actual_duration_minutes: 25, variance_minutes: -15, completed_at: '2026-08-03 10:00', feeling: '专注' },
    { id: 'c-two', source_id: 's-two', actual_duration_minutes: 18, variance_minutes: -12, completed_at: '2026-08-04 18:00', feeling: '舒服' },
  ],
  projections: [{ operation_id: 'secret-projection', event_id: 'secret-event' }],
  calendar_preferences: { selected_calendars: ['已选择'] },
});

test('context keeps 30-day details, full-history summaries and real-vs-plan variance', () => {
  const context = buildSpringWindContext({
    dailyBalance: dailyFixture(),
    quests: [],
    calendarEvents: [],
    allowedCategories: ['body_history', 'learning_history'],
    now: new Date('2026-08-05T12:00:00+08:00'),
  });

  assert.equal(context.window.start, '2026-07-07');
  assert.equal(context.window.end, '2026-08-05');
  assert.equal(context.body.recent_check_ins.length, 1);
  assert.equal(context.execution.recent.length, 2);
  assert.equal(context.execution.recent.find(row => row.source_id === 's-one').planned_minutes, 40);
  assert.equal(context.execution.recent.find(row => row.source_id === 's-one').actual_minutes, 25);
  assert.equal(context.execution.recent.find(row => row.source_id === 's-one').variance_minutes, -15);
  assert.equal(context.history_summary.completion_count, 3);
  assert.equal(context.history_summary.actual_minutes, 93);
  assert.equal(context.manifest.samples.recent_completions, 2);
  assert.equal(context.manifest.samples.all_completions, 3);
  assert.equal(Object.hasOwn(context, 'claims'), false);
});

test('revoked or omitted categories do not enter the payload', () => {
  const context = buildSpringWindContext({
    dailyBalance: dailyFixture(),
    quests: [{ id: 1, title: '私人课程', status: 'done', completed_at: '2026-08-04 12:00', actual_duration_minutes: 40 }],
    calendarEvents: [{ calendar_name: '已选择', title: '私人事项', start: '2026-08-04T10:00:00', end: '2026-08-04T11:00:00', duration_minutes: 60 }],
    allowedCategories: ['body_history'],
    now: new Date('2026-08-05T12:00:00+08:00'),
  });

  assert.ok(context.body);
  assert.equal(context.learning, undefined);
  assert.deepEqual(context.execution.recent.map(row => row.kind), ['body']);
  assert.equal(context.calendar, undefined);
  assert.deepEqual(context.manifest.included, ['body_history']);
  assert.deepEqual(context.manifest.omitted, ['learning_history', 'calendar_history']);
  assert.doesNotMatch(JSON.stringify(context), /私人课程|私人事项|secret-projection|secret-event/);
});

test('calendar input is allowlisted to five fields and free text is bounded', () => {
  const context = buildSpringWindContext({
    dailyBalance: dailyFixture(),
    quests: [],
    calendarEvents: [{
      calendar_name: '学习', title: 'A'.repeat(500), start: '2026-08-04T10:00:00',
      end: '2026-08-04T11:00:00', duration_minutes: 60,
      location: '家', attendees: ['secret'], notes: 'secret', url: 'https://secret.example',
    }],
    allowedCategories: ['calendar_history'],
    now: new Date('2026-08-05T12:00:00+08:00'),
  });

  assert.deepEqual(Object.keys(context.calendar.events[0]).sort(), ['calendar_name', 'duration_minutes', 'end', 'start', 'title']);
  assert.equal(context.calendar.events[0].title.length, 160);
  assert.doesNotMatch(JSON.stringify(context), /location|attendees|notes|secret\.example/);
});

test('large history remains bounded while full totals remain available', () => {
  const daily = dailyFixture();
  for (let index = 0; index < 500; index += 1) {
    const day = String((index % 5) + 1).padStart(2, '0');
    daily.check_ins.push({ id: `bulk-${index}`, date: `2026-08-${day}`, sleep: 3, energy: 3, mood: 3, discomfort: '', note: 'x'.repeat(500) });
  }
  const context = buildSpringWindContext({
    dailyBalance: daily,
    quests: [],
    calendarEvents: [],
    allowedCategories: ['body_history'],
    now: new Date('2026-08-05T12:00:00+08:00'),
  });

  assert.equal(context.body.recent_check_ins.length, 30);
  assert.equal(context.body.recent_check_ins.every(row => row.note.length <= 240), true);
  assert.equal(context.history_summary.check_in_count, 502);
  assert.ok(JSON.stringify(context).length < 20_000);
});
