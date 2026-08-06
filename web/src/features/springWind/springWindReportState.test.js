import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyReportView, reportIsCurrent, resolveSpringWindCities, springWindLetterView } from './springWindReportState.js';

test('legacy string reports remain visible as markdown', () => {
  assert.deepEqual(legacyReportView('# 旧报告\n\n保留原文'), {
    date: '',
    model: '旧版问春风报告',
    content: '# 旧报告\n\n保留原文',
  });
});

test('legacy object reports keep their metadata and content', () => {
  assert.deepEqual(legacyReportView({ date: '2026-08-05', model: '本地基础推演', content: '原文' }), {
    date: '2026-08-05',
    model: '本地基础推演',
    content: '原文',
  });
});

test('a report from another local date is not reused as today\'s report', () => {
  assert.equal(reportIsCurrent({ date: '2026-08-05' }, '2026-08-06'), false);
  assert.equal(reportIsCurrent({ date: '2026-08-06' }, '2026-08-06'), true);
  assert.equal(reportIsCurrent(null, '2026-08-06'), false);
});

test('the original one-city flow can reuse that city for both location roles', () => {
  assert.deepEqual(resolveSpringWindCities('', '上海'), { birth: '上海', current: '上海' });
  assert.deepEqual(resolveSpringWindCities('成都', ''), { birth: '成都', current: '成都' });
  assert.equal(resolveSpringWindCities('', ''), null);
});

test('structured reports render as the original concise spring-wind letter', () => {
  const view = springWindLetterView({
    version: 'spring-wind-report-2', date: '2026-08-05',
    culture: { summary: { text: '今天宜缓，不宜急。' }, diet: { text: '饮食清淡。' } },
    actions: [{ title: '散步十分钟', detail: '让身体慢慢醒来。' }],
  });
  assert.equal(view.date, '2026-08-05');
  assert.equal(view.model, '今日问春风');
  assert.match(view.content, /02 传统文化解读/);
  assert.match(view.content, /饮食关照/);
  assert.match(view.content, /03 今日行动建议/);
  assert.equal(view.stages.facts, false);
  assert.equal(view.stages.culture, true);
  assert.equal(view.stages.actions, true);
  assert.doesNotMatch(view.content, /可验证事实|查看依据/);
});
