export const legacyReportView = report => {
  if (typeof report === 'string') {
    return { date: '', model: '旧版问春风报告', content: report };
  }
  const source = report && typeof report === 'object' ? report : {};
  return {
    date: String(source.date || ''),
    model: String(source.model || '旧版问春风报告'),
    content: String(source.content || ''),
  };
};

export const reportIsCurrent = (report, localDate) => Boolean(
  report && typeof report === 'object' && String(report.date || '') === String(localDate || ''),
);

export const resolveSpringWindCities = (birthCity, currentCity) => {
  const birth = String(birthCity || '').trim();
  const current = String(currentCity || '').trim();
  if (!birth && !current) return null;
  return { birth: birth || current, current: current || birth };
};

const sectionLabels = {
  summary: '春风想对你说',
  clothing: '今日穿衣',
  direction: '方位观察',
  diet: '饮食关照',
  do_avoid: '今日宜忌',
  question: '关于你的问题',
};

// The server keeps a structured report so it can audit facts and improve future
// suggestions.  The reader, however, should receive the original, quiet
// "问春风" letter rather than a technical report dashboard.
export const springWindLetterView = report => {
  if (report?.version !== 'spring-wind-report-2') return legacyReportView(report);

  const cultureSections = Object.entries(sectionLabels)
    .map(([key, label]) => {
      const text = String(report.culture?.[key]?.text || '').trim();
      return text ? `### ${label}\n\n${text}` : '';
    })
    .filter(Boolean);
  const actions = (report.actions || [])
    .map(action => {
      const title = String(action?.title || '').trim();
      const detail = String(action?.detail || '').trim();
      return title && detail ? `- **${title}**：${detail}` : title || detail;
    })
    .filter(Boolean);

  const sections = [];
  if (cultureSections.length) sections.push(`## 02 传统文化解读\n\n${cultureSections.join('\n\n')}`);
  if (actions.length) sections.push(`## 03 今日行动建议\n\n${actions.join('\n')}`);
  if (!sections.length) sections.push('## 02 传统文化解读\n\n今天先照顾好身体的真实感受，等你准备好时，再问春风。');

  return {
    date: String(report.date || ''),
    model: '今日问春风',
    content: sections.join('\n\n---\n\n'),
    stages: {
      facts: Array.isArray(report.facts) && report.facts.length > 0,
      culture: cultureSections.length > 0,
      actions: actions.length > 0,
    },
  };
};
