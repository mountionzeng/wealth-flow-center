const SECRET_KEY_PREFIXES = ['sb_secret_', 'service_role', 'eyJ'];

const isLocalUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
};

export const validatePublicCloudConfig = ({ url = '', publishableKey = '' } = {}) => {
  const normalizedUrl = String(url).trim();
  const normalizedKey = String(publishableKey).trim();

  if (!normalizedUrl && !normalizedKey) return { enabled: false, reason: '未配置云端同步' };
  if (!normalizedUrl || !normalizedKey) return { enabled: false, reason: '云端同步配置不完整' };

  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    return { enabled: false, reason: 'Supabase 地址格式不正确' };
  }

  if (parsedUrl.protocol !== 'https:' && !isLocalUrl(normalizedUrl)) {
    return { enabled: false, reason: 'Supabase 地址必须使用 HTTPS（本地开发除外）' };
  }
  if (SECRET_KEY_PREFIXES.some(prefix => normalizedKey.startsWith(prefix))) {
    return { enabled: false, reason: '浏览器不能使用 Supabase 私密密钥' };
  }
  if (!normalizedKey.startsWith('sb_publishable_')) {
    return { enabled: false, reason: '需要 Supabase publishable key' };
  }

  return {
    enabled: true,
    url: parsedUrl.toString().replace(/\/$/, ''),
    publishableKey: normalizedKey,
  };
};

export const readPublicCloudConfig = () => validatePublicCloudConfig({
  url: typeof __BERICH_SUPABASE_URL__ === 'string' ? __BERICH_SUPABASE_URL__ : '',
  publishableKey: typeof __BERICH_SUPABASE_PUBLISHABLE_KEY__ === 'string' ? __BERICH_SUPABASE_PUBLISHABLE_KEY__ : '',
});
