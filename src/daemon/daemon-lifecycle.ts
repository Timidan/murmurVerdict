export interface DaemonShutdownStep {
  name: string;
  run: () => Promise<void> | void;
}

export interface DaemonShutdownFailure {
  name: string;
  error: unknown;
}

export interface DaemonLifecycle {
  defer(step: DaemonShutdownStep): void;
  close: () => Promise<void>;
}

export class DaemonShutdownError extends Error {
  readonly failures: DaemonShutdownFailure[];

  constructor(failures: DaemonShutdownFailure[]) {
    super(shutdownErrorMessage(failures));
    this.name = "DaemonShutdownError";
    this.failures = failures;
  }
}

export class DaemonLifecycleClosedError extends Error {
  readonly stepName: string;

  constructor(stepName: string) {
    super(`cannot register daemon shutdown step after close started: ${stepName}`);
    this.name = "DaemonLifecycleClosedError";
    this.stepName = stepName;
  }
}

export async function runDaemonShutdown(
  steps: DaemonShutdownStep[],
): Promise<void> {
  const failures: DaemonShutdownFailure[] = [];

  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      failures.push({ name: step.name, error: err });
    }
  }

  if (failures.length > 0) {
    throw new DaemonShutdownError(failures);
  }
}

export function createDaemonLifecycle(): DaemonLifecycle {
  const shutdownSteps: DaemonShutdownStep[] = [];
  let closePromise: Promise<void> | null = null;

  return {
    defer(step: DaemonShutdownStep): void {
      if (closePromise) {
        throw new DaemonLifecycleClosedError(step.name);
      }
      shutdownSteps.unshift(step);
    },
    close(): Promise<void> {
      closePromise ??= runDaemonShutdown(shutdownSteps);
      return closePromise;
    },
  };
}

function shutdownErrorMessage(failures: DaemonShutdownFailure[]): string {
  if (failures.length === 1) {
    const failure = failures[0];
    return `daemon shutdown failed at ${failure.name}: ${errorMessage(failure.error)}`;
  }
  return `daemon shutdown failed in ${failures.length} steps: ${
    failures.map((failure) => failure.name).join(", ")
  }`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
