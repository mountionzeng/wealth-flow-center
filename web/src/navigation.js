export const SECTIONS = [
  { id: 'today', label: '今日', glyph: '◐', description: '一养一学' },
  { id: 'spring-wind', label: '问春风', glyph: '風', description: '传统文化指南' },
  { id: 'knowledge', label: '知识', glyph: '册', description: '学习与积累' },
  { id: 'me', label: '我的', glyph: '我', description: '账户与连接' },
];

export const DEFAULT_SECTION = 'today';
const SECTION_IDS = new Set(SECTIONS.map(item => item.id));

export const normalizeSection = value => SECTION_IDS.has(String(value || '')) ? String(value) : DEFAULT_SECTION;
export const sectionFromHash = hash => normalizeSection(String(hash || '').replace(/^#\/?/, ''));
export const sectionHash = section => `#/${normalizeSection(section)}`;
