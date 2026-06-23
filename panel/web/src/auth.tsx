import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type PanelUser } from './api';

interface AuthCtx {
  user: PanelUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PanelUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const { user } = await api.me();
      setUser(user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const login = async (username: string, password: string) => {
    const { user } = await api.login(username, password);
    setUser(user);
  };

  const logout = async () => {
    // SSO 账户在启用 RP-initiated logout 时，服务端返回 IdP 退出地址，整页跳过去彻底登出。
    const res = await api.logout().catch(() => null);
    setUser(null);
    if (res?.redirect) {
      window.location.assign(res.redirect);
    }
  };

  return <Ctx.Provider value={{ user, loading, refresh, login, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
