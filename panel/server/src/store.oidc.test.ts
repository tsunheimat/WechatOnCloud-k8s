import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

// store.ts captures the data-file path from PANEL_DATA at module load, so set it BEFORE importing.
const dir = mkdtempSync(join(tmpdir(), 'woc-store-oidc-'));
process.env.PANEL_DATA = join(dir, 'accounts.json');
process.env.PANEL_ADMIN_PASSWORD = 'admin-pass-xyz'; // avoid the default-password must-change path noise

const store = await import('./store.js');
store.initStore();

test.after(() => rmSync(dir, { recursive: true, force: true }));

const ident = (over: Partial<{ subject: string; username: string; email?: string; isAdmin: boolean }> = {}) => ({
  subject: 'sub-1',
  username: 'alice',
  email: 'alice@example.com',
  isAdmin: false,
  ...over,
});

test('upsertOidcUser: auto-creates a sub account with no local password', () => {
  const u = store.upsertOidcUser(ident(), { autoCreate: true, mapAdmin: false });
  assert.equal(u.role, 'sub');
  assert.equal(u.authProvider, 'oidc');
  assert.equal(u.oidcSubject, 'sub-1');
  assert.equal(u.email, 'alice@example.com');
  assert.equal(u.passwordHash, '');
  assert.deepEqual(u.allowedInstances, []);
  // no local login possible
  assert.equal(store.verifyPassword(u, ''), false);
  assert.equal(store.verifyPassword(u, 'anything'), false);
  // public shape exposes provider
  assert.equal(store.publicUser(u).authProvider, 'oidc');
});

test('upsertOidcUser: same subject reconciles (idempotent, updates email)', () => {
  const before = store.findByOidcSubject('sub-1');
  const u = store.upsertOidcUser(ident({ email: 'alice2@example.com' }), { autoCreate: true, mapAdmin: false });
  assert.equal(u.id, before!.id); // same account, not a duplicate
  assert.equal(u.email, 'alice2@example.com');
  assert.equal(store.listUsers().filter((x) => x.username === 'alice').length, 1);
});

test('upsertOidcUser: mapAdmin promotes/demotes by group flag', () => {
  let u = store.upsertOidcUser(ident({ isAdmin: true }), { autoCreate: true, mapAdmin: true });
  assert.equal(u.role, 'admin');
  u = store.upsertOidcUser(ident({ isAdmin: false }), { autoCreate: true, mapAdmin: true });
  assert.equal(u.role, 'sub'); // demoted when group lost
});

test('upsertOidcUser: mapAdmin=false forces sub role (no OIDC admin without a configured group)', () => {
  // no admin-group mapping → isAdmin is ignored, role is always sub
  const u = store.upsertOidcUser(ident({ isAdmin: true }), { autoCreate: true, mapAdmin: false });
  assert.equal(u.role, 'sub');
});

test('upsertOidcUser: clearing OIDC_ADMIN_GROUP (mapAdmin=false) demotes a prior OIDC admin on next login', () => {
  // promoted while the group was configured
  let u = store.upsertOidcUser(ident({ subject: 'sub-demote', username: 'demoteme', isAdmin: true }), {
    autoCreate: true,
    mapAdmin: true,
  });
  assert.equal(u.role, 'admin');
  // operator later clears OIDC_ADMIN_GROUP → mapAdmin=false → next login must reconcile back to sub,
  // not leave a stale admin that the group can no longer demote.
  u = store.upsertOidcUser(ident({ subject: 'sub-demote', username: 'demoteme', isAdmin: true }), {
    autoCreate: true,
    mapAdmin: false,
  });
  assert.equal(u.role, 'sub');
});

test('upsertOidcUser: a new subject whose username collides gets a disambiguated name (no takeover, no lockout)', () => {
  store.createSub('localbob', 'pw-123456');
  const orig = store.findByUsername('localbob')!;
  const u = store.upsertOidcUser(ident({ subject: 'sub-new', username: 'localbob' }), { autoCreate: true, mapAdmin: false });
  assert.notEqual(u.username, 'localbob'); // did NOT take over the existing account
  assert.match(u.username, /^localbob-\d+$/); // got a suffixed unique display name
  assert.equal(u.oidcSubject, 'sub-new');
  assert.equal(u.role, 'sub');
  assert.notEqual(u.id, orig.id); // distinct account
  // the original local account is untouched and still resolves to itself
  assert.equal(store.findByUsername('localbob')!.id, orig.id);
});

test('upsertOidcUser: adminReliable=false keeps an existing admin (no demote on userinfo blip)', () => {
  // promote while groups are reliable
  let u = store.upsertOidcUser(ident({ subject: 'sub-rel', username: 'reluser', isAdmin: true }), {
    autoCreate: true,
    mapAdmin: true,
    adminReliable: true,
  });
  assert.equal(u.role, 'admin');
  // a login where the groups view is UNreliable (userinfo failed) must NOT demote
  u = store.upsertOidcUser(ident({ subject: 'sub-rel', username: 'reluser', isAdmin: false }), {
    autoCreate: true,
    mapAdmin: true,
    adminReliable: false,
  });
  assert.equal(u.role, 'admin'); // preserved
  // once groups are reliable again and the user truly lacks the group, demotion proceeds
  u = store.upsertOidcUser(ident({ subject: 'sub-rel', username: 'reluser', isAdmin: false }), {
    autoCreate: true,
    mapAdmin: true,
    adminReliable: true,
  });
  assert.equal(u.role, 'sub');
});

test('verifyPassword: OIDC account rejected even if a password hash is somehow present', () => {
  // 模拟离线恢复/手改账号文件把哈希塞进 SSO 账户：仍必须拒绝本地登录（按 authProvider 判定，非空哈希）。
  const u = store.upsertOidcUser(ident({ subject: 'sub-vp', username: 'vpuser' }), { autoCreate: true, mapAdmin: false });
  const tampered = { ...u, passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV' };
  assert.equal(store.verifyPassword(tampered, 'whatever'), false);
});

test('resetPassword: rejected for OIDC accounts (no local-login backdoor)', () => {
  const u = store.upsertOidcUser(ident({ subject: 'sub-reset', username: 'resetme' }), { autoCreate: true, mapAdmin: false });
  assert.throws(() => store.resetPassword(u.id, 'newpass123'), /SSO/);
  const after = store.findByOidcSubject('sub-reset')!;
  assert.equal(after.passwordHash, ''); // still no local hash
  assert.equal(store.verifyPassword(after, 'newpass123'), false); // local login still impossible
});

test('setDisabled/deleteUser: OIDC admins are revocable, local admin stays protected', () => {
  const oa = store.upsertOidcUser(ident({ subject: 'sub-admin', username: 'oidcadmin', isAdmin: true }), {
    autoCreate: true,
    mapAdmin: true,
  });
  assert.equal(oa.role, 'admin');
  // an OIDC admin can be disabled (the local revocation kill-switch) and re-enabled
  assert.equal(store.setDisabled(oa.id, true).disabled, true);
  assert.equal(store.setDisabled(oa.id, false).disabled, false);
  // the bootstrap local admin must never be disabled or deleted (break-glass account)
  const local = store.findByUsername('admin')!;
  assert.equal(store.userAuthProvider(local), 'local');
  assert.throws(() => store.setDisabled(local.id, true), /本地管理员/);
  assert.throws(() => store.deleteUser(local.id), /本地管理员/);
  // an OIDC admin can be deleted
  store.deleteUser(oa.id);
  assert.equal(store.findByOidcSubject('sub-admin'), undefined);
});

test('upsertOidcUser: unknown subject rejected when autoCreate is off', () => {
  assert.throws(
    () => store.upsertOidcUser(ident({ subject: 'sub-unprovisioned', username: 'newcomer' }), { autoCreate: false, mapAdmin: false }),
    /未.*登记|AUTO_CREATE/,
  );
  assert.equal(store.findByOidcSubject('sub-unprovisioned'), undefined);
});
