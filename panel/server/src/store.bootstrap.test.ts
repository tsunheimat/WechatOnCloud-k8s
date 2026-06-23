import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

// Pre-write the data file BEFORE importing store (it captures PANEL_DATA at module load).
const dir = mkdtempSync(join(tmpdir(), 'woc-store-boot-'));
const FILE = join(dir, 'accounts.json');
process.env.PANEL_DATA = FILE;
process.env.PANEL_ADMIN_PASSWORD = 'boot-strong-pass';

// A closed-enrollment deployment that hand-registered ONLY an OIDC admin and no local admin.
writeFileSync(
  FILE,
  JSON.stringify({
    users: [
      {
        id: 'oidc-admin-1',
        username: 'ssoboss',
        role: 'admin',
        passwordHash: '',
        disabled: false,
        allowedInstances: [],
        authProvider: 'oidc',
        oidcSubject: 'sub-boss',
        createdAt: '2022-01-01T00:00:00.000Z',
      },
    ],
    instances: [],
  }),
);

const store = await import('./store.js');
store.initStore();

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('initStore: an OIDC-only admin deployment still gets a protected local break-glass admin', () => {
  const local = store.findByUsername('admin');
  assert.ok(local, 'a local admin was created even though an OIDC admin already existed');
  assert.equal(local!.role, 'admin');
  assert.equal(store.userAuthProvider(local!), 'local');
  // it is the break-glass account: cannot be disabled or deleted
  assert.throws(() => store.setDisabled(local!.id, true), /本地管理员/);
  assert.throws(() => store.deleteUser(local!.id), /本地管理员/);
  // the pre-registered OIDC admin still exists alongside it
  assert.ok(store.findByOidcSubject('sub-boss'), 'pre-registered OIDC admin preserved');
});
