const clean = value => String(value || '').trim();

export const buildObsidianTree = (files, query = '') => {
  const needle = clean(query).toLocaleLowerCase();
  const root = { type: 'folder', name: '', path: '', children: new Map(), files: [] };
  for (const raw of Array.isArray(files) ? files : []) {
    const path = clean(raw?.path).replace(/^\/+/, '');
    if (!path.toLocaleLowerCase().endsWith('.md')) continue;
    if (needle && !path.toLocaleLowerCase().includes(needle)) continue;
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    let parent = root;
    for (const part of parts) {
      const folderPath = parent.path ? `${parent.path}/${part}` : part;
      if (!parent.children.has(part)) parent.children.set(part, { type: 'folder', name: part, path: folderPath, children: new Map(), files: [] });
      parent = parent.children.get(part);
    }
    parent.files.push({ ...raw, type: 'file', path, name: clean(raw?.name) || fileName.replace(/\.md$/i, '') });
  }

  const finalize = node => ({
    type: 'folder',
    name: node.name,
    path: node.path,
    folders: [...node.children.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      .map(finalize),
    files: node.files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
  });
  return finalize(root);
};

export const firstObsidianPath = tree => {
  if (!tree) return '';
  if (tree.files?.length) return tree.files[0].path;
  for (const folder of tree.folders || []) {
    const found = firstObsidianPath(folder);
    if (found) return found;
  }
  return '';
};

export const taskDraftFromObsidianNote = note => {
  const path = clean(note?.path).replace(/^\/+/, '');
  const vaultId = clean(note?.vault_id);
  if (!path || !vaultId) return null;
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.at(-1)?.replace(/\.md$/i, '') || '';
  const courseName = parts.length > 1 ? parts[0] : clean(note?.vault_name) || 'Obsidian';
  return {
    source_key: `${vaultId}:${path}`,
    vault_id: vaultId,
    path,
    course_name: courseName,
    title: clean(note?.title) || fileName || '未命名单元',
    source_link: clean(note?.obsidian_url),
    content_hash: clean(note?.content_hash),
  };
};
