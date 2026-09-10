import test from 'node:test';
import assert from 'node:assert/strict';
import { saveDraftBeforeNoteSelection } from './obsidianNavigation.js';

test('saves a dirty Obsidian draft before selecting another note', async () => {
  const note = { path: '课程/第一课.md', content: '磁盘内容' };
  let draft = '网页里的修改';
  const savedContents = [];

  const ready = await saveDraftBeforeNoteSelection({
    note,
    getCurrentNote: () => note,
    getDraft: () => draft,
    save: async content => {
      savedContents.push(content);
      return { ...note, content };
    },
  });

  assert.equal(ready, true);
  assert.deepEqual(savedContents, ['网页里的修改']);
});

test('keeps the current note selected when saving fails or a newer draft appears', async () => {
  const note = { path: '课程/第一课.md', content: '磁盘内容' };
  let draft = '准备保存的修改';

  assert.equal(await saveDraftBeforeNoteSelection({
    note,
    getCurrentNote: () => note,
    getDraft: () => draft,
    save: async () => null,
  }), false);

  assert.equal(await saveDraftBeforeNoteSelection({
    note,
    getCurrentNote: () => note,
    getDraft: () => draft,
    save: async content => {
      draft = '保存期间继续输入的新内容';
      return { ...note, content };
    },
  }), false);
});

test('selects immediately when the current note has no edits', async () => {
  const note = { path: '课程/第一课.md', content: '磁盘内容' };
  let saveCalls = 0;

  const ready = await saveDraftBeforeNoteSelection({
    note,
    getCurrentNote: () => note,
    getDraft: () => note.content,
    save: async () => { saveCalls += 1; },
  });

  assert.equal(ready, true);
  assert.equal(saveCalls, 0);
});
