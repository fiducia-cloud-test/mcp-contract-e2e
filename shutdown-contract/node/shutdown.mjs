import process from 'node:process';

export const Phase = Object.freeze({
  RUNNING: 'running',
  DRAINING: 'draining',
  FORCING: 'forcing',
  COMPLETE: 'complete',
});

export const Trigger = Object.freeze({
  SIGINT: 'sigint',
  SIGTERM: 'sigterm',
  STDIN_EOF: 'stdin_eof',
  TIMEOUT: 'timeout',
  GRACEFUL_ERROR: 'graceful_error',
  GRACEFUL_COMPLETE: 'graceful_complete',
});

const isSignal = (trigger) =>
  trigger === Trigger.SIGINT || trigger === Trigger.SIGTERM;

export function initialState(stdinIsTTY) {
  return {
    phase: Phase.RUNNING,
    stdinIsTTY: Boolean(stdinIsTTY),
    firstTrigger: null,
    signalCount: 0,
  };
}

export function transition(state, trigger) {
  switch (state.phase) {
    case Phase.RUNNING: {
      if (!isSignal(trigger)) {
        return { state, action: 'ignore', showForceHint: false };
      }
      const next = {
        ...state,
        phase: Phase.DRAINING,
        firstTrigger: trigger,
        signalCount: state.signalCount + 1,
      };
      return {
        state: next,
        action: 'begin_graceful',
        showForceHint: state.stdinIsTTY && trigger === Trigger.SIGINT,
      };
    }
    case Phase.DRAINING: {
      if (trigger === Trigger.GRACEFUL_COMPLETE) {
        return {
          state: { ...state, phase: Phase.COMPLETE },
          action: 'complete',
          showForceHint: false,
        };
      }
      const eofForces =
        trigger === Trigger.STDIN_EOF &&
        state.stdinIsTTY &&
        state.firstTrigger === Trigger.SIGINT;
      const shouldForce =
        trigger === Trigger.TIMEOUT ||
        trigger === Trigger.GRACEFUL_ERROR ||
        eofForces ||
        isSignal(trigger);
      if (shouldForce) {
        return {
          state: {
            ...state,
            phase: Phase.FORCING,
            signalCount: state.signalCount + (isSignal(trigger) ? 1 : 0),
          },
          action: 'force',
          showForceHint: false,
        };
      }
      return { state, action: 'ignore', showForceHint: false };
    }
    default:
      return { state, action: 'ignore', showForceHint: false };
  }
}

function log(logger, level, fields, message) {
  const method = logger?.[level] ?? logger?.info;
  if (typeof method !== 'function') return;
  method.call(logger, fields, message);
}

function withDeadline(operation, promise, milliseconds) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${operation} exceeded ${milliseconds}ms`)),
        milliseconds,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Install the fleet shutdown contract around an arbitrary Node server.
 * Stdin is untouched until the first TTY SIGINT. SIGTERM and non-TTY execution
 * never arm EOF; Ctrl-D replaces only the second Ctrl-C.
 */
export function installShutdownHandlers({
  graceful,
  force,
  flush = async () => {},
  logger,
  graceMs = Number(process.env.SHUTDOWN_GRACE_MS ?? 30_000),
  forceMs = Math.min(graceMs, 5_000),
  processRef = process,
  stdin = process.stdin,
  onComplete = () => {},
}) {
  if (!Number.isFinite(graceMs) || graceMs <= 0) {
    throw new TypeError('graceMs must be a positive finite number');
  }
  if (!Number.isFinite(forceMs) || forceMs <= 0) {
    throw new TypeError('forceMs must be a positive finite number');
  }

  let state = initialState(Boolean(stdin?.isTTY));
  let completionPromise = null;
  let forceResolve;
  let timer = null;
  let eofArmed = false;
  let resumedStdin = false;
  let flushPromise = null;

  const forceRequested = new Promise((resolve) => {
    forceResolve = resolve;
  });

  const fields = (event, trigger, forced) => ({
    event,
    phase: state.phase,
    trigger,
    stdin_is_tty: state.stdinIsTTY,
    signal_count: state.signalCount,
    grace_ms: graceMs,
    forced,
  });

  const flushOnce = (trigger) => {
    flushPromise ??= Promise.resolve().then(() => flush(trigger));
    return flushPromise;
  };

  const cleanupListeners = () => {
    processRef.removeListener('SIGINT', onSigint);
    processRef.removeListener('SIGTERM', onSigterm);
    if (eofArmed) stdin.removeListener('end', onEof);
    if (resumedStdin && stdin.readableFlowing === true && stdin.pause) stdin.pause();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const requestForce = (trigger) => {
    const result = transition(state, trigger);
    state = result.state;
    if (result.action !== 'force') return;
    log(
      logger,
      'warn',
      fields('shutdown_forced', trigger, true),
      'forceful shutdown requested; active connections will be dropped',
    );
    forceResolve(trigger);
  };

  const onSigint = () => {
    if (state.phase === Phase.RUNNING) void begin(Trigger.SIGINT);
    else requestForce(Trigger.SIGINT);
  };

  const onSigterm = () => {
    if (state.phase === Phase.RUNNING) void begin(Trigger.SIGTERM);
    else requestForce(Trigger.SIGTERM);
  };

  const onEof = () => requestForce(Trigger.STDIN_EOF);

  const armInteractiveEof = () => {
    if (eofArmed || !stdin) return;
    eofArmed = true;
    stdin.once('end', onEof);
    if (stdin.readableFlowing !== true && stdin.resume) {
      stdin.resume();
      resumedStdin = true;
    }
  };

  const begin = (trigger) => {
    if (completionPromise) return completionPromise;

    const first = transition(state, trigger);
    state = first.state;
    if (first.action !== 'begin_graceful') {
      return Promise.resolve({
        forced: false,
        trigger,
        signalCount: state.signalCount,
      });
    }

    log(
      logger,
      'info',
      fields('shutdown_requested', trigger, false),
      'graceful shutdown requested; listener is closing and active work is draining',
    );

    if (first.showForceHint) {
      log(
        logger,
        'info',
        fields('shutdown_force_available', trigger, false),
        'press Ctrl-C again or Ctrl-D to force shutdown',
      );
      armInteractiveEof();
    }

    timer = setTimeout(() => requestForce(Trigger.TIMEOUT), graceMs);

    completionPromise = (async () => {
      let forced = false;
      let failed = false;
      let finalTrigger = trigger;
      try {
        const gracefulResult = Promise.resolve()
          .then(() => graceful(trigger))
          .then(
            () => ({ kind: 'graceful' }),
            (error) => ({ kind: 'graceful_error', error }),
          );
        const outcome = await Promise.race([
          gracefulResult,
          forceRequested.then((forceTrigger) => ({
            kind: 'force',
            trigger: forceTrigger,
          })),
        ]);

        if (outcome.kind === 'force') {
          forced = true;
          finalTrigger = outcome.trigger;
          await withDeadline('force shutdown', force(outcome.trigger), forceMs);
        } else if (outcome.kind === 'graceful_error') {
          failed = true;
          const forcedTransition = transition(state, Trigger.GRACEFUL_ERROR);
          state = forcedTransition.state;
          log(
            logger,
            'error',
            {
              ...fields('shutdown_failed', Trigger.GRACEFUL_ERROR, true),
              error: outcome.error,
            },
            'graceful shutdown failed; forcing active connections closed',
          );
          forced = true;
          finalTrigger = Trigger.GRACEFUL_ERROR;
          await withDeadline('force shutdown', force(finalTrigger), forceMs);
        } else {
          state = transition(state, Trigger.GRACEFUL_COMPLETE).state;
        }
      } catch (error) {
        failed = true;
        log(
          logger,
          'error',
          { ...fields('shutdown_failed', finalTrigger, forced), error },
          'server shutdown operation failed',
        );
      }

      try {
        await withDeadline('telemetry flush', flushOnce(finalTrigger), forceMs);
      } catch (error) {
        failed = true;
        log(
          logger,
          'error',
          { ...fields('shutdown_failed', finalTrigger, forced), error },
          'shutdown cleanup or telemetry flush failed',
        );
      } finally {
        cleanupListeners();
      }

      state = { ...state, phase: Phase.COMPLETE };
      log(
        logger,
        'info',
        { ...fields('shutdown_complete', finalTrigger, forced), failed },
        forced ? 'forceful shutdown complete' : 'graceful shutdown complete',
      );
      const result = {
        forced,
        trigger: finalTrigger,
        signalCount: state.signalCount,
        failed,
      };
      onComplete(result);
      return result;
    })();

    return completionPromise;
  };

  processRef.on('SIGINT', onSigint);
  processRef.on('SIGTERM', onSigterm);
  // Deliberately no stdin listener/resume here.

  return {
    begin,
    requestForce,
    get state() {
      return { ...state };
    },
    get completion() {
      return completionPromise;
    },
    dispose: cleanupListeners,
  };
}
