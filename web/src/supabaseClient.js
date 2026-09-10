import { createClient } from '@supabase/supabase-js';
import { readPublicCloudConfig } from './buildConfig.js';

let client;

export const publicCloudConfig = () => readPublicCloudConfig();

export const getSupabaseClient = () => {
  const config = publicCloudConfig();
  if (!config.enabled) return null;
  if (!client) {
    client = createClient(config.url, config.publishableKey, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
};
