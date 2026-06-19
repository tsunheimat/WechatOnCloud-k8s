import test from 'node:test';
import assert from 'node:assert/strict';
import { safeName, safeVolPath, tarSingleFile } from './kubernetes-exec.js';

test('safeName accepts normal basenames', () => {
  assert.equal(safeName('hello.txt'), true);
  assert.equal(safeName('微信 文件.zip'), true);
});

test('safeName rejects traversal and empty names', () => {
  assert.equal(safeName(''), false);
  assert.equal(safeName('../x'), false);
  assert.equal(safeName('a/b'), false);
  assert.equal(safeName('..'), false);
});

test('safeVolPath resolves paths under /config', () => {
  assert.equal(safeVolPath(''), '/config');
  assert.equal(safeVolPath('/Desktop'), '/config/Desktop');
  assert.equal(safeVolPath('a/./b'), '/config/a/b');
});

test('safeVolPath rejects parent traversal', () => {
  assert.throws(() => safeVolPath('../secret'), /路径不合法/);
});

test('tarSingleFile creates a tar archive containing the filename', () => {
  const tar = tarSingleFile('hello.txt', Buffer.from('abc'));
  assert.equal(tar.subarray(0, 9).toString('utf8'), 'hello.txt');
  assert.equal(tar.length % 512, 0);
});

test('tarSingleFile keeps a multibyte name valid and inside the 100-byte name field', () => {
  // 40 × "微" (3 bytes each) = 120 UTF-8 bytes, well over the 100-byte ustar name field. safeName permits
  // such names, so the encoder must truncate on a codepoint boundary instead of splitting one / overflowing.
  const tar = tarSingleFile('微'.repeat(40), Buffer.from('x'));
  const nameField = tar.subarray(0, 100);
  const nul = nameField.indexOf(0);
  const encoded = nameField.subarray(0, nul === -1 ? 100 : nul);
  assert.ok(encoded.length <= 100);
  // Re-encoding the decoded text yields the same bytes ⇒ no split codepoint, valid UTF-8.
  assert.equal(Buffer.from(encoded.toString('utf8'), 'utf8').equals(encoded), true);
  assert.equal(tar.length % 512, 0);
});
