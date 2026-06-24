import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { api } from '../api';
import { PasswordInput } from '../ui';
import { SsoIcon } from '../SsoIcon';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // SSO：是否启用 + 按钮文案 + 图标（来自 /api/auth/config）
  const [sso, setSso] = useState<{ enabled: boolean; displayName: string; icon?: string }>({ enabled: false, displayName: 'SSO' });

  useEffect(() => {
    api.authConfig().then((c) => setSso(c.oidc)).catch(() => {});
    // OIDC 回调失败会带 ?sso_error=… 跳回登录页，在此回显
    const params = new URLSearchParams(window.location.search);
    const e = params.get('sso_error');
    if (e) {
      setErr(e);
      // 清掉 query，避免刷新后仍显示旧错误
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await login(username.trim(), password);
      nav('/', { replace: true });
    } catch (e: any) {
      setErr(e.message || '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen login-screen">
      <div className="login-wrap">
        <form className="card login-card" onSubmit={submit}>
          <div className="brand">
            <div className="brand-logo">
              <img src="/favicon.svg" alt="" />
            </div>
            <h1>云微</h1>
            <p className="muted">登录以访问 NAS 上的微信</p>
          </div>
          <input
            className="input"
            placeholder="用户名"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <PasswordInput placeholder="密码" autoComplete="current-password" value={password} onChange={setPassword} />
          {err && <div className="error">{err}</div>}
          <button className="btn btn-primary" disabled={busy || !username || !password}>
            {busy ? '登录中…' : '登录'}
          </button>
          {sso.enabled && (
            <>
              <div className="login-or">或</div>
              {/* 整页跳转到服务端发起 OIDC 授权（非 fetch）：会被重定向到 IdP */}
              <a
                className="btn login-sso"
                href="/api/auth/oidc/login"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
              >
                <SsoIcon icon={sso.icon} size={18} />
                <span>使用 {sso.displayName} 登录</span>
              </a>
            </>
          )}
        </form>
        <div className="login-foot">服务端微信 · 多端共享 · 建议仅在内网 / 可信网络访问</div>
      </div>
    </div>
  );
}
