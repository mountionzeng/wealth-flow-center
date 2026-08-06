import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpringWindInputState, springWindInputReducer } from './springWindInputState.js';

test('typing immediately enters text mode without starting an upload', () => {
  const state = springWindInputReducer(createSpringWindInputState(''), { type: 'typed', value: '甲子' });

  assert.equal(state.mode, 'text');
  assert.equal(state.text, '甲子');
  assert.equal(state.fileName, '');
  assert.equal(state.error, '');
});

test('recognized text returns to the same editable surface', () => {
  let state = createSpringWindInputState('原有文字');
  state = springWindInputReducer(state, { type: 'import_started', fileName: '八字.png' });
  state = springWindInputReducer(state, { type: 'recognition_started' });
  state = springWindInputReducer(state, { type: 'import_succeeded', text: '甲子 丙寅 壬午 辛亥' });

  assert.equal(state.mode, 'editable_result');
  assert.equal(state.text, '甲子 丙寅 壬午 辛亥');
  state = springWindInputReducer(state, { type: 'typed', value: `${state.text} 修正` });
  assert.equal(state.mode, 'text');
  assert.match(state.text, /修正$/);
});

test('failed recognition restores the hand-written text and remains retryable', () => {
  let state = createSpringWindInputState('不要丢掉我');
  state = springWindInputReducer(state, { type: 'import_started', fileName: '坏图.png' });
  state = springWindInputReducer(state, { type: 'recognition_started' });
  state = springWindInputReducer(state, { type: 'import_failed', error: '识别失败' });

  assert.equal(state.mode, 'error');
  assert.equal(state.text, '不要丢掉我');
  assert.equal(state.error, '识别失败');
  state = springWindInputReducer(state, { type: 'clear_error' });
  assert.equal(state.mode, 'text');
  assert.equal(state.text, '不要丢掉我');
});

test('starting a later import snapshots the latest edited text', () => {
  let state = createSpringWindInputState('第一次');
  state = springWindInputReducer(state, { type: 'typed', value: '第二次' });
  state = springWindInputReducer(state, { type: 'import_started', fileName: 'new.txt' });
  state = springWindInputReducer(state, { type: 'import_failed', error: '读取失败' });

  assert.equal(state.text, '第二次');
});

test('typing invalidates a recognition result that finishes later', () => {
  let state = createSpringWindInputState('原文');
  state = springWindInputReducer(state, { type: 'import_started', operationId: 1, fileName: '旧图.png' });
  state = springWindInputReducer(state, { type: 'recognition_started', operationId: 1 });
  state = springWindInputReducer(state, { type: 'typed', value: '用户后来键入的八字' });
  state = springWindInputReducer(state, { type: 'import_succeeded', operationId: 1, text: '迟到的识别结果' });

  assert.equal(state.mode, 'text');
  assert.equal(state.text, '用户后来键入的八字');
});

test('a newer import cannot be overwritten by an older async import', () => {
  let state = createSpringWindInputState('原文');
  state = springWindInputReducer(state, { type: 'import_started', operationId: 1, fileName: '慢图.png' });
  state = springWindInputReducer(state, { type: 'import_started', operationId: 2, fileName: '新文本.txt' });
  state = springWindInputReducer(state, { type: 'import_succeeded', operationId: 2, text: '新文本' });
  state = springWindInputReducer(state, { type: 'import_succeeded', operationId: 1, text: '迟到旧图' });

  assert.equal(state.text, '新文本');
  assert.equal(state.operationId, 2);
});
