// SSO / IdP 登录按钮图标的「内置预设」。登录页与管理设置页共用同一张表。
// 风格沿用 AppIcon：彩色圆角块 + 白色字形/标志；个别品牌（Microsoft）用白底原色块以贴近官方观感。
// 选 key 由 OIDC_ICON 环境变量或面板内设置决定，后端在 OIDC_ICON_KEYS 里校验，未知一律回退 'sso'。

type Glyph = { bg: string; el: JSX.Element };
const G = (bg: string, el: JSX.Element): Glyph => ({ bg, el });

// 白色字母字形（viewBox 0 0 48 48）
const txt = (s: string, fs = 24, fill = '#fff') => (
  <text
    x="24"
    y="25"
    fill={fill}
    fontSize={fs}
    fontWeight="700"
    textAnchor="middle"
    dominantBaseline="central"
    fontFamily="-apple-system, system-ui, sans-serif"
  >
    {s}
  </text>
);

// 通用「单点登录」：钥匙/锁，无品牌时的中性默认。
const key = (
  <g fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="19" cy="20" r="6" />
    <path d="M23 24l8 8M28 29l3 3 3-3" />
  </g>
);

// GitHub 标志（simple-icons 路径，24 视窗按比例放进 48 块，居中留白）。
const github = (
  <path transform="translate(7.2,7.2) scale(1.4)" fill="#fff" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
);

// Apple 标志（simple-icons 路径）。
const apple = (
  <path transform="translate(7.2,7.2) scale(1.4)" fill="#fff" d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 14.25 3.51 5.61 9.05 5.33c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.51 4.07l-.01-.01zM12.03 5.25C11.85 2.79 13.85.85 16.05.7c.32 2.78-2.51 4.7-4.02 4.55z" />
);

// Microsoft：白底四色方块（红/绿/蓝/黄）。
const microsoft = (
  <g>
    <rect x="11" y="11" width="12" height="12" fill="#f25022" />
    <rect x="25" y="11" width="12" height="12" fill="#7fba00" />
    <rect x="11" y="25" width="12" height="12" fill="#00a4ef" />
    <rect x="25" y="25" width="12" height="12" fill="#ffb900" />
  </g>
);

// key → 字形。表里的顺序即设置页「图标」选择器的展示顺序。
export const SSO_ICONS: Record<string, Glyph> = {
  sso: G('#5b6470', key),
  google: G('#4285f4', txt('G', 26)),
  microsoft: G('#ffffff', microsoft),
  github: G('#181717', github),
  gitlab: G('#fc6d26', txt('GL', 18)),
  authentik: G('#fd4b2d', txt('a', 28)),
  keycloak: G('#008aaa', txt('K', 24)),
  okta: G('#007dc1', txt('O', 24)),
  apple: G('#111111', apple),
};

export const SSO_ICON_CHOICES: { key: string; label: string }[] = [
  { key: 'sso', label: '通用' },
  { key: 'google', label: 'Google' },
  { key: 'microsoft', label: 'Microsoft' },
  { key: 'github', label: 'GitHub' },
  { key: 'gitlab', label: 'GitLab' },
  { key: 'authentik', label: 'Authentik' },
  { key: 'keycloak', label: 'Keycloak' },
  { key: 'okta', label: 'Okta' },
  { key: 'apple', label: 'Apple' },
];

export function SsoIcon({ icon, size = 18, radius = 6 }: { icon?: string; size?: number; radius?: number }) {
  const g = (icon && SSO_ICONS[icon]) || SSO_ICONS.sso;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" style={{ display: 'block', flex: 'none' }} aria-hidden="true">
      <rect width="48" height="48" rx={(radius / size) * 48} fill={g.bg} />
      {g.el}
    </svg>
  );
}
