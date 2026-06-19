import test from 'node:test';
import assert from 'node:assert/strict';
import { dockerRuntime } from './docker-runtime.js';

test('docker runtime exposes the current runtime contract', () => {
  assert.equal(dockerRuntime.kind, 'docker');
  assert.equal(typeof dockerRuntime.ensureRuntimeReady, 'function');
  assert.equal(typeof dockerRuntime.runInstance, 'function');
  assert.equal(typeof dockerRuntime.instanceTarget, 'function');
});
