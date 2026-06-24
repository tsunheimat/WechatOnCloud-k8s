import { useEffect, useState } from 'react';
import { api, type OidcPending } from '../api';
import { PasswordInput } from '../ui';

// 新 SSO 身份首次登录（subject 尚未登记）后，服务端把身份暂存并跳到这里，让用户自助二选一：
//   - 新建账户：用 IdP 给的用户名直接建一个面板账户（受「允许自助注册」开关约束）；
//   - 绑定到已有账户：输入既有账户的用户名+密码校验后，把这个 SSO 身份绑定上去（含管理员账户）。
// 成功后服务端已种好会话 cookie，这里整页跳回首页（让 AuthProvider 重新拉取登录态）。
export default function OidcLink() {
  const [pending, setPending] = useState<OidcPending | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [mode, setMode] = useState<'choose' | 'bind'>('choose');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .oidcPending()
      .then((p) => {
        setPending(p);
        // 不允许新建、只允许绑定时，直接进入绑定表单，少一次点击。
        if (!p.allowRegister && p.allowBind) setMode('bind');
      })
      .catch((e) => setLoadErr(e.message || '会话已过期，请重新发起 SSO 登录'));
  }, []);

  const done = () => window.location.assign('/'); // 整页跳转，让 AuthProvider 重新拉会话

  const create = async () => {
    setErr('');
    setBusy(true);
    try {
      await api.oidcLinkCreate();
      done();
    } catch (e: any) {
      setErr(e.message || '创建失败');
      setBusy(false);
    }
  };

  const bind = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.oidcLinkBind(username.trim(), password);
      done();
    } catch (e: any) {
      setErr(e.message || '绑定失败');
      setBusy(false);
    }
  };

  return (
    <div className="center-screen login-screen">
      <div className="login-wrap">
        <div className="card login-card">
          <div className="brand">
            <div className="brand-logo">
              <img src="/favicon.svg" alt="" />
            </div>
            <h1>关联账户</h1>
            {pending ? (
              <p className="muted">
                首次通过 SSO 登录{pending.username ? `（${pending.username}${pending.email ? ` · ${pending.email}` : ''}）` : ''}，
                请选择如何关联到面板账户
              </p>
            ) : (
              <p className="muted">{loadErr || '加载中…'}</p>
            )}
          </div>

          {loadErr ? (
            <a className="btn btn-primary" href="/login">
              返回登录
            </a>
          ) : !pending ? (
            <div className="spinner" />
          ) : (
            <>
              {err && <div className="error">{err}</div>}

              {mode === 'choose' ? (
                <>
                  {pending.allowRegister && (
                    <button className="btn btn-primary" disabled={busy} onClick={create}>
                      {busy ? '处理中…' : '创建新账户'}
                    </button>
                  )}
                  {pending.allowBind && (
                    <button className="btn" disabled={busy} onClick={() => { setErr(''); setMode('bind'); }}>
                      绑定到已有账户
                    </button>
                  )}
                  {!pending.allowRegister && !pending.allowBind && (
                    <div className="error">本面板未开放 SSO 自助注册或绑定，请联系管理员先行登记。</div>
                  )}
                </>
              ) : (
                <form onSubmit={bind} style={{ display: 'contents' }}>
                  <p className="muted" style={{ margin: '0 0 2px' }}>
                    输入要关联的<strong>已有账户</strong>的用户名与密码（验证后即可用 SSO 登录该账户）
                  </p>
                  <input
                    className="input"
                    placeholder="已有账户用户名"
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                  <PasswordInput placeholder="密码" autoComplete="current-password" value={password} onChange={setPassword} />
                  <button className="btn btn-primary" disabled={busy || !username || !password}>
                    {busy ? '绑定中…' : '验证并绑定'}
                  </button>
                  {pending.allowRegister && (
                    <button type="button" className="btn-text" disabled={busy} onClick={() => { setErr(''); setMode('choose'); }}>
                      ‹ 返回
                    </button>
                  )}
                </form>
              )}

              <a className="btn-text" href="/login" style={{ textAlign: 'center' }}>
                取消，返回登录
              </a>
            </>
          )}
        </div>
        <div className="login-foot">服务端微信 · 多端共享 · 建议仅在内网 / 可信网络访问</div>
      </div>
    </div>
  );
}
