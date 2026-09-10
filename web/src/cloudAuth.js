import { sectionFromHash, sectionHash } from './navigation.js';

const RETURN_TO_KEY = 'berich.cloud.oauth.return-to.v1';

const errorMessage = error => error?.message || 'Google 登录暂时不可用，请稍后重试';

export const safeAuthReturnTo = value => {
  const raw = String(value || '');
  if (!raw.startsWith('#/')) return sectionHash('today');
  const section = sectionFromHash(raw);
  return sectionHash(section) === raw ? raw : sectionHash('today');
};

export const cloudAccountFromUser = user => {
  if (!user?.id) return null;
  const email = String(user.email || '').trim();
  const metadata = user.user_metadata && typeof user.user_metadata === 'object' ? user.user_metadata : {};
  const displayName = String(metadata.full_name || metadata.name || email.split('@')[0] || 'Google 用户').trim();
  return {
    id: String(user.id),
    username: email || String(user.id),
    email,
    display_name: displayName || 'Google 用户',
    auth_mode: 'google',
  };
};

export const createCloudAuth = (client, {
  storage = globalThis.sessionStorage,
  location = globalThis.location,
  history = globalThis.history,
} = {}) => {
  const consumedCodes = new Set();
  let loginInFlight = false;
  const readSession = async () => {
    if (!client) return { status: 'disabled' };
    const { data, error } = await client.auth.getSession();
    if (error) throw new Error(errorMessage(error));
    const account = cloudAccountFromUser(data?.session?.user);
    return account ? { status: 'authenticated', account } : { status: 'anonymous' };
  };

  return {
    bootstrap: readSession,
    subscribe(onChange) {
      if (!client?.auth?.onAuthStateChange) return () => {};
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        onChange(session?.user ? { status: 'authenticated', account: cloudAccountFromUser(session.user) } : { status: 'anonymous' });
      });
      return () => data?.subscription?.unsubscribe?.();
    },
    async startGoogleLogin(returnTo = location?.hash) {
      if (!client) throw new Error('云端同步尚未配置');
      if (loginInFlight) throw new Error('Google 登录已经在当前页面开始');
      loginInFlight = true;
      const destination = safeAuthReturnTo(returnTo);
      storage?.setItem(RETURN_TO_KEY, destination);
      const origin = String(location?.origin || '').replace(/\/$/, '');
      const { error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${origin}/auth/callback`,
          scopes: 'openid email profile',
        },
      });
      if (error) {
        loginInFlight = false;
        throw new Error(errorMessage(error));
      }
    },
    async completeCallback() {
      if (!client) throw new Error('云端同步尚未配置');
      const params = new URLSearchParams(String(location?.search || ''));
      const providerError = params.get('error_description') || params.get('error');
      if (providerError) throw new Error(providerError);
      const code = params.get('code');
      if (!code) throw new Error('登录回调缺少授权码');
      if (consumedCodes.has(code)) throw new Error('这个登录回调已处理');
      consumedCodes.add(code);
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      if (error || !data?.session?.user) throw new Error(errorMessage(error));
      const account = cloudAccountFromUser(data.session.user);
      const destination = safeAuthReturnTo(storage?.getItem(RETURN_TO_KEY));
      storage?.removeItem(RETURN_TO_KEY);
      history?.replaceState?.(null, '', `/${destination}`);
      return { status: 'authenticated', account };
    },
    async signOut() {
      if (!client) return;
      const { error } = await client.auth.signOut();
      if (error) throw new Error(errorMessage(error));
    },
  };
};

export const isOAuthCallbackPath = location => String(location?.pathname || '') === '/auth/callback';
