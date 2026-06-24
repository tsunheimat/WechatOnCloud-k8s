import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { UIProvider } from './ui';
import Login from './pages/Login';
import OidcLink from './pages/OidcLink';
import AppShell from './AppShell';
import type { ReactNode } from 'react';

function Splash() {
  return (
    <div className="center-screen">
      <div className="spinner" />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Splash />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Shell() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* SSO 首次登录的自助绑定页：未登录态可达（此时尚无会话），由服务端暂存身份驱动 */}
      <Route path="/oidc/link" element={<OidcLink />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <UIProvider>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </UIProvider>
  );
}
