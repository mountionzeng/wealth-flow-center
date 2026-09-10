import React from 'react';

export default function AuthCallback({ error, onReturnToLogin }) {
  return (
    <main className="auth-shell">
      <section className="auth-ledger auth-callback" aria-live="polite">
        <p className="auth-kicker">BE RICH, MY FRIEND</p>
        <h1>{error ? '登录没有完成' : '正在确认你的 Google 登录…'}</h1>
        <p className="auth-intro">{error || '请稍候，完成后会回到你刚才浏览的页面。'}</p>
        {error && <button className="auth-submit" type="button" onClick={onReturnToLogin}>回到登录页</button>}
      </section>
    </main>
  );
}
