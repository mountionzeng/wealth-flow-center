import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECTION, normalizeSection, sectionFromHash, sectionHash, SECTIONS } from './navigation.js';

test('four primary sections stay stable and unknown routes fall back to today', () => {
  assert.deepEqual(SECTIONS.map(item => item.id), ['today', 'spring-wind', 'knowledge', 'me']);
  assert.equal(DEFAULT_SECTION, 'today');
  assert.equal(normalizeSection('knowledge'), 'knowledge');
  assert.equal(normalizeSection('unknown'), 'today');
});

test('hash routing round-trips supported sections', () => {
  assert.equal(sectionHash('spring-wind'), '#/spring-wind');
  assert.equal(sectionFromHash('#/me'), 'me');
  assert.equal(sectionFromHash('#/missing'), 'today');
});
