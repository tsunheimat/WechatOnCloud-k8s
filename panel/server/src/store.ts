import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

export type Role = 'admin' | 'sub';

// 账户来源：local = 本地用户名密码；oidc = 经外部 IdP（SSO）登录、自动/手动登记的账户。
// 缺省（旧账号文件无此字段）= local，见 userAuthProvider / initStore 迁移。
export type AuthProvider = 'local' | 'oidc';

export interface User {
  id: string;
  username: string;
  role: Role;
  // 本地账户的 bcrypt 口令哈希；OIDC 账户无本地口令，为空串（verifyPassword 直接拒绝）。
  passwordHash: string;
  disabled: boolean;
  // 账户来源。缺省视为 'local'（见 userAuthProvider）。
  authProvider?: AuthProvider;
  // OIDC 账户的稳定主体标识（id_token 的 sub）；身份只按它匹配，用户名仅作显示名。
  oidcSubject?: string;
  // OIDC 账户的邮箱（若 IdP 提供），仅作展示/审计。
  email?: string;
  createdAt: string;
  // 该账户可访问的微信实例 id 列表。admin 隐式全部，忽略此字段。
  allowedInstances: string[];
  // 仍在使用初始默认密码时为 true，前端据此提示尽快改密；任意一次改密/重置后清除。
  mustChangePassword?: boolean;
  // 离线密码找回：在 accounts.json 手动把某用户置为 true，重启面板即重置其密码并清除此标记。
  // 兼容下划线写法 reset_password。
  resetPassword?: boolean;
  reset_password?: boolean;
}

// 初始默认管理员密码；管理员仍在用它时强烈提示改密。
const DEFAULT_ADMIN_PASSWORD = 'wechat';

// v1.2.0：实例可承载多种应用（不止微信）。同一镜像运行时按 appType 安装/启动对应应用。
export type AppType = 'wechat' | 'telegram' | 'chromium' | 'custom';
export const APP_TYPES: AppType[] = ['wechat', 'telegram', 'chromium', 'custom'];
export const APP_LABELS: Record<AppType, string> = {
  wechat: '微信',
  telegram: 'Telegram',
  chromium: '浏览器',
  custom: '自定义应用',
};
// 向后兼容：v1.2.0 之前创建的实例没有 appType 字段，一律视为微信。
export function instanceAppType(i: Instance): AppType {
  return i.appType && APP_TYPES.includes(i.appType) ? i.appType : 'wechat';
}

export interface Instance {
  id: string; // 短 id，用于容器/卷命名
  name: string; // 显示名
  appType?: AppType; // 承载的应用类型；缺省（老实例）= wechat（见 instanceAppType）
  icon?: string; // 自定义图标：data: 图片(base64) 或 builtin:<key>；缺省按 appType 取默认图标
  containerName: string; // woc-wx-<id>
  volumeName: string; // woc-data-<id>
  kasmUser: string; // 随机生成，服务端注入反代，永不下发前端
  kasmPassword: string;
  createdAt: string;
  createdBy: string; // userId
  // 自定义应用（appType=custom）：用户上传的安装包信息，autostart 据此启动。
  customLaunch?: string; // 启动命令（容器内绝对路径或命令）
  // 自愈 watchdog 的"安全阀"，per-instance 覆盖全局默认；缺省时使用 env / 内置默认。
  // soft：内存超此值时，仅在"当前没有用户在远程会话"才主动重启（柔和自愈）；
  // hard：内存超此值时，无论是否有人在会话都重启（防止 OOM 拖垮宿主）。
  memSoftLimitMB?: number;
  memHardLimitMB?: number;
}

// 面板级全局设置（持久化进 accounts.json）。
export interface Settings {
  // 实例桌面深色模式：由面板顶栏的主题开关统一控制（管理员）。true=实例内应用走深色。
  // 既作为新建/重启实例的初始明暗（经容器环境 WOC_DARK 下发），也用于对运行中实例实时切换。
  desktopDark?: boolean;
  // SSO/OIDC 面板内可调项（管理员设置页）。各项覆盖对应环境变量默认；undefined = 跟随环境默认。
  // 有效值的合并（与环境默认）在 index.ts 进行，store 只存「覆盖」本身。
  oidcAllowRegister?: boolean; // 允许 SSO 自助注册（首次登录可新建账户）；默认随 OIDC_AUTO_CREATE
  oidcAllowBind?: boolean; // 允许把 SSO 身份绑定到已有本地账户（默认开）
  oidcIcon?: string; // 登录按钮的 SSO 图标预设 key（默认随 OIDC_ICON）
}

interface Data {
  users: User[];
  instances: Instance[];
  settings?: Settings;
}

const FILE = process.env.PANEL_DATA || '/data/panel/accounts.json';

let data: Data = { users: [], instances: [] };

function persist() {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, FILE);
}

function makeUser(username: string, password: string, role: Role): User {
  return {
    id: randomUUID(),
    username,
    role,
    passwordHash: bcrypt.hashSync(password, 10),
    disabled: false,
    createdAt: new Date().toISOString(),
    allowedInstances: [],
  };
}

export function initStore() {
  if (existsSync(FILE)) {
    data = JSON.parse(readFileSync(FILE, 'utf8'));
  } else {
    data = { users: [], instances: [] };
  }
  // 迁移：补齐新增字段，兼容旧账号文件；并修复手工编辑（如离线预登记 OIDC 用户）可能缺失/重复的
  // 关键运行时字段。id 缺失会让会话键到 undefined、多个无 id 用户在 findById 时坍缩成同一条；
  // createdAt 缺失会让 listUsers 的排序在 localeCompare 上抛错。这里统一补齐并去重 id（兜底防呆）。
  if (!Array.isArray(data.instances)) data.instances = [];
  const seenIds = new Set<string>();
  for (const u of data.users) {
    if (!Array.isArray(u.allowedInstances)) u.allowedInstances = [];
    // 旧账号文件无 authProvider：一律视为本地账户（有 oidcSubject 的才是 OIDC）。
    if (!u.authProvider) u.authProvider = u.oidcSubject ? 'oidc' : 'local';
    // id 缺失或与已见 id 重复 → 生成新的唯一 id（避免身份坍缩）。
    if (!u.id || seenIds.has(u.id)) u.id = randomUUID();
    seenIds.add(u.id);
    if (!u.createdAt) u.createdAt = new Date().toISOString();
  }
  // 确保始终有一个**本地**管理员作为「保命」账户。只检查「有没有管理员」是不够的：若部署只手工
  // 预登记了 OIDC 管理员（闭环登记流程），那些 OIDC 管理员可被单独禁用/删除、也可能因 IdP 抖动/移出
  // 分组而降级——一旦清空就再无任何管理员，且 OIDC 账户的离线密码找回被禁用，等于永久锁死。本地管理员
  // 受保护、永不可禁用/删除（见 setDisabled/deleteUser），故这里以「本地管理员」为基准兜底。
  // 正常部署首启就有本地管理员，此分支不触发；仅 OIDC-only 的新部署会补建一个。
  if (!data.users.some((u) => u.role === 'admin' && userAuthProvider(u) === 'local')) {
    const username = process.env.PANEL_ADMIN_USER || 'admin';
    const password = process.env.PANEL_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
    const admin = makeUser(username, password, 'admin');
    // 用默认密码初始化时标记，提醒尽快改密
    if (password === DEFAULT_ADMIN_PASSWORD) admin.mustChangePassword = true;
    data.users.push(admin);
    console.log(`[store] 已初始化本地管理员账号 '${username}'`);
  } else {
    // 兼容旧账号文件：本地管理员若仍能用默认密码登录，补打"需改密"标记（OIDC 管理员无本地口令，跳过）
    for (const u of data.users) {
      if (u.role === 'admin' && userAuthProvider(u) === 'local' && u.mustChangePassword === undefined) {
        u.mustChangePassword = bcrypt.compareSync(DEFAULT_ADMIN_PASSWORD, u.passwordHash);
      }
    }
  }
  // 离线密码找回：忘记超管密码时，停掉面板 → 在 accounts.json 给该用户加 "resetPassword": true
  // → 重启面板。这里把其密码重置为 PANEL_ADMIN_PASSWORD（默认 wechat）、解禁，并清除标记。
  for (const u of data.users) {
    if ((u as any).resetPassword === true || (u as any).reset_password === true) {
      // SSO 账户无本地口令，离线恢复对它无意义：清掉标记并跳过，绝不写哈希制造本地登录后门。
      if (userAuthProvider(u) === 'oidc') {
        delete (u as any).resetPassword;
        delete (u as any).reset_password;
        console.log(`[store] 跳过 SSO 账户 '${u.username}' 的离线密码重置（SSO 账户无本地口令，请在 IdP 处管理）`);
        continue;
      }
      const pw = process.env.PANEL_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
      u.passwordHash = bcrypt.hashSync(pw, 10);
      u.mustChangePassword = pw === DEFAULT_ADMIN_PASSWORD; // 重置成默认密码则提示尽快改密
      u.disabled = false;
      delete (u as any).resetPassword;
      delete (u as any).reset_password;
      console.log(`[store] 已重置用户 '${u.username}' 的密码（resetPassword 标记，密码=PANEL_ADMIN_PASSWORD 或默认 wechat）`);
    }
  }
  persist();
}

// ---------- 全局设置 ----------
export function getSettings(): Settings {
  return data.settings || (data.settings = {});
}

export function getDesktopDark(): boolean {
  return !!getSettings().desktopDark;
}

export function setDesktopDark(v: boolean) {
  getSettings().desktopDark = !!v;
  persist();
}

// SSO/OIDC 面板内可调项的「覆盖」原值（undefined = 跟随环境默认，由 index.ts 合并）。
export function getOidcSettings(): { allowRegister?: boolean; allowBind?: boolean; icon?: string } {
  const s = getSettings();
  return { allowRegister: s.oidcAllowRegister, allowBind: s.oidcAllowBind, icon: s.oidcIcon };
}

// 写入/清除覆盖：传 boolean/string 设覆盖，传 null 删覆盖（恢复跟随环境默认），不传（undefined）则不动。
export function setOidcSettings(patch: { allowRegister?: boolean | null; allowBind?: boolean | null; icon?: string | null }) {
  const s = getSettings();
  if (patch.allowRegister !== undefined) {
    if (patch.allowRegister === null) delete s.oidcAllowRegister;
    else s.oidcAllowRegister = !!patch.allowRegister;
  }
  if (patch.allowBind !== undefined) {
    if (patch.allowBind === null) delete s.oidcAllowBind;
    else s.oidcAllowBind = !!patch.allowBind;
  }
  if (patch.icon !== undefined) {
    if (patch.icon === null || patch.icon === '') delete s.oidcIcon;
    else s.oidcIcon = patch.icon;
  }
  persist();
  return getOidcSettings();
}

// ---------- 用户 ----------
export function userAuthProvider(u: User): AuthProvider {
  return u.authProvider || (u.oidcSubject ? 'oidc' : 'local');
}

export function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: u.disabled,
    createdAt: u.createdAt,
    allowedInstances: u.role === 'admin' ? [] : u.allowedInstances,
    mustChangePassword: !!u.mustChangePassword,
    authProvider: userAuthProvider(u),
    // 「混合账户」：本地账户额外绑定了 SSO 身份（authProvider 仍为 local，但可经 SSO 登录）。
    // 纯 OIDC 账户的 SSO 来源已由 authProvider==='oidc' 表达，这里只标记本地账户上的绑定。
    ssoLinked: userAuthProvider(u) === 'local' && !!u.oidcSubject,
  };
}

export function findByUsername(username: string) {
  return data.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
}

export function findByOidcSubject(subject: string) {
  return data.users.find((u) => u.oidcSubject === subject);
}

export function findById(id: string) {
  return data.users.find((u) => u.id === id);
}

export function listUsers() {
  return data.users
    .slice()
    .sort((a, b) => (a.role === b.role ? a.createdAt.localeCompare(b.createdAt) : a.role === 'admin' ? -1 : 1))
    .map(publicUser);
}

export function verifyPassword(u: User, password: string) {
  // SSO 账户只能走 IdP：即便账号文件里因离线恢复/手改/迁移被写入了口令哈希，也一律拒绝本地登录。
  // 不靠「passwordHash 为空」来判定——那只是常态，不是不变量。
  if (userAuthProvider(u) === 'oidc') return false;
  if (!u.passwordHash) return false;
  return bcrypt.compareSync(password, u.passwordHash);
}

export function createSub(username: string, password: string, allowedInstances: string[] = []) {
  if (findByUsername(username)) throw new Error('用户名已存在');
  const u = makeUser(username, password, 'sub');
  u.allowedInstances = sanitizeInstanceIds(allowedInstances);
  data.users.push(u);
  persist();
  return publicUser(u);
}

// OIDC 登录：按稳定 subject 匹配既有账户并对账（邮箱 / 管理员角色），否则按 autoCreate 决定是否
// JIT 建号。身份只认 subject —— 用户名仅作显示名，撞名时自动加后缀去重（绝不接管既有账户）。
//   identity: 归一化后的 IdP 身份（见 oidc.normalizeIdentity）
//   opts.autoCreate: 未登记身份是否自动建号（OIDC_AUTO_CREATE）
//   opts.mapAdmin: 是否据 IdP 分组对账管理员角色（仅在配置了 OIDC_ADMIN_GROUP 时为 true）
//   opts.adminReliable: 本次「分组判定」是否可信（见 oidc.handleCallback 的 groupsReliable）。缺省视为
//     可信。为 false 时跳过「据分组降级管理员」，避免 userinfo 抖动把既有管理员误降级。
export interface OidcUpsertIdentity {
  subject: string;
  username: string;
  email?: string;
  isAdmin: boolean;
}
export function upsertOidcUser(
  identity: OidcUpsertIdentity,
  opts: { autoCreate: boolean; mapAdmin: boolean; adminReliable?: boolean },
): User {
  const adminReliable = opts.adminReliable !== false; // 缺省可信
  const existing = findByOidcSubject(identity.subject);
  if (existing) {
    // 「混合账户」（authProvider=local + oidcSubject，由自助绑定流程产生）：角色与口令由本地管理，OIDC
    // 不回算——否则把 SSO 绑定到本地管理员后，会因未配/不在管理员分组而被按分组误降级（也会丢本地口令登录）。
    // 仅纯 OIDC（JIT 建号）账户才据分组对账邮箱/角色。
    if (userAuthProvider(existing) !== 'oidc') return existing;
    // 每次登录对账：刷新邮箱，并据当前配置重算角色（仅作用于 OIDC 账户）。
    let changed = false;
    if (identity.email && existing.email !== identity.email) {
      existing.email = identity.email;
      changed = true;
    }
    // 角色回算：未配 OIDC_ADMIN_GROUP（mapAdmin=false）→ 与分组无关，强制 sub（收回任何旧 OIDC 管理员，
    // 支持「清空分组配置即降级」）。配了分组：仅当本次分组判定可信(adminReliable)时才据分组升/降级；
    // 不可信（多为 userinfo 抖动）则保留现状，绝不把管理员误降级。
    let role: Role | null = null;
    if (!opts.mapAdmin) role = 'sub';
    else if (adminReliable) role = identity.isAdmin ? 'admin' : 'sub';
    if (role !== null && existing.role !== role) {
      existing.role = role;
      changed = true;
    }
    if (changed) persist();
    return existing;
  }
  if (!opts.autoCreate) {
    throw new Error('该账户尚未在面板登记（OIDC_AUTO_CREATE=false）');
  }
  // 用户名仅作显示名，身份只认 subject。撞名不接管既有账户——改用带后缀的唯一显示名，既防接管，
  // 也避免两个 preferred_username 相同的不同 IdP 用户互相把对方挡在门外。
  let username = identity.username;
  if (findByUsername(username)) {
    let n = 2;
    while (findByUsername(`${identity.username}-${n}`)) n++;
    username = `${identity.username}-${n}`;
  }
  const u: User = {
    id: randomUUID(),
    username,
    role: opts.mapAdmin && adminReliable && identity.isAdmin ? 'admin' : 'sub',
    passwordHash: '', // 无本地口令
    disabled: false,
    authProvider: 'oidc',
    oidcSubject: identity.subject,
    email: identity.email,
    createdAt: new Date().toISOString(),
    allowedInstances: [],
  };
  data.users.push(u);
  persist();
  return u;
}

// 把一次 SSO 身份（subject/email）绑定到已有的本地账户，形成「混合账户」：既能本地口令登录，也能 SSO 登录。
// 仅由自助绑定流程调用——用户首次 SSO 登录、又用既有账户的用户名口令通过校验后，才把该 subject 绑定上来。
// 刻意保持 authProvider='local'：
//   - 不丢本地口令登录（verifyPassword 仍据本地口令放行）；
//   - 本地管理员的「保命」保护（永不可禁用/删除、initStore 兜底）继续生效——故允许绑定到管理员账户；
//   - upsertOidcUser 对这类账户跳过「据分组回算角色」（见上），避免被 IdP 分组误降级。
// 守卫：目标须为本地账户（非纯 OIDC）、尚未绑定其它 subject；该 subject 也不能已被别的账户占用。
export function bindOidcToUser(userId: string, identity: { subject: string; email?: string }): User {
  const u = findById(userId);
  if (!u) throw new Error('用户不存在');
  if (userAuthProvider(u) === 'oidc') throw new Error('该账户本身即 SSO 账户，无需绑定');
  if (u.oidcSubject && u.oidcSubject !== identity.subject) throw new Error('该账户已绑定其它 SSO 身份');
  const other = findByOidcSubject(identity.subject);
  if (other && other.id !== u.id) throw new Error('该 SSO 身份已绑定到其它账户');
  u.oidcSubject = identity.subject;
  if (identity.email) u.email = identity.email;
  u.authProvider = 'local'; // 维持本地账户：保留本地口令登录与本地管理员保护
  persist();
  return u;
}

export function setDisabled(id: string, disabled: boolean) {
  const u = findById(id);
  if (!u) throw new Error('用户不存在');
  // 本地管理员是「保命」账户（离线找回的落点），永不可禁用，避免把所有人锁在外面；
  // OIDC 管理员则允许禁用，作为对 SSO 管理员的即时本地吊销——禁用后即便其在 IdP 仍属管理员组，
  // 回调处也会拒绝 disabled 账户，无法再登录（且 disable 路由会立刻销毁其在线会话）。
  if (u.role === 'admin' && userAuthProvider(u) !== 'oidc') throw new Error('不能禁用本地管理员');
  u.disabled = disabled;
  persist();
  return publicUser(u);
}

export function resetPassword(id: string, password: string) {
  const u = findById(id);
  if (!u) throw new Error('用户不存在');
  // SSO 账户无本地口令：拒绝设密码，否则会给本只能走 IdP 的账户开一条本地登录后门。
  if (userAuthProvider(u) === 'oidc') throw new Error('SSO 账户无本地密码，请在身份提供商处管理');
  u.passwordHash = bcrypt.hashSync(password, 10);
  u.mustChangePassword = false; // 改过密就不再提示
  persist();
  return publicUser(u);
}

export function deleteUser(id: string) {
  const u = findById(id);
  if (!u) throw new Error('用户不存在');
  // 同 setDisabled：本地管理员受保护；OIDC 管理员可删除。注意删除并非永久封禁——若其在 IdP 仍属
  // 管理员组且开了自动建号，下次 SSO 登录会被重新创建；要「永久吊销」请用「禁用」。
  if (u.role === 'admin' && userAuthProvider(u) !== 'oidc') throw new Error('不能删除本地管理员');
  data.users = data.users.filter((x) => x.id !== id);
  persist();
}

// 设置某账户可访问的实例（账户侧编辑）
export function setUserInstances(id: string, instanceIds: string[]) {
  const u = findById(id);
  if (!u) throw new Error('用户不存在');
  if (u.role !== 'admin') u.allowedInstances = sanitizeInstanceIds(instanceIds);
  persist();
  return publicUser(u);
}

// ---------- 实例 ----------
function sanitizeInstanceIds(ids: string[]): string[] {
  const valid = new Set(data.instances.map((i) => i.id));
  return [...new Set((ids || []).filter((x) => valid.has(x)))];
}

export function publicInstance(i: Instance) {
  return {
    id: i.id,
    name: i.name,
    appType: instanceAppType(i), // 老实例无字段时回退 wechat
    icon: i.icon,
    createdAt: i.createdAt,
    createdBy: i.createdBy,
    memSoftLimitMB: i.memSoftLimitMB,
    memHardLimitMB: i.memHardLimitMB,
  };
}

// 设置/清除某实例的 mem 安全阀。传 null 表示恢复默认（从对象上删字段）。
// 校验：正整数；soft < hard；上限 20480 MiB（20 GiB）。
export function setInstanceMemLimits(
  id: string,
  softMB: number | null,
  hardMB: number | null,
) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  const norm = (v: number | null): number | undefined => {
    if (v == null) return undefined;
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > 20480) {
      throw new Error('阈值需为 1-20480 之间的整数（MiB）');
    }
    return v;
  };
  const s = norm(softMB);
  const h = norm(hardMB);
  if (s != null && h != null && s >= h) throw new Error('soft 阈值需小于 hard 阈值');
  inst.memSoftLimitMB = s;
  inst.memHardLimitMB = h;
  persist();
  return publicInstance(inst);
}

export function listInstances() {
  return data.instances.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function findInstance(id: string) {
  return data.instances.find((i) => i.id === id);
}

// 当前用户可见的实例（admin 全部，sub 按 allowedInstances）
export function userInstances(u: User) {
  if (u.role === 'admin') return listInstances();
  const allowed = new Set(u.allowedInstances);
  return listInstances().filter((i) => allowed.has(i.id));
}

export function userCanAccess(u: User, instanceId: string) {
  if (u.role === 'admin') return !!findInstance(instanceId);
  return u.allowedInstances.includes(instanceId) && !!findInstance(instanceId);
}

// 复用旧卷时：从 woc-data-<id> 解析回 id，让新实例的 containerName / volumeName 都对齐旧卷的
// id（避免出现"卷叫 woc-data-abc，但实例 id 是 def"这种命名错配）。若旧 id 与现存实例冲突或卷名
// 非标准前缀，则退回新生成 id，仅卷名指向旧卷。
function parseIdFromVolume(volumeName: string): string | null {
  const m = /^woc-data-([0-9a-f]{10})$/.exec(volumeName);
  return m ? m[1] : null;
}

export function createInstance(
  name: string,
  createdBy: string,
  allowedUserIds: string[] = [],
  reuseVolumeName?: string,
  appType: AppType = 'wechat',
) {
  const type: AppType = APP_TYPES.includes(appType) ? appType : 'wechat';
  let id = randomBytes(5).toString('hex'); // 10 hex chars
  let volumeName = `woc-data-${id}`;
  if (reuseVolumeName) {
    const reusedId = parseIdFromVolume(reuseVolumeName);
    if (reusedId && !findInstance(reusedId)) {
      id = reusedId;
    }
    volumeName = reuseVolumeName; // 始终指向旧卷（即便 id 是新生成的）
  }
  const inst: Instance = {
    id,
    name: name.trim() || `${APP_LABELS[type]}-${id.slice(0, 4)}`,
    appType: type,
    containerName: `woc-wx-${id}`,
    volumeName,
    kasmUser: 'woc',
    // 用 hex（仅 0-9a-f）：容器内 init 脚本以 `openssl passwd -apr1 ${PASSWORD}` 未加引号方式生成 .htpasswd，
    // base64url 可能含前导 '-' 而被 openssl 当作命令行选项，导致密码哈希为空、所有鉴权失败。hex 不含任何 shell 特殊字符。
    kasmPassword: randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
    createdBy,
  };
  data.instances.push(inst);
  // 把访问权限写到选中的账户上
  for (const uid of allowedUserIds || []) {
    const u = findById(uid);
    if (u && u.role !== 'admin' && !u.allowedInstances.includes(id)) {
      u.allowedInstances.push(id);
    }
  }
  persist();
  return inst;
}

export function renameInstance(id: string, name: string) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  const n = (name || '').trim();
  if (!n || n.length > 30) throw new Error('实例名称为 1-30 个字符');
  inst.name = n;
  persist();
  return publicInstance(inst);
}

// 设置/清除实例自定义图标。传空 → 恢复按 appType 的默认图标。
// 仅允许 builtin:<key> 或 data:image/...（裁剪后约 128px，限 ~225KB，防滥用撑大 accounts.json）。
export function setInstanceIcon(id: string, icon: string | null) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  const v = (icon ?? '').trim();
  if (!v) {
    delete inst.icon;
  } else if (/^builtin:[a-z0-9_-]{1,32}$/.test(v) || (v.startsWith('data:image/') && v.length <= 300000)) {
    inst.icon = v;
  } else {
    throw new Error('图标格式不合法或过大');
  }
  persist();
  return publicInstance(inst);
}

export function removeInstance(id: string) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  data.instances = data.instances.filter((i) => i.id !== id);
  // 从所有账户的可访问列表里移除
  for (const u of data.users) {
    u.allowedInstances = u.allowedInstances.filter((x) => x !== id);
  }
  persist();
  return inst;
}

// 设置某实例可被哪些账户访问（实例侧编辑）
export function setInstanceUsers(id: string, userIds: string[]) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  const allow = new Set(userIds || []);
  for (const u of data.users) {
    if (u.role === 'admin') continue;
    const has = u.allowedInstances.includes(id);
    if (allow.has(u.id) && !has) u.allowedInstances.push(id);
    if (!allow.has(u.id) && has) u.allowedInstances = u.allowedInstances.filter((x) => x !== id);
  }
  persist();
  return inst;
}

// 已登记一个实例（迁移用：复用旧 ./data 卷）。返回是否新建。
export function registerExistingInstance(opts: {
  name: string;
  containerName: string;
  volumeName: string;
  kasmUser: string;
  kasmPassword: string;
  createdBy: string;
}) {
  const id = randomBytes(5).toString('hex');
  const inst: Instance = { id, createdAt: new Date().toISOString(), ...opts };
  data.instances.push(inst);
  persist();
  return inst;
}
