import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedProfilePayload, normalizeProfileDetails } from './profileDetails.js';

test('recognized profile keeps only supported, bounded, unique fields', () => {
  const fields = normalizeProfileDetails([
    { key: 'gender', value: ' 女 ', confidence: 'high' },
    { key: 'gender', value: '重复值', confidence: 'low' },
    { key: 'phone', value: '13800000000', confidence: 'high' },
    { key: 'true_solar_time', value: '1994-08-31 05:31', confidence: 'unknown' },
  ]);

  assert.deepEqual(fields, [
    { key: 'gender', label: '性别', value: '女', confidence: 'high' },
    { key: 'true_solar_time', label: '真太阳时', value: '1994-08-31 05:31', confidence: 'medium' },
  ]);
  assert.deepEqual(confirmedProfilePayload(fields), [
    { key: 'gender', value: '女' },
    { key: 'true_solar_time', value: '1994-08-31 05:31' },
  ]);
});
