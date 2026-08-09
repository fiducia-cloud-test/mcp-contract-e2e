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
const tick = () => new Promise((resolve) => setImmediate(resolve));
const logger = () => ({ info() {}, warn() {}, error() {} });

test('TTY SIGINT begins graceful work and second SIGINT forces', () => {
  const first = transition(initialState(true), Trigger.SIGINT);
  assert.equal(first.action, 'begin_graceful');
  assert.equal(first.showForceHint, true);
  assert.equal(first.state.signalCount, 1);
  const second = transition(first.state, Trigger.SIGINT);
  assert.equal(second.action, 'force');
  assert.equal(second.state.phase, Phase.FORCING);
  assert.equal(second.state.signalCount, 2);
});

test('TTY Ctrl-D only forces after interactive SIGINT and is not a signal', () => {
  const before = transition(initialState(true), Trigger.STDIN_EOF);
  assert.equal(before.action, 'ignore');
  const first = transition(initialState(true), Trigger.SIGINT);
  const eof = transition(first.state, Trigger.STDIN_EOF);
  assert.equal(eof.action, 'force');
  assert.equal(eof.state.signalCount, 1);
});

test('TTY SIGTERM and non-TTY SIGINT never arm EOF', () => {
  const term = transition(initialState(true), Trigger.SIGTERM);
  assert.equal(term.action, 'begin_graceful');
  assert.equal(term.showForceHint, false);
  assert.equal(transition(term.state, Trigger.STDIN_EOF).action, 'ignore');

  const nonTTY = transition(initialState(false), Trigger.SIGINT);
  assert.equal(nonTTY.showForceHint, false);
  assert.equal(transition(nonTTY.state, Trigger.STDIN_EOF).action, 'ignore');
});

test('installing the controller does not consume TTY stdin before SIGINT', async () => {
  const proc = new EventEmitter();
  const stdin = new PassThrough();
  Object.defineProperty(stdin, 'isTTY', { value: true });
  const drain = deferred();
  const controller = installShutdownHandlers({
    processRef: proc,
    stdin,
    logger: logger(),
    graceMs: 5_000,
    graceful: () => drain.promise,
    force: () => {},
  });

  assert.equal(stdin.readableFlowing, null);
  assert.equal(stdin.listenerCount('end'), 0);
  stdin.emit('end');
  await tick();
  assert.equal(controller.state.phase, Phase.RUNNING);

  proc.emit('SIGINT');
  await tick();
  assert.equal(controller.state.phase, Phase.DRAINING);
  assert.equal(stdin.listenerCount('end'), 1);
  controller.dispose();
});

test('runtime drains once, then second signal force-closes and flushes once', async () => {
  const proc = new EventEmitter();
  const stdin = new PassThrough();
  Object.defineProperty(stdin, 'isTTY', { value: true });
  const drain = deferred();
  const calls = [];
  const controller = installShutdownHandlers({
    processRef: proc,
    stdin,
    logger: logger(),
    graceMs: 5_000,
    graceful: async (trigger) => {
      calls.push(`graceful:${trigger}`);
      await drain.promise;
    },
    force: async (trigger) => calls.push(`force:${trigger}`),
    flush: async () => calls.push('flush'),
  });

  proc.emit('SIGINT');
  await tick();
  proc.emit('SIGINT');
  const result = await controller.completion;
  assert.deepEqual(result, {
    forced: true,
    trigger: Trigger.SIGINT,
    signalCount: 2,
    failed: false,
  });
  assert.deepEqual(calls, ['graceful:sigint', 'force:sigint', 'flush']);
});

test('TTY EOF after first SIGINT is equivalent to second Ctrl-C', async () => {
  const proc = new EventEmitter();
  const stdin = new PassThrough();
  Object.defineProperty(stdin, 'isTTY', { value: true });
  const drain = deferred();
  const controller = installShutdownHandlers({
    processRef: proc,
    stdin,
    logger: logger(),
    graceMs: 5_000,
    graceful: () => drain.promise,
    force: () => {},
  });

  proc.emit('SIGINT');
  await tick();
  stdin.end();
  const result = await controller.completion;
  assert.equal(result.forced, true);
  assert.equal(result.trigger, Trigger.STDIN_EOF);
  assert.equal(result.signalCount, 1);
});

test('TTY SIGTERM does not attach EOF reader and completes gracefully', async () => {
  const proc = new EventEmitter();
  const stdin = new PassThrough();
  Object.defineProperty(stdin, 'isTTY', { value: true });
  const controller = installShutdownHandlers({
    processRef: proc,
    stdin,
    logger: logger(),
    graceful: async () => {},
    force: () => assert.fail('must not force'),
  });
  proc.emit('SIGTERM');
  const result = await controller.completion;
  assert.equal(result.forced, false);
  assert.equal(result.signalCount, 1);
  assert.equal(stdin.listenerCount('end'), 0);
  assert.equal(stdin.readableFlowing, null);
});

test('graceful failure force-closes and a blocked flush is bounded', async () => {
  const proc = new EventEmitter();
  const never = new Promise(() => {});
  let forceCalls = 0;
  const controller = installShutdownHandlers({
    processRef: proc,
    stdin: Object.assign(new PassThrough(), { isTTY: false }),
    logger: logger(),
    graceMs: 1_000,
    forceMs: 5,
    graceful: async () => {
      throw new Error('drain failed');
    },
    force: () => {
      forceCalls += 1;
    },
    flush: () => never,
  });
  proc.emit('SIGTERM');
  const result = await controller.completion;
  assert.equal(result.forced, true);
  assert.equal(result.trigger, Trigger.GRACEFUL_ERROR);
  assert.equal(result.failed, true);
  assert.equal(forceCalls, 1);
});
