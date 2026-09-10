import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicCloudConfig } from './buildConfig.js';

test('allows a complete public Supabase configuration', () => {
  assert.deepEqual(validatePublicCloudConfig({
    url: 'https://example.supabase.co/',
    publishableKey: 'sb_publishable_example',
  }), {
    enabled: true,
    url: 'https://example.supabase.co',
    publishableKey: 'sb_publishable_example',
  });
});

test('keeps cloud sync disabled when public configuration is absent or incomplete', () => {
  assert.equal(validatePublicCloudConfig().enabled, false);
  assert.equal(validatePublicCloudConfig({ url: 'https://example.supabase.co' }).enabled, false);
});

test('rejects secret-looking keys and insecure production URLs from browser configuration', () => {
  assert.match(validatePublicCloudConfig({
    url: 'https://example.supabase.co',
    publishableKey: 'sb_secret_not-for-browser',
  }).reason, /私密密钥/);
  assert.match(validatePublicCloudConfig({
    url: 'http://example.supabase.co',
    publishableKey: 'sb_publishable_example',
  }).reason, /HTTPS/);
});
