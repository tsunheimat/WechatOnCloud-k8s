import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBool,
  readOidcConfig,
  resolveUsername,
  resolveGroups,
  isAdminFromGroups,
  normalizeIdentity,
  type OidcConfig,
} from './oidc.js';

function cfg(over: Partial<OidcConfig> = {}): OidcConfig {
  return {
    enabled: true,
    issuer: 'https://idp.example.com/',
    clientId: 'cid',
    clientSecret: 'secret',
    redirectUri: undefined,
    scopes: 'openid profile email',
    usernameClaim: 'preferred_username',
    autoCreate: true,
    groupsClaim: 'groups',
    adminGroup: '',
    displayName: 'SSO',
    postLogout: false,
    ...over,
  };
}

test('parseBool: empty uses default, falsey words are false, others true', () => {
  assert.equal(parseBool(undefined, true), true);
  assert.equal(parseBool('', false), false);
  assert.equal(parseBool('false', true), false);
  assert.equal(parseBool('0', true), false);
  assert.equal(parseBool('OFF', true), false);
  assert.equal(parseBool('no', true), false);
  assert.equal(parseBool('true', false), true);
  assert.equal(parseBool('1', false), true);
  assert.equal(parseBool('yes', false), true);
});

test('readOidcConfig: enabled only when issuer+clientId+secret all present', () => {
  assert.equal(readOidcConfig({}).enabled, false);
  assert.equal(readOidcConfig({ OIDC_ISSUER: 'x', OIDC_CLIENT_ID: 'y' }).enabled, false);
  const c = readOidcConfig({ OIDC_ISSUER: 'https://i/', OIDC_CLIENT_ID: 'y', OIDC_CLIENT_SECRET: 'z' });
  assert.equal(c.enabled, true);
  assert.equal(c.scopes, 'openid profile email'); // default
  assert.equal(c.usernameClaim, 'preferred_username'); // default
  assert.equal(c.autoCreate, true); // default
  assert.equal(c.displayName, 'SSO'); // default
});

test('readOidcConfig: overrides and AUTO_CREATE=false honored', () => {
  const c = readOidcConfig({
    OIDC_ISSUER: 'https://i/',
    OIDC_CLIENT_ID: 'y',
    OIDC_CLIENT_SECRET: 'z',
    OIDC_AUTO_CREATE: 'false',
    OIDC_ADMIN_GROUP: 'woc-admins',
    OIDC_DISPLAY_NAME: 'Authentik',
    OIDC_USERNAME_CLAIM: 'email',
  });
  assert.equal(c.autoCreate, false);
  assert.equal(c.adminGroup, 'woc-admins');
  assert.equal(c.displayName, 'Authentik');
  assert.equal(c.usernameClaim, 'email');
});

test('resolveUsername: configured claim wins, then falls back preferred_username→email→sub', () => {
  assert.equal(resolveUsername({ preferred_username: 'alice' }, cfg()), 'alice');
  // configured claim missing → fall back to email then sub
  assert.equal(resolveUsername({ email: 'bob@x.com' }, cfg()), 'bob@x.com');
  assert.equal(resolveUsername({ sub: 'uid-123' }, cfg()), 'uid-123');
  // explicit usernameClaim override
  assert.equal(resolveUsername({ nick: 'carol', sub: 'uid' }, cfg({ usernameClaim: 'nick' })), 'carol');
  // nothing usable
  assert.equal(resolveUsername({}, cfg()), null);
});

test('resolveUsername: strips control chars and caps length', () => {
  assert.equal(resolveUsername({ preferred_username: '  spaced  ' }, cfg()), 'spaced');
  assert.equal(resolveUsername({ preferred_username: 'a\tb\nc' }, cfg()), 'abc');
});

test('resolveGroups: array, comma/space string, or absent', () => {
  assert.deepEqual(resolveGroups({ groups: ['a', 'b'] }, cfg()), ['a', 'b']);
  assert.deepEqual(resolveGroups({ groups: 'a, b  c' }, cfg()), ['a', 'b', 'c']);
  assert.deepEqual(resolveGroups({}, cfg()), []);
  // non-string entries filtered out
  assert.deepEqual(resolveGroups({ groups: ['a', 2, null, 'b'] as unknown[] }, cfg()), ['a', 'b']);
});

test('isAdminFromGroups: only when adminGroup configured and present', () => {
  assert.equal(isAdminFromGroups(['woc-admins'], cfg({ adminGroup: 'woc-admins' })), true);
  assert.equal(isAdminFromGroups(['users'], cfg({ adminGroup: 'woc-admins' })), false);
  // empty adminGroup never elevates
  assert.equal(isAdminFromGroups(['woc-admins'], cfg({ adminGroup: '' })), false);
});

test('normalizeIdentity: full mapping with admin group', () => {
  const id = normalizeIdentity(
    { sub: 'uid-1', preferred_username: 'alice', email: 'alice@x.com', groups: ['woc-admins'] },
    cfg({ adminGroup: 'woc-admins' }),
  );
  assert.deepEqual(id, { subject: 'uid-1', username: 'alice', email: 'alice@x.com', isAdmin: true });
});

test('normalizeIdentity: non-admin when group missing; email optional', () => {
  const id = normalizeIdentity({ sub: 'uid-2', preferred_username: 'bob' }, cfg({ adminGroup: 'woc-admins' }));
  assert.deepEqual(id, { subject: 'uid-2', username: 'bob', email: undefined, isAdmin: false });
});

test('normalizeIdentity: throws when sub is missing', () => {
  assert.throws(() => normalizeIdentity({ preferred_username: 'x' }, cfg()), /sub/);
});

test('normalizeIdentity: sub-only token still yields a username (sub is the last-resort fallback)', () => {
  const id = normalizeIdentity({ sub: 'uid-9' }, cfg());
  assert.deepEqual(id, { subject: 'uid-9', username: 'uid-9', email: undefined, isAdmin: false });
});

test('normalizeIdentity: keeps sub EXACT — no truncation or normalization (account-binding key)', () => {
  // opaque, case-sensitive, long subject must survive verbatim so distinct users never collapse
  const longSub = 'urn:idp:' + 'A'.repeat(180) + '-CaseSensitive';
  const id = normalizeIdentity({ sub: longSub, preferred_username: 'alice' }, cfg());
  assert.equal(id.subject, longSub);
  assert.equal(id.subject.length, longSub.length);
});

test('normalizeIdentity: rejects empty or overlong sub instead of silently changing it', () => {
  assert.throws(() => normalizeIdentity({ sub: '', preferred_username: 'x' }, cfg()), /sub/);
  assert.throws(() => normalizeIdentity({ sub: 123 as unknown as string, preferred_username: 'x' }, cfg()), /sub/);
  assert.throws(() => normalizeIdentity({ sub: 'x'.repeat(256), preferred_username: 'x' }, cfg()), /过长/);
});
