import { retryWithPolicy, emitDiagnostic, Deadline } from './host.ts';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import {
  ensureRunnerSession,
  stopIosRunnerSession,
  validateRunnerDevice,
} from './runner-session.ts';
import {
  assertRunnerRequestActive,
  isRetryableRunnerError,
  isRunnerBusyRejection,
  withRunnerCommandId,
  type RunnerCommand,
} from './runner-contract.ts';
import { isReadOnlyRunnerCommand } from './runner-command-traits.ts';
import {
  createLocalAppleRunnerProvider,
  resolveAppleRunnerProvider,
  type AppleRunnerCommandOptions,
  type AppleRunnerPrewarmOptions,
  type AppleRunnerProvider,
} from './runner-provider.ts';
import { ensureXctestrunArtifact } from './runner-xctestrun.ts';
import {
  executeRunnerCommand,
  prepareLocalIosRunner,
  type PrepareIosRunnerOptions,
  type PrepareIosRunnerResult,
} from './runner-lifecycle.ts';
import { RUNNER_COMMAND_TIMEOUT_MS } from './runner-transport.ts';

// --- Runner command execution ---

/** Resend budget for RUNNER_BUSY rejections: covers the runner's busy
 *  window (abandoned main-thread work self-declares wedged at 120s) within
 *  the standard command timeout. */
const RUNNER_BUSY_RESEND_BUDGET_MS = Math.min(120_000, RUNNER_COMMAND_TIMEOUT_MS);

export async function runAppleRunnerCommand(
  device: DeviceInfo,
  command: RunnerCommand,
  options: AppleRunnerCommandOptions = {},
): Promise<Record<string, unknown>> {
  validateRunnerDevice(device);
  assertRunnerRequestActive(options.requestId);
  const runnerCommand = withRunnerCommandId(command);
  const provider = resolveAppleRunnerRuntime(device, options);
  const readOnly = isReadOnlyRunnerCommand(runnerCommand.command);
  // Busy-rejection budget: the runner reports busy while its main thread
  // grinds abandoned work and self-declares wedged only after 120s
  // (mainThreadWedgeThreshold). Default retry policy (3 x 200ms) exhausts
  // in under a second — inside the busy window. A mutating command whose
  // busy window outlives this deadline fails with the busy rejection
  // intact (read-only keeps the wider retryable set through recovery).
  const busyDeadline = Deadline.fromTimeoutMs(RUNNER_BUSY_RESEND_BUDGET_MS);
  return retryWithPolicy(
    () => {
      assertRunnerRequestActive(options.requestId);
      return provider.runCommand(device, runnerCommand, options);
    },
    {
      maxAttempts: 30,
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
      shouldRetry: (error) => {
        assertRunnerRequestActive(options.requestId);
        // Read-only commands resend on any retryable class. A MUTATING
        // command resends ONLY on a rejection proven to precede execution
        // (RUNNER_BUSY) — transport-loss classes may have already run the
        // command, and a blind resend would double-tap.
        if (readOnly) return isRetryableRunnerError(error);
        return isRunnerBusyRejection(error);
      },
    },
    { deadline: busyDeadline },
  );
}

export async function notifyIosRunnerAppRelaunched(
  device: DeviceInfo,
  options: AppleRunnerCommandOptions = {},
): Promise<void> {
  if (!isIosFamily(device)) return;
  try {
    await runAppleRunnerCommand(device, { command: 'targetReset' }, options);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_target_reset_failed',
      data: { deviceId: device.id, error: error instanceof Error ? error.message : String(error) },
    });
    await stopIosRunnerSession(device.id);
  }
}

type PrewarmIosRunnerOptions = AppleRunnerPrewarmOptions & {
  propagateError?: boolean;
};

export function prewarmAppleRunnerCache(
  device: DeviceInfo,
  options: PrewarmIosRunnerOptions = {},
): Promise<void> | undefined {
  if (!isIosFamily(device)) {
    return undefined;
  }
  return runBestEffortIosRunnerPrewarm({
    device,
    options,
    failurePhase: 'ios_runner_cache_prewarm_failed',
    task: async (runnerOptions) => {
      await ensureXctestrunArtifact(device, runnerOptions);
    },
  });
}

export function prewarmIosRunnerSession(
  device: DeviceInfo,
  options: PrewarmIosRunnerOptions = {},
): Promise<void> | undefined {
  if (!isIosFamily(device)) {
    return undefined;
  }
  const provider = resolveAppleRunnerRuntime(device, options);
  const prewarmRunner = provider.prewarm;
  if (!prewarmRunner) {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_session_prewarm_unavailable',
      data: { deviceId: device.id },
    });
    return undefined;
  }
  return runBestEffortIosRunnerPrewarm({
    device,
    options,
    failurePhase: 'ios_runner_session_prewarm_failed',
    task: async (taskOptions) => {
      await prewarmRunner(device, taskOptions);
    },
  });
}

function runBestEffortIosRunnerPrewarm(params: {
  device: DeviceInfo;
  options: PrewarmIosRunnerOptions;
  failurePhase: 'ios_runner_cache_prewarm_failed' | 'ios_runner_session_prewarm_failed';
  task: (options: AppleRunnerPrewarmOptions) => Promise<void>;
}): Promise<void> {
  const { device, options, failurePhase, task } = params;
  const { propagateError = false, ...runnerOptions } = options;
  const prewarm = task(runnerOptions).catch((error: unknown) => {
    emitDiagnostic({
      level: 'warn',
      phase: failurePhase,
      data: {
        deviceId: device.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    if (propagateError) {
      throw error;
    }
  });
  void prewarm;
  return prewarm;
}

export async function prepareIosRunner(
  device: DeviceInfo,
  options: PrepareIosRunnerOptions,
): Promise<PrepareIosRunnerResult> {
  validateRunnerDevice(device);
  assertRunnerRequestActive(options.requestId);
  const command = withRunnerCommandId({ command: 'uptime' });
  const provider = resolveAppleRunnerRuntime(device, options);
  if (provider.prepare) {
    return await provider.prepare(device, options);
  }

  const healthStartedAt = Date.now();
  const runner = await provider.runCommand(device, command, options);
  return {
    runner,
    connectMs: 0,
    healthCheckMs: Math.max(0, Date.now() - healthStartedAt),
  };
}

function resolveAppleRunnerRuntime(
  device: DeviceInfo,
  options: { requestId?: string },
): AppleRunnerProvider {
  return resolveAppleRunnerProvider(device, LOCAL_APPLE_RUNNER_RUNTIME, undefined, {
    requestId: options.requestId,
  });
}

const LOCAL_APPLE_RUNNER_RUNTIME = createLocalAppleRunnerProvider(executeRunnerCommand, {
  prepare: prepareLocalIosRunner,
  prewarm: async (device, options) => {
    const { healthCheck, ...runnerOptions } = options;
    if (healthCheck === false) {
      await ensureRunnerSession(device, runnerOptions);
      return;
    }
    await prepareLocalIosRunner(device, {
      ...runnerOptions,
      healthTimeoutMs: RUNNER_COMMAND_TIMEOUT_MS,
    });
  },
});
