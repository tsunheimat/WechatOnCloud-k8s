// 从请求头里安全地解析「面板对外可见的 host[:port]」，用于拼 OIDC 回调 / 注销地址。
//
// 为什么单独成模块、且不能只用 host-guard.parseHost：
//   parseHost 只按「末个冒号 / 方括号」切，不识别 URL 的 userinfo（`user@host`）。于是
//   `127.0.0.1:8080@evil.com`、`[::1]@evil.com` 这类会被 parseHost 误判成 loopback 而「通过白名单」，
//   但浏览器 / URL 解析器把 `@` 之前当用户名、真正的 host 是 evil.com。若直接把这种原始串拼进
//   redirect_uri 发给 IdP，等于把回调指向攻击者域名。
// 因此这里用 new URL 规范化：拒绝带 userinfo / 路径 / 反斜杠 / 空白 / 控制字符的候选，再拿解析出的
//   hostname 过同一套白名单，最后只返回**规范化后**的 host[:port]。纯函数，便于单测覆盖各种恶意输入。
import { isAllowedHost } from './host-guard.js';

// host[:port] 合法字符：字母数字、`.`、`-`、`:`（端口 / IPv6）、`[` `]`（IPv6 字面量）。
// 其余（含 @ / \ 空白 控制符 路径）一律视为非法，先在字符层挡掉，再交给 URL 解析做二次校验。
const HOST_CHARS = /^[a-zA-Z0-9.\-:[\]]+$/;

// 解析单个候选 host 串：合法且通过白名单则返回规范化 host[:port]，否则 null。
export function validatedHost(candidate: string | undefined, allowlist: string[]): string | null {
  const c = (candidate || '').trim();
  if (!c || !HOST_CHARS.test(c)) return null;
  let u: URL;
  try {
    u = new URL('https://' + c);
  } catch {
    return null;
  }
  // 解析后不得带 userinfo，且必须「只有 host[:port]」——无路径 / 查询 / 片段。
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
  if (!isAllowedHost(u.hostname.toLowerCase(), allowlist)) return null;
  return u.host; // 规范化（小写、去多余）的 host[:port]
}

// 选「对外可见 host」：优先（已校验的）X-Forwarded-Host，回退 Host。两者都不合法 → ''（调用方据此
// 失败关闭：要么报错让用户配 OIDC_REDIRECT_URI，要么跳过注销重定向，绝不拼出攻击者可控的地址）。
export function pickPublicHost(
  hostHeader: string | undefined,
  forwardedHost: string | string[] | undefined,
  allowlist: string[],
): string {
  const fwd = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
  const xfh = (fwd || '').split(',')[0]; // 多级代理链取最外层（客户端可见）的第一个
  return validatedHost(xfh, allowlist) || validatedHost(hostHeader, allowlist) || '';
}
