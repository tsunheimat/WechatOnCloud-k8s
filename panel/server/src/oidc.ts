// OIDC / SSO 登录支持（Authorization Code + PKCE）。
//
// 设计要点：
//  - 通过 OIDC_* 环境变量开关与配置（与面板其它 PANEL_* / WOC_* 约定一致）。三要素
//    （issuer / client_id / client_secret）齐备才算启用。
//  - 与本地用户名密码登录共存（混合模式）：登录页在启用时多出一颗「用 SSO 登录」按钮。
//  - JIT 自动建号由 OIDC_AUTO_CREATE 控制；管理员身份由 OIDC_ADMIN_GROUP + groups 声明映射。
//  - 身份只按稳定的 sub（oidcSubject）匹配既有账户；用户名仅作显示名，撞名时自动加后缀去重（绝不
//    接管既有账户，也不把两个同名的不同 IdP 用户互相挡在门外）。具体落库逻辑见 store.upsertOidcUser。
//
// 本文件把「纯函数」（读配置、claim→用户名/分组/角色映射、身份归一化）与「需要网络的客户端
// 流程」（发现 issuer、构造授权 URL、回调换 token）分开，前者可在 oidc.test.ts 里直接测，
// 后者懒加载、按需 discover 并缓存。
import { Issuer, generators, type Client } from 'openid-client';

export interface OidcConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  // 固定回调 URL；留空则按反代实际收到的请求来源动态推导（见 index.ts deriveRedirectUri）。
  redirectUri?: string;
  scopes: string;
  usernameClaim: string;
  autoCreate: boolean;
  groupsClaim: string;
  adminGroup: string; // 空 = 永不据 OIDC 赋予管理员
  displayName: string; // 登录按钮文案
  icon: string; // 登录按钮图标预设 key（见前端 SsoIcon）；可被面板内设置覆盖
  postLogout: boolean; // 退出时是否跳到 IdP 的 end_session_endpoint
}

// 宽松布尔：'0' / 'false' / 'no' / 'off'（不分大小写）视为 false，空值用 def，其余视为 true。
export function parseBool(v: string | undefined, def: boolean): boolean {
  const s = (v ?? '').trim().toLowerCase();
  if (s === '') return def;
  return !['0', 'false', 'no', 'off'].includes(s);
}

export function readOidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig {
  const issuer = (env.OIDC_ISSUER || '').trim();
  const clientId = (env.OIDC_CLIENT_ID || '').trim();
  const clientSecret = (env.OIDC_CLIENT_SECRET || '').trim();
  return {
    enabled: !!(issuer && clientId && clientSecret),
    issuer,
    clientId,
    clientSecret,
    redirectUri: (env.OIDC_REDIRECT_URI || '').trim() || undefined,
    scopes: (env.OIDC_SCOPES || 'openid profile email').trim(),
    usernameClaim: (env.OIDC_USERNAME_CLAIM || 'preferred_username').trim(),
    autoCreate: parseBool(env.OIDC_AUTO_CREATE, true),
    groupsClaim: (env.OIDC_GROUPS_CLAIM || 'groups').trim(),
    adminGroup: (env.OIDC_ADMIN_GROUP || '').trim(),
    displayName: (env.OIDC_DISPLAY_NAME || 'SSO').trim() || 'SSO',
    icon: (env.OIDC_ICON || 'sso').trim() || 'sso',
    postLogout: parseBool(env.OIDC_POST_LOGOUT, false),
  };
}

export type Claims = Record<string, unknown>;

// 把任意 claim 值收敛成「显示用」文本：去掉控制字符/空白，限长。无效返回 null。
// 仅用于用户名/邮箱等展示字段——绝不可用于 sub（见 resolveSubject）。
function sanitizeText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) return null;
  return s.slice(0, max);
}

function sanitizeUsername(v: unknown): string | null {
  return sanitizeText(v, 64);
}

// sub 是 IdP 的不透明、大小写敏感的稳定标识，是账户绑定/查找的唯一键。原样保留：只校验它是
// 非空字符串、拒绝过长（防撑大账号文件），**绝不**规范化或截断——截断/改写会把首 N 字符相同的
// 不同用户折叠成同一面板账户（账户混淆/接管）。
function resolveSubject(v: unknown): string {
  if (typeof v !== 'string' || v === '') throw new Error('IdP 未返回 sub，无法识别身份');
  if (v.length > 255) throw new Error('IdP 返回的 sub 过长，拒绝登录');
  return v;
}

// 选用户名：优先配置的 usernameClaim，再按 preferred_username → email → sub 兜底。
export function resolveUsername(claims: Claims, cfg: OidcConfig): string | null {
  for (const key of [cfg.usernameClaim, 'preferred_username', 'email', 'sub']) {
    if (!key) continue;
    const u = sanitizeUsername(claims[key]);
    if (u) return u;
  }
  return null;
}

// 取分组：支持数组，或逗号/空白分隔的字符串。
export function resolveGroups(claims: Claims, cfg: OidcConfig): string[] {
  const raw = claims[cfg.groupsClaim];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim());
  if (typeof raw === 'string') return raw.split(/[\s,]+/).filter(Boolean);
  return [];
}

// 是否据 OIDC 赋予管理员：仅当配置了 adminGroup 且其在分组里时。
export function isAdminFromGroups(groups: string[], cfg: OidcConfig): boolean {
  return !!cfg.adminGroup && groups.includes(cfg.adminGroup);
}

// 本次登出是否要跳 IdP 注销（RP-initiated logout）。判据是「会话是否经 SSO 建立」——即会话里有没有存下
// id_token——而非账户来源。关键：绑定到本地账户的「混合账户」其 authProvider 仍是 local，但用 SSO 登录时
// 会话同样带 id_token，也应一并登出 IdP；若改按账户来源判断，这类会话只会清掉本地会话、IdP 侧仍登录，
// 用户可立刻无感重新登入（见 index.ts 登出处理）。纯本地登录的会话无 id_token，自然返回 false。
export function shouldRpLogout(cfg: Pick<OidcConfig, 'enabled' | 'postLogout'>, idTokenHint?: string): boolean {
  return cfg.enabled && cfg.postLogout && !!idTokenHint;
}

export interface OidcIdentity {
  subject: string;
  username: string;
  email?: string;
  isAdmin: boolean;
}

// 把 id_token / userinfo 的 claims 归一化成面板身份。subject / username 缺失即抛错（拒绝登录）。
export function normalizeIdentity(claims: Claims, cfg: OidcConfig): OidcIdentity {
  const subject = resolveSubject(claims.sub);
  const username = resolveUsername(claims, cfg);
  if (!username) throw new Error('IdP 未返回可用的用户名声明');
  const email = sanitizeText(claims.email, 254) || undefined;
  return { subject, username, email, isAdmin: isAdminFromGroups(resolveGroups(claims, cfg), cfg) };
}

// ---------- 需要网络的客户端流程 ----------

// 发现 issuer 并构造 Client，懒加载且缓存（discover 命中 IdP，结果在进程内复用）。
let clientPromise: Promise<Client> | null = null;
export async function getClient(cfg: OidcConfig): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const issuer = await Issuer.discover(cfg.issuer);
      return new issuer.Client({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uris: cfg.redirectUri ? [cfg.redirectUri] : undefined,
        response_types: ['code'],
      });
    })().catch((e) => {
      // 发现失败不要把坏 promise 永久缓存，否则一次网络抖动会让后续每次都立刻失败。
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
}

// 单次登录事务：随 state/nonce/PKCE 一起塞进短时签名 cookie，回调时取回校验（服务端无状态）。
export interface OidcTx {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  redirectUri: string;
}

// 生成授权跳转 URL + 待存的事务。redirectUri 由调用方按请求来源推导或取自配置。
export async function buildAuthUrl(cfg: OidcConfig, redirectUri: string, returnTo: string): Promise<{ url: string; tx: OidcTx }> {
  const client = await getClient(cfg);
  const state = generators.state();
  const nonce = generators.nonce();
  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);
  const url = client.authorizationUrl({
    scope: cfg.scopes,
    state,
    nonce,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return { url, tx: { state, nonce, codeVerifier, returnTo, redirectUri } };
}

// 回调登录结果：归一化身份 + 两项供上游决策的元信息。
export interface OidcLoginResult extends OidcIdentity {
  // 本次「分组判定」是否可信：用于上游决定是否据分组回算管理员角色（见 store.upsertOidcUser）。
  // false（启用了分组映射、id_token 没带分组、userinfo 又取失败）时，不应据「拿不到分组」把既有
  // 管理员降级——那多半是 userinfo 抖动，而非用户真被移出分组。
  groupsReliable: boolean;
  // 原始 id_token：登出时作 id_token_hint 传给 IdP end_session（多数 IdP 据此才认 post_logout_redirect_uri）。
  idToken?: string;
}

// 处理回调：用回调参数 + 事务换 token，校验 state/nonce/PKCE 与 id_token 签名（库负责 JWKS），
// 必要时补取 userinfo 以拿到分组，最后归一化成面板身份。
export async function handleCallback(cfg: OidcConfig, params: Record<string, unknown>, tx: OidcTx): Promise<OidcLoginResult> {
  const client = await getClient(cfg);
  const tokenSet = await client.callback(tx.redirectUri, params as any, {
    state: tx.state,
    nonce: tx.nonce,
    code_verifier: tx.codeVerifier,
  });
  let claims: Claims = tokenSet.claims();
  const idTokenHadGroups = claims[cfg.groupsClaim] !== undefined;
  // 不少 IdP 只把 profile/email/groups 放在 userinfo（而非 id_token）。只要有 access_token 就尽力补取
  // 一次 userinfo 合并进来，覆盖 id_token 缺失的声明——否则配了 OIDC_USERNAME_CLAIM=email 之类时会
  // 静默回退到 sub 当用户名，分组也可能拿不到。openid-client 的 userinfo() 会校验返回的 sub 与 id_token
  // 一致，故合并是安全的；取不到不致命，回退到 id_token 现有声明。
  let userinfoOk = false;
  if (tokenSet.access_token) {
    try {
      const info = await client.userinfo(tokenSet);
      claims = { ...claims, ...(info as Claims) };
      userinfoOk = true;
    } catch {
      // ignore：userinfo 端点不可用 / access_token 不适用时，继续用 id_token 声明（见 groupsReliable）。
    }
  }
  // 分组视图可信：没启用管理员映射（角色与分组无关），或 id_token 自带分组，或成功取到 userinfo。
  // 仅当「启用映射 + id_token 无分组 + userinfo 取失败」三者同时成立时不可信——避免据此误降级管理员。
  const groupsReliable = !cfg.adminGroup || idTokenHadGroups || userinfoOk;
  return { ...normalizeIdentity(claims, cfg), groupsReliable, idToken: tokenSet.id_token };
}

// 取 IdP 的 end_session_endpoint（RP-initiated logout），拿不到返回 null。
// idTokenHint：登录时存下的 id_token；多数 IdP（Keycloak/Entra/Authentik 等）据它才会认
// post_logout_redirect_uri 并跳过二次确认页，故有则带上。
export async function endSessionUrl(
  cfg: OidcConfig,
  postLogoutRedirect: string,
  idTokenHint?: string,
): Promise<string | null> {
  try {
    const client = await getClient(cfg);
    if (!client.issuer.metadata.end_session_endpoint) return null;
    return client.endSessionUrl({
      post_logout_redirect_uri: postLogoutRedirect,
      ...(idTokenHint ? { id_token_hint: idTokenHint } : {}),
    });
  } catch {
    return null;
  }
}
