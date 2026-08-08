import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  Phase,
  Trigger,
  initialState,
  installShutdownHandlers,
  transition,
} from './shutdown.mjs';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test('TTY SIGINT begins graceful work and second SIGINT forces', () => {
  const first = transition(initialState(true), Trigger.SIGINT);
  assert.equal(first.action, 'begin_graceful');
  assert.equal(first.showForceHint, true);
  const second = transition(first.state, Trigger.SIGINT);
  assert.equal(second.action, 'force');
  assert.equal(second.state.phase, Phase.FORCING);
});

test('TTY Ctrl-D only forces after an interactive SIGINT', () => {
  const before = transition(initialState(true), Trigger.STDIN_EOF);
  assert.equal(before.action, 'ignore');
  const first = transition(initialState(true), Trigger.SIGINT);
  const eof = transition(first.state, Trigger.STDIN_EOF);
  assert.equal(eof.action, 'force');
});

test('non-TTY SIGINT needs one signal and does not arm a force hint', () => {
  const first = transition(initialState(false), Trigger.SIGINT);
  assert.equal(first.action, 'begin_graceful');
  assert.equal(first.showForceHint, false);
});

test('runtime drains once, then a second signal force-closes and flushes once', async () => {
  const proc = new EventEmitter();
  proc.removeListener = proc.removeListener.bind(proc);
  const stdin = new PassThrough();
  Object.defineProperty(stdin, 'isTTY', { value: true });

  const drain = deferred();
  const calls = [];
  const logs = [];
  const logger = {
    info(fields, message) {
      logs.push({ level: 'info', fields, message });
    },
    warn(fields, message) {
      logs.push({ level: 'warn', fields, message });
    },
    error(fields, message) {
      logs.push({ level: 'error', fields, message });
    },
  };

  const controller = installShutdownHandlers({
    processRef: proc,
    stdin,
    logger,
    graceMs: 5_000,
    graceful: async (trigger) => {
      calls.push(`graceful:${trigger}`);
      await drain.promise;
    },
    force: async (trigger) => {
      calls.push(`force:${trigger}`);
    },
    flush: async () => {
      calls.push('flush');
    },
  });

  proc.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.state.phase, Phase.DRAINING);
  assert.deepEqual(calls, ['graceful:sigint']);
  assert.equal(logs.some((entry) => entry.fields.event === 'shutdown_force_available'), true);

  proc.emit('SIGINT');
  const result = await controller.completion;
  assert.deepEqual(result, { forced: true, trigger: Trigger.SIGINT });
  assert.deepEqual(calls, ['graceful:sigint', 'force:sigint', 'flush']);
});

test('TTY EOF after first SIGINT is equivalent to the second Ctrl-C', async () => {
  const proc = new EventEmitter();
  const stdin = new PassThrough();
  Object.defineProperty(stdin, 'isTTY', { value: true });
  const drain = deferred();
  const calls = [];

  const controller = installShutdownHandlers({
    processRef: proc,
    stdin,
    logger: { info() {}, warn() {}, error() {} },
    graceMs: 5_000,
    graceful: async () => drain.promise,
    force: async (trigger) => calls.push(trigger),
  });

  proc.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  stdin.end();
  const result = await controller.completion;
  assert.equal(result.forced, true);
  assert.equal(result.trigger, Trigger.STDIN_EOF);
  assert.deepEqual(calls, [Trigger.STDIN_EOF]);
});

test('non-TTY single SIGTERM completes gracefully', async () => {
  const proc = new EventEmitter();
  const stdin = new PassThrough();
  Object.defineProperty(stdin, 'isTTY', { value: false });
  let flushed = 0;
  const controller = installShutdownHandlers({
    processRef: proc,
    stdin,
    logger: { info() {}, warn() {}, error() {} },
    graceMs: 5_000,
    graceful: async () => {},
    force: async () => assert.fail('must not force'),
    flush: async () => {
      flushed += 1;
    },
  });

  proc.emit('SIGTERM');
  const result = await controller.completion;
  assert.deepEqual(result, { forced: false, trigger: Trigger.SIGTERM });
  assert.equal(flushed, 1);
  assert.equal(controller.state.phase, Phase.COMPLETE);
});
