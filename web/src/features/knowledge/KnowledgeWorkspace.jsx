import React, { useEffect, useMemo, useRef, useState } from 'react';
import ObsidianMarkdown from '../../components/ObsidianMarkdown.jsx';
import SafeMarkdown from '../../components/SafeMarkdown.jsx';
import { consentMatches } from '../../dailyBalance.js';
import { knowledgeDateKey, selectDailyKnowledgeReview } from '../../knowledgeData.js';
import { DEFAULT_NOTE_VIEW } from '../../obsidianMarkdown.js';
import { buildObsidianTree, firstObsidianPath, taskDraftFromObsidianNote } from '../../obsidianTree.js';

const LAST_NOTE_KEY = 'berich.obsidian.last-note.v1';
const carriesFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');

const errorText = error => {
  if (error?.code === 'bridge_unavailable') return '自动读取只在这台电脑的本机版可用，请打开 127.0.0.1:4318。';
  if (error?.code === 'provider_not_configured') return '本机版还没有配置 AI API key；编辑和保存 Obsidian 不受影响。';
  if (error?.code === 'obsidian_conflict') return error.message;
  if (String(error?.code || '').startsWith('obsidian_')) return error.message || 'Obsidian 笔记操作失败。';
  if (String(error?.message || '').startsWith('provider_')) return 'AI 服务暂时不可用，原笔记和素材均未改动。';
  return error?.message || '处理失败，原笔记没有改动。';
};

const readLastNote = () => {
  try { return JSON.parse(globalThis.localStorage?.getItem(LAST_NOTE_KEY) || '{}'); }
  catch { return {}; }
};

const rememberLastNote = (vaultId, path) => {
  try { globalThis.localStorage?.setItem(LAST_NOTE_KEY, JSON.stringify({ vaultId, path })); }
  catch {}
};

const parentFolders = path => {
  const parts = String(path || '').split('/').slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
};

function FolderBranch({ node, selectedPath, expanded, query, onToggle, onSelect }) {
  const open = Boolean(query) || expanded.has(node.path);
  return <div className="vault-folder">
    <button type="button" className="vault-folder-row" onClick={() => onToggle(node.path)} aria-expanded={open}>
      <span aria-hidden="true">{open ? '⌄' : '›'}</span><strong>{node.name}</strong><small>{node.folders.length + node.files.length}</small>
    </button>
    {open && <div className="vault-folder-children">
      {node.folders.map(folder => <FolderBranch key={folder.path} node={folder} selectedPath={selectedPath} expanded={expanded} query={query} onToggle={onToggle} onSelect={onSelect}/>)}
      {node.files.map(file => <FileRow key={file.path} file={file} selected={selectedPath === file.path} onSelect={onSelect}/>)}
    </div>}
  </div>;
}

function FileRow({ file, selected, onSelect }) {
  return <button type="button" className={`vault-file-row ${selected ? 'active' : ''}`} onClick={() => onSelect(file.path)} title={file.path} disabled={file.oversized}>
    <span aria-hidden="true">◇</span><strong>{file.name}</strong>{file.oversized && <small>过大</small>}
  </button>;
}

function DailyReview({ api, knowledge, setKnowledge, busy, setBusy, notify }) {
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState('');
  const review = useMemo(() => selectDailyKnowledgeReview(knowledge, new Date()), [knowledge]);

  useEffect(() => {
    const today = knowledgeDateKey(new Date());
    if (!review || knowledge.notifications.last_notified_date === today || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      new Notification('今日复习卡已准备好', { body: review.card.question, tag: `berich-review-${today}` });
      api.markKnowledgeNotification(today).then(setKnowledge).catch(() => {});
    } catch {}
  }, [api, knowledge.notifications.last_notified_date, review, setKnowledge]);

  const grade = async value => {
    if (!review) return;
    setBusy('review'); setError('');
    try {
      setKnowledge(await api.recordKnowledgeReview(review.note_id, value));
      setRevealed(false); notify?.('复习结果已记录，下一张卡已排期');
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  };

  const enableNotifications = async () => {
    if (typeof Notification === 'undefined') { setError('当前浏览器不支持系统通知。'); return; }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') setError('通知没有开启；复习卡仍会每天显示在这里。');
    else notify?.('每日复习提醒已开启');
  };

  return <section className="obsidian-review-panel" aria-labelledby="daily-review-title">
    <header><p className="panel-number">DAILY REVIEW</p><h2 id="daily-review-title">今日复习</h2></header>
    {review ? <div className="review-card compact">
      <small>来自《{review.note_title}》</small>
      <strong>{review.card.question}</strong>
      {!revealed ? <button type="button" className="gold-btn" onClick={() => setRevealed(true)}>看答案</button> : <>
        <div className="review-answer"><SafeMarkdown content={review.card.answer}/></div>
        <div className="review-grades"><button type="button" disabled={busy === 'review'} onClick={() => grade('again')}>明天再来</button><button type="button" disabled={busy === 'review'} onClick={() => grade('hard')}>有点模糊</button><button type="button" disabled={busy === 'review'} onClick={() => grade('good')}>记住了</button></div>
      </>}
      {review.card.source_link && <a className="obsidian-link" href={review.card.source_link}>在 Obsidian 打开原文 ↗</a>}
    </div> : <p className="review-empty">今天没有到期的卡片。可以从当前笔记生成一组。</p>}
    {typeof Notification !== 'undefined' && Notification.permission !== 'granted' && <button type="button" className="text-button" onClick={enableNotifications}>开启每日提醒</button>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

export default function KnowledgeWorkspace({ api, dailyAPI, bridge, notify, onScheduleTask, refreshToken = 0 }) {
  const [knowledge, setKnowledge] = useState(() => api.knowledgeState());
  const [daily, setDaily] = useState(() => dailyAPI.state());
  const [provider, setProvider] = useState({ provider_name: '未配置', text_available: false, retention_policy: '', terms_version: 'unknown' });
  const [vaults, setVaults] = useState([]);
  const [vaultId, setVaultId] = useState('');
  const [vault, setVault] = useState(null);
  const [files, setFiles] = useState([]);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [note, setNote] = useState(null);
  const [draft, setDraft] = useState('');
  const [view, setView] = useState(DEFAULT_NOTE_VIEW);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [material, setMaterial] = useState('');
  const [sourceLabel, setSourceLabel] = useState('随手摘录');
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState(null);
  const [allowAI, setAllowAI] = useState(false);
  const [busy, setBusy] = useState('vaults');
  const [status, setStatus] = useState('正在查找这台电脑上的 Obsidian…');
  const [error, setError] = useState('');
  const [pendingCards, setPendingCards] = useState(null);
  const fileRef = useRef(null);
  const editorRef = useRef(null);
  const vaultIdRef = useRef('');
  const noteRef = useRef(null);
  const draftRef = useRef('');
  const readRequestRef = useRef(0);
  const saveRequestRef = useRef(0);

  const dirty = Boolean(note && draft !== note.content);
  const tree = useMemo(() => buildObsidianTree(files, query), [files, query]);
  const currentTaskDraft = useMemo(() => {
    const identity = taskDraftFromObsidianNote(note);
    return identity ? knowledge.task_drafts.find(item => item.source_key === identity.source_key) || null : null;
  }, [knowledge.task_drafts, note]);
  const textScope = useMemo(() => ({
    purpose: 'knowledge_refine', operation: 'text', provider_name: provider.provider_name,
    categories: ['selected_note', 'new_material'], fields_version: 'knowledge-note-v1', terms_version: provider.terms_version,
  }), [provider.provider_name, provider.terms_version]);
  const hasAIConsent = consentMatches(daily.consent.purposes.knowledge_refine, textScope);

  useEffect(() => {
    if (view === 'edit') editorRef.current?.focus();
  }, [view, note?.path]);

  useEffect(() => {
    let active = true;
    bridge.aiDisclosure().then(result => { if (active) setProvider(result.provider || result); }).catch(() => {});
    bridge.listObsidianVaults().then(result => {
      if (!active) return;
      const nextVaults = Array.isArray(result.vaults) ? result.vaults : [];
      setVaults(nextVaults);
      if (!nextVaults.length) {
        setBusy(''); setStatus(''); setError('没有在这台电脑上找到已登记的 Obsidian 知识库。');
        return;
      }
      const nextVaultId = result.active_vault_id || nextVaults[0].id;
      vaultIdRef.current = nextVaultId;
      setVaultId(nextVaultId);
    }).catch(cause => {
      if (active) { setBusy(''); setStatus(''); setError(errorText(cause)); }
    });
    return () => { active = false; };
  }, [bridge]);

  useEffect(() => { setKnowledge(api.knowledgeState()); }, [api, refreshToken]);

  useEffect(() => {
    if (!vaultId) return undefined;
    const requestId = ++readRequestRef.current;
    const requestedVaultId = vaultId;
    vaultIdRef.current = requestedVaultId;
    let active = true;
    setBusy('tree'); setStatus('正在读取 Obsidian 文件目录…'); setError('');
    bridge.loadObsidianTree(requestedVaultId).then(async response => {
      if (!active || requestId !== readRequestRef.current || vaultIdRef.current !== requestedVaultId) return;
      const data = response.data || response;
      const nextFiles = Array.isArray(data.files) ? data.files : [];
      setVault(data.vault || vaults.find(item => item.id === requestedVaultId) || null);
      setFiles(nextFiles);
      setTreeTruncated(Boolean(data.truncated));
      const remembered = readLastNote();
      const rememberedPath = remembered.vaultId === requestedVaultId && nextFiles.some(file => file.path === remembered.path) ? remembered.path : '';
      const nextPath = rememberedPath || firstObsidianPath(buildObsidianTree(nextFiles));
      if (!nextPath) {
        noteRef.current = null; draftRef.current = '';
        setNote(null); setDraft(''); setStatus('这个知识库里没有 Markdown 笔记。'); return;
      }
      const read = await bridge.readObsidianNote(requestedVaultId, nextPath);
      if (!active || requestId !== readRequestRef.current || vaultIdRef.current !== requestedVaultId) return;
      const nextNote = read.data || read;
      noteRef.current = nextNote; draftRef.current = nextNote.content;
      setNote(nextNote); setDraft(nextNote.content); rememberLastNote(requestedVaultId, nextNote.path);
      setExpanded(new Set(parentFolders(nextNote.path)));
      setStatus(data.truncated ? `已载入前 ${nextFiles.length} 篇 Markdown，文件列表已达上限` : `已自动载入 ${nextFiles.length} 篇 Markdown`);
    }).catch(cause => {
      if (active && requestId === readRequestRef.current) {
        noteRef.current = null; draftRef.current = '';
        setNote(null); setDraft(''); setStatus(''); setError(errorText(cause));
      }
    }).finally(() => { if (active && requestId === readRequestRef.current) setBusy(''); });
    return () => { active = false; };
  }, [bridge, vaultId]);

  useEffect(() => {
    const warn = event => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const selectNote = async path => {
    if (!path || path === note?.path) return;
    if (busy === 'save') { setError('正在保存当前笔记，请稍候再切换。'); return; }
    if (dirty && !window.confirm('当前笔记还有未保存的修改。放弃修改并打开另一篇吗？')) return;
    const requestId = ++readRequestRef.current;
    const requestedVaultId = vaultIdRef.current;
    setBusy('read'); setStatus('正在打开笔记…'); setError(''); setPreview(null);
    try {
      const response = await bridge.readObsidianNote(requestedVaultId, path);
      if (requestId !== readRequestRef.current || vaultIdRef.current !== requestedVaultId) return;
      const nextNote = response.data || response;
      noteRef.current = nextNote; draftRef.current = nextNote.content;
      setNote(nextNote); setDraft(nextNote.content); setView(DEFAULT_NOTE_VIEW); rememberLastNote(requestedVaultId, nextNote.path);
      setExpanded(current => new Set([...current, ...parentFolders(nextNote.path)]));
      setStatus('已从本地 Obsidian 读取');
    } catch (cause) {
      if (requestId === readRequestRef.current) { setError(errorText(cause)); setStatus(''); }
    } finally { if (requestId === readRequestRef.current) setBusy(''); }
  };

  const saveContent = async (content, message = '已保存回本地 Obsidian') => {
    const savingNote = noteRef.current;
    if (!savingNote) return null;
    const requestId = ++saveRequestRef.current;
    const requestedVaultId = savingNote.vault_id || vaultIdRef.current;
    const requestedPath = savingNote.path;
    const submittedContent = content;
    const draftAtStart = draftRef.current;
    setBusy('save'); setError(''); setStatus('正在保存…');
    try {
      const response = await bridge.writeObsidianNote({ vaultId: requestedVaultId, path: requestedPath, content: submittedContent, expectedHash: savingNote.content_hash });
      const saved = response.data || response;
      const activeNote = noteRef.current;
      const stillCurrent = requestId === saveRequestRef.current
        && vaultIdRef.current === requestedVaultId
        && activeNote?.path === requestedPath
        && (activeNote.vault_id || requestedVaultId) === requestedVaultId;
      if (stillCurrent) {
        noteRef.current = saved;
        setNote(saved);
        const hasNewerDraft = draftRef.current !== draftAtStart;
        if (!hasNewerDraft) {
          draftRef.current = saved.content;
          setDraft(saved.content);
        }
        let nextStatus = hasNewerDraft ? '已保存刚才的版本；你还有新的未保存修改' : message;
        try {
          const taskDraft = taskDraftFromObsidianNote(saved);
          if (taskDraft) {
            setKnowledge(await api.upsertObsidianTaskDraft(taskDraft));
            nextStatus = hasNewerDraft ? nextStatus : '已保存，并更新待排期学习任务';
          }
        } catch (cause) {
          setError(`笔记已保存，但待排期任务生成失败：${errorText(cause)}`);
        }
        setStatus(nextStatus); notify?.(nextStatus);
      }
      return saved;
    } catch (cause) {
      if (requestId === saveRequestRef.current) {
        setError(errorText(cause)); setStatus('网页草稿仍保留，尚未覆盖磁盘文件。');
      }
      return null;
    } finally { if (requestId === saveRequestRef.current) setBusy(''); }
  };

  const cancelEditing = () => {
    const currentNote = noteRef.current;
    if (!currentNote) return;
    if (dirty && !window.confirm('放弃这次修改，恢复为上次保存的内容吗？')) return;
    draftRef.current = currentNote.content;
    setDraft(currentNote.content);
    setView('preview');
  };

  const finishEditing = async () => {
    if (!dirty) { setView('preview'); return; }
    const saved = await saveContent(draftRef.current);
    if (saved && noteRef.current?.content_hash === saved.content_hash && draftRef.current === saved.content) {
      setView('preview');
    }
  };

  useEffect(() => {
    const shortcut = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault();
        if (dirty && busy !== 'save') void finishEditing();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [busy, dirty, draft, note, view]);

  const reloadCurrent = async () => {
    const currentNote = noteRef.current;
    if (!currentNote) return;
    const requestId = ++readRequestRef.current;
    const requestedVaultId = currentNote.vault_id || vaultIdRef.current;
    const requestedPath = currentNote.path;
    setBusy('read'); setError('');
    try {
      const response = await bridge.readObsidianNote(requestedVaultId, requestedPath);
      if (requestId !== readRequestRef.current || vaultIdRef.current !== requestedVaultId || noteRef.current?.path !== requestedPath) return;
      const nextNote = response.data || response;
      noteRef.current = nextNote; draftRef.current = nextNote.content;
      setNote(nextNote); setDraft(nextNote.content); setStatus('已重新载入磁盘上的版本');
    } catch (cause) { if (requestId === readRequestRef.current) setError(errorText(cause)); }
    finally { if (requestId === readRequestRef.current) setBusy(''); }
  };

  const toggleFolder = path => setExpanded(current => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const switchVault = event => {
    const nextId = event.target.value;
    if (busy === 'save') { setError('正在保存当前笔记，请稍候再切换知识库。'); return; }
    if (dirty && !window.confirm('当前笔记还有未保存的修改。放弃修改并切换知识库吗？')) return;
    readRequestRef.current += 1;
    vaultIdRef.current = nextId;
    noteRef.current = null;
    draftRef.current = '';
    setVaultId(nextId); setQuery(''); setExpanded(new Set()); setNote(null); setDraft(''); setPreview(null);
  };

  const readMaterialFile = async file => {
    setDragging(false); setError(''); setPreview(null);
    if (!file || (!/\.(txt|md|markdown)$/i.test(file.name) && !['text/plain', 'text/markdown'].includes(file.type))) {
      setError('目前支持 TXT 和 Markdown 文件，也可以直接粘贴文字。'); return;
    }
    if (file.size > 1024 * 1024) { setError('单个素材文件不能超过 1 MB。'); return; }
    try {
      const text = (await file.text()).trim().slice(0, 12_000);
      if (!text) throw new Error('文件里没有可读取的文字');
      setMaterial(text); setSourceLabel(file.name.replace(/\.(txt|md|markdown)$/i, '') || '导入文件');
      notify?.('素材已读入，还没有改动 Obsidian 原文');
    } catch (cause) { setError(cause.message || '文件读取失败'); }
  };

  const ensureAIConsent = async () => {
    if (hasAIConsent) return true;
    if (!allowAI) { setError('请先同意把当前笔记和新素材临时发送给你配置的 AI。'); return false; }
    setDaily(await dailyAPI.setConsent('knowledge_refine', { granted: true, ...textScope, granted_at: new Date().toISOString(), revoked_at: '' }));
    return true;
  };

  const refine = async () => {
    if (!note || !material.trim()) { setError('请先打开一篇笔记并放入一段新素材。'); return; }
    if (!provider.text_available) { setError('本机 AI 尚未配置；你仍可以按原文追加。'); return; }
    if (!await ensureAIConsent()) return;
    setBusy('refine'); setError(''); setPreview(null);
    try {
      const response = await bridge.refineKnowledge({
        note: { title: note.title, content: draft },
        material: { label: sourceLabel.trim() || '补充素材', text: material.trim() },
      });
      setPreview(response.result);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  };

  const commitAddition = async addition => {
    if (!note || !addition) return;
    const label = sourceLabel.trim() || '补充素材';
    const nextContent = `${draft.trimEnd()}\n\n## 增补 · ${label}\n\n${addition.addition_markdown.trim()}\n`;
    const saved = await saveContent(nextContent, '增补已写入本地 Obsidian');
    if (!saved) return;
    setMaterial(''); setPreview(null); setPendingCards(null);
    if (addition.review_cards?.length) {
      try {
        setKnowledge(await api.storeObsidianReviewCards({
          title: saved.title, content: saved.content, source_label: saved.path.replace(/\.md$/i, ''),
          source_link: saved.obsidian_url, review_cards: addition.review_cards,
        }));
      } catch {
        setPendingCards({ note: saved, cards: addition.review_cards });
        setError('正文已经写入 Obsidian，但复习卡没能保存在浏览器账号中；可只重试卡片，不会重复追加正文。');
      }
    }
  };

  const retryPendingCards = async () => {
    if (!pendingCards) return;
    setBusy('cards'); setError('');
    try {
      const source = pendingCards.note;
      setKnowledge(await api.storeObsidianReviewCards({
        title: source.title, content: source.content, source_label: source.path.replace(/\.md$/i, ''),
        source_link: source.obsidian_url, review_cards: pendingCards.cards,
      }));
      setPendingCards(null); notify?.('复习卡已保存，没有再次改动 Obsidian 正文');
    } catch (cause) { setError(`正文仍已保存；复习卡重试失败：${errorText(cause)}`); }
    finally { setBusy(''); }
  };

  const generateCards = async () => {
    if (!noteRef.current) return;
    if (!provider.text_available) { setError('本机 AI 尚未配置，暂时不能生成复习卡。'); return; }
    if (!await ensureAIConsent()) return;
    let source = noteRef.current;
    if (draftRef.current !== source.content) {
      source = await saveContent(draftRef.current, '已先保存当前笔记');
      if (!source) return;
    }
    setBusy('cards'); setError('');
    try {
      const response = await bridge.generateKnowledgeCards({ note: { title: source.title, content: source.content } });
      setKnowledge(await api.storeObsidianReviewCards({
        title: source.title, content: source.content, source_label: source.path.replace(/\.md$/i, ''),
        source_link: source.obsidian_url, review_cards: response.result.review_cards,
      }));
      notify?.('复习卡已生成，并链接到这篇 Obsidian 原文');
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  };

  return <div className="knowledge-workspace obsidian-knowledge-workspace">
    <div className="obsidian-workbench">
      <aside className="vault-sidebar" aria-label="Obsidian 文件列表">
        <header><p className="panel-number">LOCAL VAULT</p><h2>{vault?.name || 'Obsidian'}</h2><p>{status || '本地 Markdown 保持原位'}</p>{treeTruncated && <small>文件超过 5,000 篇，当前只显示前 5,000 篇。</small>}</header>
        {vaults.length > 1 && <label className="vault-select">知识库<select value={vaultId} onChange={switchVault}>{vaults.map(item => <option key={item.id} value={item.id}>{item.name}{item.active ? ' · 当前' : ''}</option>)}</select></label>}
        <label className="vault-search"><span aria-hidden="true">⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={`搜索 ${files.length} 篇笔记`} aria-label="搜索 Obsidian 笔记"/></label>
        <nav className="vault-tree" aria-label="Markdown 文件树">
          {tree.folders.map(folder => <FolderBranch key={folder.path} node={folder} selectedPath={note?.path} expanded={expanded} query={query} onToggle={toggleFolder} onSelect={selectNote}/>)}
          {tree.files.map(file => <FileRow key={file.path} file={file} selected={note?.path === file.path} onSelect={selectNote}/>)}
          {!tree.folders.length && !tree.files.length && <p className="vault-empty">{busy ? '正在读取…' : '没有匹配的 Markdown'}</p>}
        </nav>
      </aside>

      <main className="obsidian-editor">
        {note ? <>
          <header className="editor-toolbar">
            <div><p className="editor-path">{note.path}</p><h2>{note.title}</h2></div>
            <div className="editor-actions">
              {view === 'edit'
                ? <button type="button" className="secondary-btn" disabled={busy === 'save'} onClick={cancelEditing}>取消</button>
                : <button type="button" className="secondary-btn" onClick={() => setView('edit')}>编辑文字</button>}
              <a className="secondary-btn" href={note.obsidian_url}>Obsidian ↗</a>
              {view === 'edit' && <button type="button" className="gold-btn" disabled={busy === 'save'} onClick={finishEditing}>{busy === 'save' ? '保存中…' : dirty ? '保存并完成' : '完成编辑'}</button>}
            </div>
          </header>
          <div className={`save-line ${dirty ? 'dirty' : ''}`}><span>{dirty ? '有未保存修改' : view === 'edit' ? '正在编辑' : '磁盘内容已同步'}</span><small>{dirty ? '点“保存并完成”或按 ⌘S' : view === 'edit' ? '完成后会自动回到阅读格式' : `最后读取 ${new Date(Number(note.modified_at) / 1_000_000).toLocaleString('zh-CN')}`}</small></div>
          {currentTaskDraft && <section className="obsidian-task-draft" aria-label="待排期学习任务">
            <span aria-hidden="true">待</span>
            <div><small>已从最近一次保存生成</small><strong>{currentTaskDraft.course_name} · {currentTaskDraft.title}</strong><p>保存 {currentTaskDraft.save_count} 次，始终是同一条任务。</p></div>
            <button type="button" className="secondary-btn" onClick={() => onScheduleTask?.(currentTaskDraft)}>安排时间</button>
          </section>}
          {view === 'edit' ? <textarea ref={editorRef} key={`${note.vault_id || vaultId}:${note.path}`} className="obsidian-text-editor" spellCheck="false" value={draft} onChange={event => { draftRef.current = event.target.value; setDraft(event.target.value); }} aria-label={`${note.title} Markdown 编辑器`}/> : <article className="obsidian-preview" tabIndex="0" aria-label={`${note.title} 阅读预览，点击进入编辑`} onClick={() => setView('edit')} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setView('edit'); } }}><span className="preview-edit-hint">点击正文进入编辑</span><ObsidianMarkdown content={draft}/></article>}

          <section className={`material-inbox obsidian-material ${dragging ? 'dragging' : ''}`} onDragEnter={event => { if (carriesFiles(event)) { event.preventDefault(); setDragging(true); } }} onDragOver={event => { if (carriesFiles(event)) event.preventDefault(); }} onDragLeave={() => setDragging(false)} onDrop={event => { if (carriesFiles(event)) { event.preventDefault(); void readMaterialFile(event.dataTransfer.files?.[0]); } }}>
            <div className="material-heading"><div><p className="panel-number">ADD TO THIS NOTE</p><h3>把新材料整理进当前笔记</h3><p>粘贴或拖入素材；确认预览后才会追加到这个 Markdown 文件。</p></div><button className="secondary-btn" type="button" onClick={() => fileRef.current?.click()}>选择文件</button></div>
            <input ref={fileRef} hidden type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={event => { void readMaterialFile(event.target.files?.[0]); event.target.value = ''; }}/>
            <label>素材来源<input maxLength="160" value={sourceLabel} onChange={event => setSourceLabel(event.target.value)} placeholder="书名、课程、文章或日期"/></label>
            <label>新素材<textarea rows="6" maxLength="12000" value={material} onChange={event => { setMaterial(event.target.value); setPreview(null); }} placeholder="把感兴趣的知识粘贴到这里…"/></label>
            <div className="material-actions"><button className="gold-btn" type="button" disabled={!material.trim() || busy === 'refine'} onClick={refine}>{busy === 'refine' ? '正在整理…' : '生成增补预览'}</button><button className="secondary-btn" type="button" disabled={!material.trim() || busy === 'save'} onClick={() => commitAddition({ addition_markdown: material.trim(), review_cards: [] })}>不用 AI，按原文追加</button></div>
          </section>
          {preview && <section className="addition-preview"><header><div><p className="panel-number">PREVIEW</p><h3>准备追加的内容</h3><p>{preview.change_summary}</p></div><button type="button" className="gold-btn" disabled={busy === 'save'} onClick={() => commitAddition(preview)}>确认写入 Obsidian</button></header><div className="addition-copy"><SafeMarkdown content={preview.addition_markdown}/></div>{preview.review_cards?.length > 0 && <div className="generated-cards"><strong>同时加入复习计划</strong>{preview.review_cards.map((card, index) => <p key={index}>{card.question}</p>)}</div>}<button type="button" className="danger-text" onClick={() => setPreview(null)}>放弃这次预览</button></section>}
        </> : <div className="obsidian-empty-state"><p className="panel-number">LOCAL FIRST</p><h2>{busy ? '正在自动读取 Obsidian' : '还没有可打开的笔记'}</h2><p>{error || '请先在 Obsidian 中建立一个 Markdown 笔记。'}</p></div>}
      </main>

      <aside className="review-rail">
        <DailyReview api={api} knowledge={knowledge} setKnowledge={setKnowledge} busy={busy} setBusy={setBusy} notify={notify}/>
        <section className="current-note-review"><p className="panel-number">FROM THIS NOTE</p><h2>生成复习卡</h2><p>只读取当前这一篇，卡片会保存在当前浏览器账号，并保留 Obsidian 原文链接。</p>
          {provider.text_available && !hasAIConsent && <label className="consent-line"><input type="checkbox" checked={allowAI} onChange={event => setAllowAI(event.target.checked)}/><span>允许把当前笔记和新素材临时发送给 <strong>{provider.provider_name}</strong>。{provider.retention_policy}</span></label>}
          {hasAIConsent && <p className="saved-consent-note">已记住本账户的知识整理授权；可在“我的”撤回。</p>}
          <button type="button" className="secondary-btn" disabled={!note || busy === 'cards'} onClick={generateCards}>{busy === 'cards' ? '正在生成…' : '从当前笔记生成'}</button>
          <small>浏览器内已有 {knowledge.notes.length} 篇复习资料</small>
        </section>
      </aside>
    </div>
    {error && note && <div className="knowledge-error-bar" role="alert"><p>{error}</p>{error.includes('刚刚在 Obsidian') && <button type="button" onClick={reloadCurrent}>重新载入磁盘版本</button>}{pendingCards && <button type="button" disabled={busy === 'cards'} onClick={retryPendingCards}>{busy === 'cards' ? '正在重试…' : '只重试保存复习卡'}</button>}</div>}
  </div>;
}
