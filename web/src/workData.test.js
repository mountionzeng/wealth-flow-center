import test from 'node:test';
import assert from 'node:assert/strict';
import { addWorkProject, addWorkTask, createWorkState, normalizeWorkState, setWorkTaskCompleted, updateWorkTask } from './workData.js';

test('keeps projects and tasks separate from completion state', () => {
  let state = addWorkProject(createWorkState(), { title: '网站上线', description: '完成第一版' }, new Date('2026-09-27T01:00:00.000Z'));
  state = addWorkTask(state, 1, { title: '检查域名', notes: '确认 HTTPS' }, new Date('2026-09-27T02:00:00.000Z'));
  state = updateWorkTask(state, 1, 1, { title: '检查正式域名', notes: '确认 HTTPS 与跳转' }, new Date('2026-09-27T03:00:00.000Z'));

  assert.equal(state.projects[0].tasks[0].status, 'todo');
  assert.equal(state.projects[0].tasks[0].title, '检查正式域名');

  state = setWorkTaskCompleted(state, 1, 1, true, new Date('2026-09-27T04:00:00.000Z'));
  assert.equal(state.projects[0].tasks[0].status, 'done');
  assert.equal(state.projects[0].tasks[0].completed_at, '2026-09-27T04:00:00.000Z');
});

test('normalizes old or missing work data without inventing records', () => {
  assert.deepEqual(normalizeWorkState(null), createWorkState());
  assert.equal(normalizeWorkState({ projects: [{ id: 4, title: '项目', tasks: [{ id: 9, title: '任务' }] }] }).next_task_id, 10);
});

