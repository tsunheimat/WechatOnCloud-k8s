import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

// store.ts 在加载时从 PANEL_DATA 读取数据文件路径，必须在 import 之前设好。node --test 每个测试文件跑在
// 独立子进程，故这里的单例（store / sessions / oidc-link）与其它测试文件互不影响。
const dir = mkdtempSync(join(tmpdir(), 'woc-oidc-routes-'));
process.env.PANEL_DATA = join(dir, 'accounts.json');
process.env.PANEL_ADMIN_PASSWORD = 'admin-pass-xyz';

const Fastify = (await import('fastify')).default;
const cookie = (await import('@fastify/cookie')).default;
const store = await import('./store.js');
const { createPendingLink } = await import('./oidc-link.js');
const { registerOidcBindRoutes } = await import('./oidc-routes.js');
const { getSession } = await import('./sessions.js');
const { shouldRpLogout } = await import('./oidc.js');

store.initStore();
test.after(() => rmSync(dir, { recursive: true, force: true }));

const LINK_COOKIE = 'woc_oidc_link';
const LINK_PATH = '/api/auth/oidc';
const SESSION_COOKIE = 'woc_sess';

// 注册的开关用可变闭包变量驱动，便于逐用例切换。
let allowRegister = true;
let allowBind = true;

async function makeApp() {
  const app = Fastify();
  await app.register(cookie, { secret: 'test-secret-please-ignore' });
  registerOidcBindRoutes(app, {
    enabled: true,
    adminGroup: '', // mapAdmin=false：新建账户固定为子账号
    linkCookie: LINK_COOKIE,
    linkCookiePath: LINK_PATH,
    sessionCookie: SESSION_COOKIE,
    allowRegister: () => allowRegister,
    allowBind: () => allowBind,
    cookieSecure: () => false,
    log: () => {},
  });
  // 测试专用：用与真实回调相同的 setCookie(signed) 机制，把一条待绑定身份种进短时签名 cookie，
  // 再把 set-cookie 原样回放给后续请求——等价于「回调把新身份暂存并下发 cookie」那一步，不需要真实 IdP。
  app.get('/__seed', (req, reply) => {
    const q = req.query as Record<string, string>;
    const token = createPendingLink({
      subject: q.subject || 'sub-x',
      username: q.username || 'ssouser',
      email: q.email || undefined,
      isAdmin: q.isAdmin === '1',
      groupsReliable: true,
      idToken: q.idToken || undefined,
    });
    reply.setCookie(LINK_COOKIE, token, { signed: true, httpOnly: true, sameSite: 'lax', path: LINK_PATH });
    return { ok: true };
  });
  await app.ready();
  return app;
}

// 种一条待绑定身份，返回可直接当 Cookie 头回放的 `name=value` 串。
async function seed(app: Awaited<ReturnType<typeof makeApp>>, q: Record<string, string> = {}) {
  const res = await app.inject({ method: 'GET', url: '/__seed', query: q });
  const setCookie = res.headers['set-cookie'];
  const header = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return header.split(';')[0]; // 取 `woc_oidc_link=<signed>`，丢掉 Path/HttpOnly 等属性
}

// 从 set-cookie 里取出会话 token（原始值）。
function sessionToken(res: { headers: Record<string, unknown> }): string | null {
  const sc = res.headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : sc ? [sc as string] : [];
  const hit = arr.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!hit) return null;
  return decodeURIComponent(hit.split(';')[0].slice(SESSION_COOKIE.length + 1));
}
// 取会话指向的登录用户 id。
function sessionUserId(res: { headers: Record<string, unknown> }): string | null {
  const token = sessionToken(res);
  return token ? getSession(token)?.userId ?? null : null;
}

test('GET /pending: returns IdP-provided username + the current allow flags (no internal fields)', async () => {
  allowRegister = true;
  allowBind = true;
  const app = await makeApp();
  const c = await seed(app, { subject: 'sub-pending', username: 'pendinguser', email: 'p@example.com' });
  const res = await app.inject({ method: 'GET', url: '/api/auth/oidc/pending', headers: { cookie: c } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.username, 'pendinguser');
  assert.equal(body.email, 'p@example.com');
  assert.equal(body.allowRegister, true);
  assert.equal(body.allowBind, true);
  assert.equal(body.subject, undefined); // never leak the binding key
  await app.close();
});

test('POST /link create: makes a new OIDC sub account and establishes a session', async () => {
  allowRegister = true;
  const app = await makeApp();
  const c = await seed(app, { subject: 'sub-create', username: 'createme', email: 'c@example.com' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/oidc/link',
    headers: { cookie: c, 'content-type': 'application/json' },
    payload: { mode: 'create' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  const u = store.findByOidcSubject('sub-create')!;
  assert.ok(u);
  assert.equal(store.userAuthProvider(u), 'oidc');
  assert.equal(u.role, 'sub');
  assert.equal(sessionUserId(res), u.id); // logged in as the new account
  await app.close();
});

test('POST /link create: rejected with 403 when self-registration is disabled', async () => {
  allowRegister = false;
  const app = await makeApp();
  const c = await seed(app, { subject: 'sub-noreg', username: 'noreg' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/oidc/link',
    headers: { cookie: c, 'content-type': 'application/json' },
    payload: { mode: 'create' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(store.findByOidcSubject('sub-noreg'), undefined); // nothing created
  assert.equal(sessionUserId(res), null);
  allowRegister = true;
  await app.close();
});

test('POST /link bind: correct credentials link the SSO identity to the existing local account', async () => {
  allowBind = true;
  store.createSub('bindtarget', 'pw-123456');
  const before = store.findByUsername('bindtarget')!;
  const app = await makeApp();
  const c = await seed(app, { subject: 'sub-bindok', username: 'whatever', email: 'b@example.com' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/oidc/link',
    headers: { cookie: c, 'content-type': 'application/json' },
    payload: { mode: 'bind', username: 'bindtarget', password: 'pw-123456' },
  });
  assert.equal(res.statusCode, 200);
  const u = store.findByUsername('bindtarget')!;
  assert.equal(u.id, before.id); // same account, not a new one
  assert.equal(u.oidcSubject, 'sub-bindok');
  assert.equal(store.userAuthProvider(u), 'local'); // hybrid: keeps local password login
  assert.equal(store.findByOidcSubject('sub-bindok')!.id, before.id);
  assert.equal(sessionUserId(res), before.id); // logged in as the linked account
  await app.close();
});

test('POST /link bind: the SSO session for a hybrid (local) account carries id_token so RP-logout fires (regression)', async () => {
  // 回归：绑定到本地账户的混合账户 authProvider 仍是 local，但经 SSO 建立的会话必须带 id_token，
  // 这样登出时（按会话 id_token 判断，而非账户来源）才会跳 IdP 注销，避免「只清本地、IdP 仍登录」。
  allowBind = true;
  store.createSub('hybridlogout', 'pw-123456');
  const app = await makeApp();
  const c = await seed(app, { subject: 'sub-hybrid-logout', username: 'whatever', idToken: 'idtok-hybrid-xyz' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/oidc/link',
    headers: { cookie: c, 'content-type': 'application/json' },
    payload: { mode: 'bind', username: 'hybridlogout', password: 'pw-123456' },
  });
  assert.equal(res.statusCode, 200);
  const linked = store.findByUsername('hybridlogout')!;
  assert.equal(store.userAuthProvider(linked), 'local'); // still a local-provider account…
  const tok = sessionToken(res)!;
  assert.equal(getSession(tok)!.idToken, 'idtok-hybrid-xyz'); // …yet the session carries the IdP id_token
  // → the logout gate (keyed off the session id_token, not the account provider) will perform RP-initiated logout
  assert.equal(shouldRpLogout({ enabled: true, postLogout: true }, getSession(tok)!.idToken), true);
  await app.close();
});

test('POST /link bind: wrong password is rejected (401) and binds nothing', async () => {
  allowBind = true;
  store.createSub('bindwrong', 'right-pw-123');
  const app = await makeApp();
  const c = await seed(app, { subject: 'sub-bindwrong', username: 'whatever' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/oidc/link',
    headers: { cookie: c, 'content-type': 'application/json' },
    payload: { mode: 'bind', username: 'bindwrong', password: 'WRONG' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(store.findByUsername('bindwrong')!.oidcSubject, undefined); // not bound
  assert.equal(store.findByOidcSubject('sub-bindwrong'), undefined);
  assert.equal(sessionUserId(res), null);
  await app.close();
});

test('POST /link bind: refuses to bind to a pure-OIDC account even with a tampered password', async () => {
  allowBind = true;
  // a pre-existing pure SSO account (no local password) must not be bindable as a "target"
  store.upsertOidcUser({ subject: 'sub-existing-oidc', username: 'oidconly', isAdmin: false }, { autoCreate: true, mapAdmin: false });
  const app = await makeApp();
  const c = await seed(app, { subject: 'sub-bind-into-oidc', username: 'whatever' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/oidc/link',
    headers: { cookie: c, 'content-type': 'application/json' },
    payload: { mode: 'bind', username: 'oidconly', password: '' },
  });
  assert.equal(res.statusCode, 401); // uniform "用户名或密码错误", no account enumeration
  await app.close();
});

test('POST /link: missing/expired pending cookie returns 400', async () => {
  const app = await makeApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/oidc/link',
    headers: { 'content-type': 'application/json' },
    payload: { mode: 'create' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /link: a pending link is single-use (consumed on success)', async () => {
  allowRegister = true;
  const app = await makeApp();
  const c = await seed(app, { subject: 'sub-once', username: 'onceuser' });
  const first = await app.inject({
    method: 'POST',
    url: '/api/auth/oidc/link',
    headers: { cookie: c, 'content-type': 'application/json' },
    payload: { mode: 'create' },
  });
  assert.equal(first.statusCode, 200);
  // replaying the same cookie must fail: the second time the subject is already registered → logs into it,
  // which is fine, but the pending token itself is gone. Re-using the cookie still resolves via findByOidcSubject.
  const again = await app.inject({
    method: 'POST',
    url: '/api/auth/oidc/link',
    headers: { cookie: c, 'content-type': 'application/json' },
    payload: { mode: 'create' },
  });
  // pending consumed → 400 (no pending), proving the暂存 is single-use
  assert.equal(again.statusCode, 400);
  await app.close();
});
