import { randomBytes } from 'node:crypto';

interface Session {
  userId: string;
  expires: number;
  // OIDC 登录时保存的 id_token，登出时作 id_token_hint 传给 IdP 的 end_session（RP-initiated logout）。
  idToken?: string;
}

const TTL_MS = 1000 * 60 * 60 * 12; // 12 小时
const sessions = new Map<string, Session>();

export function createSession(userId: string, idToken?: string) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { userId, expires: Date.now() + TTL_MS, idToken });
  return token;
}

export function getSession(token?: string) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

export function destroySession(token?: string) {
  if (token) sessions.delete(token);
}

// 禁用/删除账号后，立即踢掉其所有在线会话
export function destroyUserSessions(userId: string) {
  for (const [token, s] of sessions) {
    if (s.userId === userId) sessions.delete(token);
  }
}
