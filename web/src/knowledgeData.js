const MAX_REVISIONS = 20;
const MAX_SOURCES = 80;
const MAX_CARDS = 24;
const MAX_TASK_DRAFTS = 80;

const clean = (value, max = 40_000) => String(value || '').trim().slice(0, max);
const safeLink = value => {
  const link = clean(value, 2_000);
  return /^(?:obsidian|https?):\/\//i.test(link) ? link : '';
};
const pad = value => String(value).padStart(2, '0');
export const knowledgeDateKey = value => {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const iso = value => (value instanceof Date ? value : new Date(value || Date.now())).toISOString();
const addDays = (dateValue, days) => {
  const date = new Date(dateValue);
  date.setDate(date.getDate() + days);
  return knowledgeDateKey(date);
};

export const createKnowledgeState = () => ({
  version: 1,
  next_id: 1,
  notes: [],
  task_drafts: [],
  notifications: { last_notified_date: '' },
});

const normalizeTaskDraft = draft => {
  const sourceKey = clean(draft?.source_key, 520);
  const path = clean(draft?.path, 500);
  const title = clean(draft?.title, 160);
  if (!sourceKey || !path || !title) return null;
  const createdAt = clean(draft?.created_at, 80) || new Date(0).toISOString();
  return {
    source_key: sourceKey,
    vault_id: clean(draft?.vault_id, 160),
    path,
    course_name: clean(draft?.course_name, 160) || 'Obsidian',
    title,
    source_link: safeLink(draft?.source_link),
    content_hash: clean(draft?.content_hash, 160),
    save_count: Math.max(1, Number(draft?.save_count) || 1),
    created_at: createdAt,
    updated_at: clean(draft?.updated_at, 80) || createdAt,
  };
};

const normalizeCard = (card, index = 0) => ({
  id: clean(card?.id, 80) || `card-${index + 1}`,
  question: clean(card?.question, 500),
  answer: clean(card?.answer, 2_000),
  source_link: safeLink(card?.source_link),
  source_label: clean(card?.source_label, 160),
});

const normalizeNote = note => {
  const id = Number(note?.id);
  if (!Number.isInteger(id) || id < 1) return null;
  const createdAt = clean(note.created_at, 80) || new Date(0).toISOString();
  const updatedAt = clean(note.updated_at, 80) || createdAt;
  const cards = (Array.isArray(note.review_cards) ? note.review_cards : [])
    .map(normalizeCard)
    .filter(card => card.question && card.answer)
    .slice(-MAX_CARDS);
  return {
    id,
    title: clean(note.title, 160) || '未命名笔记',
    content: clean(note.content),
    created_at: createdAt,
    updated_at: updatedAt,
    sources: (Array.isArray(note.sources) ? note.sources : []).filter(Boolean).map((source, index) => ({
      id: clean(source.id, 80) || `source-${index + 1}`,
      label: clean(source.label, 160) || '补充素材',
      excerpt: clean(source.excerpt, 1_200),
      link: safeLink(source.link),
      captured_at: clean(source.captured_at, 80) || updatedAt,
    })).slice(-MAX_SOURCES),
    revisions: (Array.isArray(note.revisions) ? note.revisions : []).filter(Boolean).map(revision => ({
      content: clean(revision.content),
      saved_at: clean(revision.saved_at, 80) || updatedAt,
      reason: clean(revision.reason, 240),
    })).slice(-MAX_REVISIONS),
    review_cards: cards,
    review: {
      due_date: clean(note.review?.due_date, 10) || knowledgeDateKey(createdAt),
      interval_days: Math.max(0, Math.min(60, Number(note.review?.interval_days) || 0)),
      last_reviewed_at: clean(note.review?.last_reviewed_at, 80),
      last_grade: ['again', 'hard', 'good'].includes(note.review?.last_grade) ? note.review.last_grade : '',
      card_cursor: Math.max(0, Number(note.review?.card_cursor) || 0),
    },
  };
};

export const normalizeKnowledgeState = raw => {
  const source = raw && typeof raw === 'object' ? raw : {};
  const notes = (Array.isArray(source.notes) ? source.notes : []).map(normalizeNote).filter(Boolean);
  return {
    version: 1,
    next_id: Math.max(Number(source.next_id) || 1, ...notes.map(note => note.id + 1), 1),
    notes,
    task_drafts: (Array.isArray(source.task_drafts) ? source.task_drafts : [])
      .map(normalizeTaskDraft)
      .filter(Boolean)
      .slice(-MAX_TASK_DRAFTS),
    notifications: {
      last_notified_date: clean(source.notifications?.last_notified_date, 10),
    },
  };
};

export const upsertObsidianTaskDraft = (raw, input, now = new Date()) => {
  const state = normalizeKnowledgeState(raw);
  const candidate = normalizeTaskDraft({ ...input, created_at: iso(now), updated_at: iso(now), save_count: 1 });
  if (!candidate || !candidate.vault_id) throw new Error('无法从这篇 Obsidian 笔记生成待排期任务');
  const current = state.task_drafts.find(item => item.source_key === candidate.source_key);
  if (current) {
    Object.assign(current, candidate, {
      created_at: current.created_at,
      updated_at: iso(now),
      save_count: current.save_count + 1,
    });
  } else {
    state.task_drafts.push(candidate);
    state.task_drafts = state.task_drafts.slice(-MAX_TASK_DRAFTS);
  }
  return state;
};

export const removeObsidianTaskDraft = (raw, sourceKey) => {
  const state = normalizeKnowledgeState(raw);
  const key = clean(sourceKey, 520);
  state.task_drafts = state.task_drafts.filter(item => item.source_key !== key);
  return state;
};

export const addKnowledgeNote = (raw, input, now = new Date()) => {
  const state = normalizeKnowledgeState(raw);
  const title = clean(input?.title, 160);
  const content = clean(input?.content);
  if (!title) throw new Error('请给笔记一个标题');
  if (!content) throw new Error('请先写下笔记底稿');
  const createdAt = iso(now);
  const sourceLink = safeLink(input?.source_link);
  const createdSource = sourceLink ? [{
    id: globalThis.crypto?.randomUUID?.() || `source-${Date.now()}`,
    label: clean(input?.source_label, 160) || 'Obsidian 原文',
    excerpt: clean(input?.source_text, 1_200),
    link: sourceLink,
    captured_at: createdAt,
  }] : [];
  state.notes.unshift({
    id: state.next_id++, title, content, created_at: createdAt, updated_at: createdAt,
    sources: createdSource, revisions: [], review_cards: [],
    review: { due_date: knowledgeDateKey(now), interval_days: 0, last_reviewed_at: '', last_grade: '', card_cursor: 0 },
  });
  return state;
};

export const updateKnowledgeNote = (raw, id, input, now = new Date()) => {
  const state = normalizeKnowledgeState(raw);
  const note = state.notes.find(item => item.id === Number(id));
  if (!note) throw new Error('笔记不存在');
  const title = clean(input?.title, 160);
  const content = clean(input?.content);
  if (!title || !content) throw new Error('标题和笔记内容不能为空');
  if (note.content !== content) {
    note.revisions.push({ content: note.content, saved_at: iso(now), reason: '手动编辑前的版本' });
    note.revisions = note.revisions.slice(-MAX_REVISIONS);
  }
  note.title = title;
  note.content = content;
  note.updated_at = iso(now);
  return state;
};

export const appendKnowledgeAddition = (raw, id, input, now = new Date()) => {
  const state = normalizeKnowledgeState(raw);
  const note = state.notes.find(item => item.id === Number(id));
  if (!note) throw new Error('笔记不存在');
  const addition = clean(input?.addition_markdown, 16_000);
  if (!addition) throw new Error('没有可合入的增补内容');
  const sourceLabel = clean(input?.source_label, 160) || '补充素材';
  const sourceText = clean(input?.source_text, 12_000);
  const savedAt = iso(now);
  note.revisions.push({ content: note.content, saved_at: savedAt, reason: `合入前 · ${sourceLabel}` });
  note.revisions = note.revisions.slice(-MAX_REVISIONS);
  note.content = `${note.content.trim()}\n\n## 增补 · ${sourceLabel}\n\n${addition}`.trim();
  note.updated_at = savedAt;
  note.sources.push({
    id: globalThis.crypto?.randomUUID?.() || `source-${Date.now()}`,
    label: sourceLabel,
    excerpt: sourceText.slice(0, 1_200),
    link: safeLink(input?.source_link),
    captured_at: savedAt,
  });
  note.sources = note.sources.slice(-MAX_SOURCES);
  const incomingCards = (Array.isArray(input?.review_cards) ? input.review_cards : [])
    .map(normalizeCard)
    .filter(card => card.question && card.answer);
  const sourceLink = safeLink(input?.source_link);
  note.review_cards = [...note.review_cards, ...incomingCards.map(card => ({
    ...card,
    source_link: card.source_link || sourceLink,
    source_label: card.source_label || sourceLabel,
  }))].slice(-MAX_CARDS);
  note.review = { ...note.review, due_date: knowledgeDateKey(now), interval_days: 0 };
  return state;
};

export const storeObsidianReviewCards = (raw, input, now = new Date()) => {
  const sourceLink = safeLink(input?.source_link);
  if (!sourceLink.startsWith('obsidian://')) throw new Error('缺少 Obsidian 原文链接');
  const title = clean(input?.title, 160);
  const content = clean(input?.content);
  if (!title || !content) throw new Error('笔记标题和内容不能为空');
  const incomingCards = (Array.isArray(input?.review_cards) ? input.review_cards : [])
    .map(normalizeCard)
    .filter(card => card.question && card.answer)
    .map(card => ({
      ...card,
      source_link: sourceLink,
      source_label: clean(input?.source_label, 160) || title,
    }))
    .slice(-MAX_CARDS);
  if (!incomingCards.length) throw new Error('没有可以保存的复习卡');

  let state = normalizeKnowledgeState(raw);
  let note = state.notes.find(item => item.sources.some(source => source.link === sourceLink));
  if (!note) {
    state = addKnowledgeNote(state, {
      title,
      content,
      source_label: clean(input?.source_label, 160) || title,
      source_text: content,
      source_link: sourceLink,
    }, now);
    note = state.notes[0];
  } else {
    note.title = title;
    note.content = content;
    note.updated_at = iso(now);
  }
  note.review_cards = incomingCards;
  note.review = { ...note.review, due_date: knowledgeDateKey(now), interval_days: 0, card_cursor: 0 };
  return state;
};

export const restoreKnowledgeRevision = (raw, id, revisionIndex, now = new Date()) => {
  const state = normalizeKnowledgeState(raw);
  const note = state.notes.find(item => item.id === Number(id));
  const revision = note?.revisions?.[Number(revisionIndex)];
  if (!note || !revision) throw new Error('找不到这个历史版本');
  note.revisions.push({ content: note.content, saved_at: iso(now), reason: '恢复历史版本前' });
  note.content = revision.content;
  note.updated_at = iso(now);
  note.revisions = note.revisions.slice(-MAX_REVISIONS);
  return state;
};

export const removeKnowledgeNote = (raw, id) => {
  const state = normalizeKnowledgeState(raw);
  const before = state.notes.length;
  state.notes = state.notes.filter(note => note.id !== Number(id));
  if (state.notes.length === before) throw new Error('笔记不存在');
  return state;
};

const fallbackCard = note => ({
  id: `fallback-${note.id}`,
  question: `不用看笔记，你能用自己的话说出“${note.title}”的核心内容吗？`,
  answer: note.content.slice(0, 500),
  source_link: note.sources[0]?.link || '',
  source_label: note.sources[0]?.label || '',
});

export const selectDailyKnowledgeReview = (raw, now = new Date()) => {
  const state = normalizeKnowledgeState(raw);
  const today = knowledgeDateKey(now);
  const due = state.notes
    .filter(note => note.review.due_date <= today)
    .sort((a, b) => String(a.review.last_reviewed_at || '').localeCompare(String(b.review.last_reviewed_at || '')) || String(a.updated_at).localeCompare(String(b.updated_at)));
  const note = due[0];
  if (!note) return null;
  const cards = note.review_cards.length ? note.review_cards : [fallbackCard(note)];
  const card = cards[note.review.card_cursor % cards.length];
  return { note_id: note.id, note_title: note.title, due_date: note.review.due_date, card };
};

export const recordKnowledgeReview = (raw, id, grade, now = new Date()) => {
  const state = normalizeKnowledgeState(raw);
  const note = state.notes.find(item => item.id === Number(id));
  if (!note) throw new Error('笔记不存在');
  if (!['again', 'hard', 'good'].includes(grade)) throw new Error('复习结果无效');
  const current = Number(note.review.interval_days) || 0;
  const nextDays = grade === 'again' ? 1 : grade === 'hard' ? Math.max(2, Math.ceil(current * 1.4)) : Math.max(3, current ? Math.ceil(current * 2.2) : 3);
  note.review = {
    ...note.review,
    due_date: addDays(now, Math.min(60, nextDays)),
    interval_days: Math.min(60, nextDays),
    last_reviewed_at: iso(now),
    last_grade: grade,
    card_cursor: note.review.card_cursor + 1,
  };
  return state;
};

export const markKnowledgeNotification = (raw, date = new Date()) => {
  const state = normalizeKnowledgeState(raw);
  state.notifications.last_notified_date = knowledgeDateKey(date);
  return state;
};
