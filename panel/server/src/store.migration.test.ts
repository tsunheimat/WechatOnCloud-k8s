import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

// store.ts captures PANEL_DATA at module load, so set it (and pre-write the file) BEFORE importing.
const dir = mkdtempSync(join(tmpdir(), 'woc-store-mig-'));
const FILE = join(dir, 'accounts.json');
process.env.PANEL_DATA = FILE;
process.env.PANEL_ADMIN_PASSWORD = 'mig-strong-pass';

// A hand-edited file like an operator doing closed-enrollment OIDC pre-registration would write:
// two OIDC users missing id+createdAt, plus a record whose id duplicates the admin's.
writeFileSync(
  FILE,
  JSON.stringify({
    users: [
      {
        id: 'admin-fixed',
        username: 'admin',
        role: 'admin',
        passwordHash: '$2a$10$0123456789012345678901uvwxyzABCDEFGHIJKLMNOPQRSTUV',
        disabled: false,
        allowedInstances: [],
        authProvider: 'local',
        createdAt: '2020-01-01T00:00:00.000Z',
        mustChangePassword: false,
      },
      { username: 'sso1', role: 'sub', passwordHash: '', disabled: false, allowedInstances: [], authProvider: 'oidc', oidcSubject: 'sub-aaa' },
      { username: 'sso2', role: 'sub', passwordHash: '', disabled: false, allowedInstances: [], authProvider: 'oidc', oidcSubject: 'sub-bbb' },
      {
        id: 'admin-fixed', // duplicate of the admin's id
        username: 'dup',
        role: 'sub',
        passwordHash: '',
        disabled: false,
        allowedInstances: [],
        authProvider: 'oidc',
        oidcSubject: 'sub-ccc',
        createdAt: '2021-01-01T00:00:00.000Z',
      },
    ],
    instances: [],
  }),
);

const store = await import('./store.js');
store.initStore();

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('initStore: backfills missing id/createdAt for hand-provisioned OIDC users (no identity collapse)', () => {
  const a = store.findByOidcSubject('sub-aaa')!;
  const b = store.findByOidcSubject('sub-bbb')!;
  assert.ok(a && b, 'both OIDC users present');
  assert.ok(a.id && b.id, 'ids backfilled');
  assert.notEqual(a.id, b.id, 'distinct ids — identities not collapsed onto undefined');
  assert.ok(a.createdAt && !Number.isNaN(Date.parse(a.createdAt)), 'createdAt backfilled to a valid ISO date');
});

test('initStore: regenerates duplicate ids so every account id is unique', () => {
  const ids = store.listUsers().map((u) => u.id);
  assert.equal(new Set(ids).size, ids.length, 'all account ids unique after migration');
});

test('initStore: listUsers does not throw on formerly-malformed records (createdAt sort)', () => {
  assert.doesNotThrow(() => store.listUsers());
});
