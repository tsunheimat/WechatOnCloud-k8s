// OIDC 自助绑定流程的路由（/api/auth/oidc/pending + /api/auth/oidc/link）。
//
// 从 index.ts 抽出来单列，是为了能用 Fastify 的 app.inject() 做无网络的端到端测试（见 oidc-routes.test.ts）：
// 这部分逻辑不碰 IdP（不需要 openid-client / 真实回调），只在「待绑定身份已暂存」之后，按用户选择走
// 新建账户 / 绑定到已有账户。登录与回调（需要 discover/换 token）仍留在 index.ts。
//
// 与 index.ts 的耦合通过 deps 注入：开关取值、cookie 名/路径、HTTPS 自适应、日志等都由调用方给定；
// 账户存储 / 会话 / 待绑定暂存等单例模块则直接 import。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  findByUsername,
  findByOidcSubject,
  verifyPassword,
  upsertOidcUser,
  bindOidcToUser,
  userAuthProvider,
  type User,
} from './store.js';
import { createSession } from './sessions.js';
import { getPendingLink, consumePendingLink } from './oidc-link.js';

export interface OidcBindDeps {
  enabled: boolean; // OIDC 是否启用（未启用则这些路由一律 404）
  adminGroup: string; // OIDC_ADMIN_GROUP；非空才据分组对账管理员（mapAdmin）
  linkCookie: string; // 待绑定 token 的签名 cookie 名
  linkCookiePath: string; // 该 cookie 的 path（清除时需对齐）
  sessionCookie: string; // 会话 cookie 名
  allowRegister: () => boolean; // 是否允许自助新建账户（有效值，面板设置覆盖环境默认）
  allowBind: () => boolean; // 是否允许绑定到已有账户
  cookieSecure: (req: FastifyRequest) => boolean; // 是否给 cookie 加 Secure（HTTPS 自适应）
  log: (level: 'INFO' | 'WARN' | 'ERROR', msg: string) => void;
}

export function registerOidcBindRoutes(app: FastifyInstance, deps: OidcBindDeps) {
  // 待绑定信息：新 SSO 身份首次登录后，前端 /oidc/link 页据此渲染（IdP 给出的用户名/邮箱 + 当前允许的操作）。
  // 不下发 subject / isAdmin / id_token 等内部字段。
  app.get('/api/auth/oidc/pending', async (req, reply) => {
    if (!deps.enabled) return reply.code(404).send({ error: 'OIDC 未启用' });
    const raw = req.cookies?.[deps.linkCookie];
    const unsigned = raw ? reply.unsignCookie(raw) : null;
    const p = unsigned && unsigned.valid ? getPendingLink(unsigned.value || undefined) : null;
    if (!p) return reply.code(400).send({ error: 'SSO 会话已过期或无效，请重新发起登录' });
    return { username: p.username, email: p.email, allowRegister: deps.allowRegister(), allowBind: deps.allowBind() };
  });

  // 自助绑定/新建：消费待绑定身份，按 mode 走「新建账户」或「绑定到已有账户（校验既有用户名口令）」，成功即建会话。
  app.post('/api/auth/oidc/link', async (req, reply) => {
    if (!deps.enabled) return reply.code(404).send({ error: 'OIDC 未启用' });
    const raw = req.cookies?.[deps.linkCookie];
    const unsigned = raw ? reply.unsignCookie(raw) : null;
    const token = unsigned && unsigned.valid ? unsigned.value || undefined : undefined;
    const p = getPendingLink(token);
    if (!p) return reply.code(400).send({ error: 'SSO 会话已过期或无效，请重新发起登录' });
    const identity = { subject: p.subject, username: p.username, email: p.email, isAdmin: p.isAdmin };
    // 成功收尾：弃用暂存、清 cookie、建会话（带 id_token 供 RP-initiated logout）。
    const finish = (user: User) => {
      consumePendingLink(token);
      reply.clearCookie(deps.linkCookie, { path: deps.linkCookiePath });
      const t = createSession(user.id, p.idToken);
      reply.setCookie(deps.sessionCookie, t, { httpOnly: true, sameSite: 'lax', secure: deps.cookieSecure(req), path: '/', maxAge: 60 * 60 * 12 });
    };
    // 该 subject 在等待期间已被登记（并发/重复提交）→ 直接登入它，避免重复建号/绑定。
    const already = findByOidcSubject(identity.subject);
    if (already) {
      if (already.disabled) return reply.code(403).send({ error: '该账户已被禁用，请联系管理员' });
      finish(already);
      deps.log('INFO', `OIDC 登录：${already.username}（${already.role}）`);
      return { ok: true };
    }
    const mode = (req.body as any)?.mode;
    try {
      if (mode === 'create') {
        if (!deps.allowRegister()) return reply.code(403).send({ error: '本面板已关闭 SSO 自助注册，请绑定到已有账户' });
        const user = upsertOidcUser(identity, { autoCreate: true, mapAdmin: !!deps.adminGroup, adminReliable: p.groupsReliable });
        finish(user);
        deps.log('INFO', `OIDC 新建账户并登录：${user.username}（${user.role}）`);
        return { ok: true };
      }
      if (mode === 'bind') {
        if (!deps.allowBind()) return reply.code(403).send({ error: '本面板已关闭 SSO 账户绑定' });
        const { username, password } = (req.body as any) ?? {};
        const target = username ? findByUsername(username) : undefined;
        // 统一回「用户名或密码错误」，不区分不存在/禁用/纯SSO/口令错，避免账户枚举。允许目标是管理员（绑定到管理员）。
        if (!target || target.disabled || userAuthProvider(target) === 'oidc' || !verifyPassword(target, password ?? '')) {
          return reply.code(401).send({ error: '用户名或密码错误' });
        }
        const user = bindOidcToUser(target.id, identity);
        finish(user);
        deps.log('INFO', `OIDC 绑定到已有账户并登录：${user.username}（${user.role}）`);
        return { ok: true };
      }
      return reply.code(400).send({ error: '参数不合法' });
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || '操作失败' });
    }
  });
}
