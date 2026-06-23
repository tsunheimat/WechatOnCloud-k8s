import test from 'node:test';
import assert from 'node:assert/strict';
import { validatedHost, pickPublicHost } from './request-host.js';

const ALLOW = ['woc.example.com', '*.corp.example'];

test('validatedHost: accepts allowlisted public host and canonicalizes', () => {
  assert.equal(validatedHost('woc.example.com', ALLOW), 'woc.example.com');
  assert.equal(validatedHost('WOC.Example.com', ALLOW), 'woc.example.com'); // lowercased
  assert.equal(validatedHost('a.corp.example', ALLOW), 'a.corp.example'); // wildcard
});

test('validatedHost: accepts default loopback / RFC1918 with port', () => {
  assert.equal(validatedHost('127.0.0.1', []), '127.0.0.1');
  assert.equal(validatedHost('192.168.1.5:8080', []), '192.168.1.5:8080');
  assert.equal(validatedHost('[::1]:8443', []), '[::1]:8443');
});

test('validatedHost: rejects non-allowlisted host', () => {
  assert.equal(validatedHost('evil.com', ALLOW), null);
  assert.equal(validatedHost('8.8.8.8', []), null); // public IP, not in default allowlist
});

test('validatedHost: REJECTS userinfo-injection that parseHost would mis-accept (regression)', () => {
  // these validate as loopback/private under host-guard.parseHost, but the real URL host is evil.com
  assert.equal(validatedHost('127.0.0.1:8080@evil.com', []), null);
  assert.equal(validatedHost('[::1]@evil.com', []), null);
  assert.equal(validatedHost('127.0.0.1@evil.com', []), null);
  assert.equal(validatedHost('user:pass@127.0.0.1', []), null);
});

test('validatedHost: rejects path / backslash / whitespace / control chars / empty', () => {
  assert.equal(validatedHost('127.0.0.1/..', []), null);
  assert.equal(validatedHost('127.0.0.1\\@evil.com', []), null);
  assert.equal(validatedHost('woc.example .com', ALLOW), null); // internal space rejected
  assert.equal(validatedHost('127.0.0.1\u0000x', []), null); // embedded NUL (not stripped by trim) rejected
  // a legitimate allowlisted host with only surrounding whitespace is still accepted (trim)
  assert.equal(validatedHost('  woc.example.com  ', ALLOW), 'woc.example.com');
  assert.equal(validatedHost('', []), null);
  assert.equal(validatedHost(undefined, []), null);
});

test('pickPublicHost: prefers a VALID allowlisted X-Forwarded-Host', () => {
  assert.equal(pickPublicHost('10.0.0.5:8080', 'woc.example.com', ALLOW), 'woc.example.com');
});

test('pickPublicHost: falls back to Host when X-Forwarded-Host is not allowlisted (forged)', () => {
  // gate let the request in via an allowlisted Host; forged XFH must NOT win
  assert.equal(pickPublicHost('127.0.0.1', 'evil.com', ALLOW), '127.0.0.1');
  assert.equal(pickPublicHost('192.168.1.5:8080', '127.0.0.1:8080@evil.com', ALLOW), '192.168.1.5:8080');
});

test('pickPublicHost: takes first hop of a comma-chained X-Forwarded-Host', () => {
  assert.equal(pickPublicHost('10.0.0.5', 'woc.example.com, proxy.internal', ALLOW), 'woc.example.com');
});

test('pickPublicHost: returns empty string when nothing validates (fail-closed)', () => {
  assert.equal(pickPublicHost('evil.com', 'also-evil.com', ALLOW), '');
  assert.equal(pickPublicHost(undefined, undefined, ALLOW), '');
});
