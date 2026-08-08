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
  GRACEFUL_COMPLETE: 'graceful_complete',
});

export function initialState(stdinIsTTY) {
  return {
    phase: Phase.RUNNING,
    stdinIsTTY: Boolean(stdinIsTTY),
    firstTrigger: null,
  };
}

export function transition(state, trigger) {
  switch (state.phase) {
    case Phase.RUNNING: {
      if (trigger !== Trigger.SIGINT && trigger !== Trigger.SIGTERM) {
        return { state, action: 'ignore', showForceHint: false };
      }
      const next = {
        ...state,
        phase: Phase.DRAINING,
        firstTrigger: trigger,
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
      const signalForces =
        trigger === Trigger.SIGINT || trigger === Trigger.SIGTERM;
      if (trigger === Trigger.TIMEOUT || eofForces || signalForces) {
        return {
          state: { ...state, phase: Phase.FORCING },
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
  // Pino/Fastify loggers support (object, message). This shape is also easy to
  // adapt in tests and in @oresoftware/next-logger.
  method.call(logger, fields, message);
}

/**
 * Install the fleet shutdown contract around an arbitrary Node server.
 *
 * @param {object} options
 * @param {(trigger: string) => Promise<void>} options.graceful
 * @param {(trigger: string) => Promise<void>|void} options.force
 * @param {() => Promise<void>|void} [options.flush]
 * @param {object} options.logger
 * @param {number} [options.graceMs]
 * @param {NodeJS.Process} [options.processRef]
 * @param {NodeJS.ReadStream} [options.stdin]
 * @param {(result: {forced: boolean, trigger: string}) => void} [options.onComplete]
 */
export function installShutdownHandlers({
  graceful,
  force,
  flush = async () => {},
  logger,
  graceMs = Number(process.env.SHUTDOWN_GRACE_MS ?? 30_000),
  processRef = process,
  stdin = process.stdin,
  onComplete = () => {},
}) {
  if (!Number.isFinite(graceMs) || graceMs <= 0) {
    throw new TypeError('graceMs must be a positive finite number');
  }

  let state = initialState(Boolean(stdin?.isTTY));
  let completionPromise = null;
  let forceResolve;
  let timer = null;
  let eofArmed = false;
  let resumedStdin = false;

  const forceRequested = new Promise((resolve) => {
    forceResolve = resolve;
  });

  const cleanupListeners = () => {
    processRef.removeListener('SIGINT', onSigint);
    processRef.removeListener('SIGTERM', onSigterm);
    if (eofArmed) stdin.removeListener('end', onEof);
    if (resumedStdin && stdin.readableFlowing === true) stdin.pause();
    if (timer) clearTimeout(timer);
  };

  const requestForce = (trigger) => {
    const result = transition(state, trigger);
    state = result.state;
    if (result.action !== 'force') return;

    log(
      logger,
      'warn',
      {
        event: 'shutdown_forced',
        phase: state.phase,
        trigger,
        stdin_is_tty: state.stdinIsTTY,
        grace_ms: graceMs,
        forced: true,
      },
      'forceful shutdown requested; active connections will be dropped',
    );
    forceResolve(trigger);
  };

  const onSigint = () => {
    if (state.phase === Phase.RUNNING) {
      void begin(Trigger.SIGINT);
    } else {
      requestForce(Trigger.SIGINT);
    }
  };

  const onSigterm = () => {
    if (state.phase === Phase.RUNNING) {
      void begin(Trigger.SIGTERM);
    } else {
      requestForce(Trigger.SIGTERM);
    }
  };

  const onEof = () => requestForce(Trigger.STDIN_EOF);

  const armInteractiveEof = () => {
    if (eofArmed || !stdin) return;
    eofArmed = true;
    stdin.once('end', onEof);
    if (stdin.readableFlowing !== true) {
      stdin.resume();
      resumedStdin = true;
    }
  };

  const begin = (trigger) => {
    if (completionPromise) return completionPromise;

    const first = transition(state, trigger);
    state = first.state;
    if (first.action !== 'begin_graceful') {
      return Promise.resolve({ forced: false, trigger });
    }

    log(
      logger,
      'info',
      {
        event: 'shutdown_requested',
        phase: state.phase,
        trigger,
        stdin_is_tty: state.stdinIsTTY,
        grace_ms: graceMs,
        forced: false,
      },
      'graceful shutdown requested; listener is closing and active work is draining',
    );

    if (first.showForceHint) {
      log(
        logger,
        'info',
        {
          event: 'shutdown_force_available',
          phase: state.phase,
          trigger,
          stdin_is_tty: true,
          grace_ms: graceMs,
          forced: false,
        },
        'press Ctrl-C again or Ctrl-D to force shutdown',
      );
      armInteractiveEof();
    }

    timer = setTimeout(() => requestForce(Trigger.TIMEOUT), graceMs);
    timer.unref?.();

    completionPromise = (async () => {
      let forced = false;
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
          await force(outcome.trigger);
        } else if (outcome.kind === 'graceful_error') {
          log(
            logger,
            'error',
            {
              event: 'shutdown_failed',
              phase: state.phase,
              trigger,
              stdin_is_tty: state.stdinIsTTY,
              grace_ms: graceMs,
              forced: false,
              error: outcome.error,
            },
            'graceful shutdown failed; forcing active connections closed',
          );
          forced = true;
          finalTrigger = 'graceful_error';
          await force(finalTrigger);
        } else {
          state = transition(state, Trigger.GRACEFUL_COMPLETE).state;
        }
      } finally {
        try {
          await flush();
        } finally {
          cleanupListeners();
        }
      }

      log(
        logger,
        'info',
        {
          event: 'shutdown_complete',
          phase: Phase.COMPLETE,
          trigger: finalTrigger,
          stdin_is_tty: state.stdinIsTTY,
          grace_ms: graceMs,
          forced,
        },
        forced ? 'forceful shutdown complete' : 'graceful shutdown complete',
      );
      state = { ...state, phase: Phase.COMPLETE };
      const result = { forced, trigger: finalTrigger };
      onComplete(result);
      return result;
    })();

    return completionPromise;
  };

  processRef.on('SIGINT', onSigint);
  processRef.on('SIGTERM', onSigterm);

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
