import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObsidianTree, firstObsidianPath, taskDraftFromObsidianNote } from './obsidianTree.js';

test('builds an Obsidian-like folder tree and filters by the full path', () => {
  const files = [
    { path: '课程/数据库/第一课.md', name: '第一课' },
    { path: '课程/算法/图.md', name: '图' },
    { path: '首页.md', name: '首页' },
    { path: '附件.png', name: '附件' },
  ];
  const tree = buildObsidianTree(files);
  assert.deepEqual(tree.folders.map(folder => folder.name), ['课程']);
  assert.equal(tree.files[0].path, '首页.md');
  assert.equal(firstObsidianPath(tree), '首页.md');

  const filtered = buildObsidianTree(files, '数据库');
  assert.equal(filtered.folders[0].folders[0].files[0].path, '课程/数据库/第一课.md');
  assert.equal(filtered.files.length, 0);
});

test('derives one schedulable course task from an Obsidian note path', () => {
  assert.deepEqual(taskDraftFromObsidianNote({
    vault_id: 'vault-1',
    vault_name: '硕士课程知识库',
    path: 'CS520_操作系统概论/Module 10: File System Implementation.md',
    title: 'Module 10: File System Implementation',
    content_hash: 'hash-10',
    obsidian_url: 'obsidian://open?vault=x&file=y',
  }), {
    source_key: 'vault-1:CS520_操作系统概论/Module 10: File System Implementation.md',
    vault_id: 'vault-1',
    path: 'CS520_操作系统概论/Module 10: File System Implementation.md',
    course_name: 'CS520_操作系统概论',
    title: 'Module 10: File System Implementation',
    source_link: 'obsidian://open?vault=x&file=y',
    content_hash: 'hash-10',
  });

  assert.equal(taskDraftFromObsidianNote({
    vault_id: 'vault-1', vault_name: '硕士课程知识库', path: '首页.md', title: '首页',
  }).course_name, '硕士课程知识库');
});
