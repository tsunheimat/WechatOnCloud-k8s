import { randomBytes } from 'node:crypto';

// 「待绑定」暂存：一个新 SSO 身份（既往未登记的 subject）首次登录后，先不直接建号，而是引导用户在
// /oidc/link 页自助选择「新建账户」或「绑定到已有账户」。这段选择期内，把归一化身份暂存在服务端（而非
// 客户端 cookie——id_token 偏大且略敏感），用随机 token 的短时签名 cookie 关联；选择完成或超时即丢弃。
// 与 sessions.ts 同构：纯内存、进程内、带 TTL；进程重启即失效（用户重新发起 SSO 登录即可）。
export interface PendingLink {
  subject: string;
  username: string;
  email?: string;
  isAdmin: boolean;
  groupsReliable: boolean;
  idToken?: string;
  expires: number;
}

const TTL_MS = 1000 * 60 * 10; // 10 分钟，与发起登录的事务 cookie 寿命一致
const pending = new Map<string, PendingLink>();

export function createPendingLink(p: Omit<PendingLink, 'expires'>): string {
  const token = randomBytes(24).toString('hex');
  pending.set(token, { ...p, expires: Date.now() + TTL_MS });
  // 顺手清理过期项，避免无人取走的暂存长期占内存。
  for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
  return token;
}

export function getPendingLink(token?: string): PendingLink | null {
  if (!token) return null;
  const p = pending.get(token);
  if (!p) return null;
  if (p.expires < Date.now()) {
    pending.delete(token);
    return null;
  }
  return p;
}

export function consumePendingLink(token?: string) {
  if (token) pending.delete(token);
}
