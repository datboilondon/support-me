import { getExecutorLowBalanceXlm } from "./stellarNetwork";

export interface ChargeOutcome {
  at: string;
  subscriptionId: number;
  status: "success" | "failure";
  error?: string;
}

/**
 * Health of the most recently completed executor run, derived from the
 * charges it actually attempted (#500). `failed` means either the run itself
 * errored or every attempted charge failed; `degraded` means it completed but
 * more than `RUN_FAILURE_RATE_DEGRADED_THRESHOLD` of its charges failed.
 */
export interface ExecutorRunHealth {
  successCount: number;
  failureCount: number;
  attemptedCount: number;
  /** Share of attempted charges that failed, 0 when nothing was attempted. */
  failureRate: number;
  status: "ok" | "degraded" | "failed";
}

export interface ExecutorHealthReport {
  status: "ok" | "degraded" | "unhealthy" | "disabled";
  enabled: boolean;
  running: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastRunError: string | null;
  expectedIntervalMs: number;
  msSinceLastRun: number | null;
  // Per-run outcome counts from the last completed tick (#500). A run whose
  // charges all failed must not look healthy just because the tick itself
  // completed without throwing.
  lastRun: ExecutorRunHealth | null;
  // Executor account funding (#279): XLM balance from the account's ledger
  // entry, plus a lowBalance flag against EXECUTOR_LOW_BALANCE_XLM so an
  // operator sees a starved fee wallet before charges start failing.
  balanceXlm: string | null;
  lowBalance: boolean;
  recentCharges: {
    successCount: number;
    failureCount: number;
    lastOutcomeAt: string | null;
    outcomes: ChargeOutcome[];
  };
}

const RECENT_OUTCOMES_MAX = 20;
const DEFAULT_EXPECTED_INTERVAL_MS = 5 * 60_000;
/**
 * Failure-rate threshold above which a completed run is reported as
 * `degraded`. A run that attempted charges and had none succeed is always
 * `failed`, regardless of this threshold.
 */
const RUN_FAILURE_RATE_DEGRADED_THRESHOLD = 0.5;

/**
 * Tracks the subscription executor's run/charge health in-process so
 * `GET /health` (and `GET /health/executor`) can report whether the executor
 * is actually charging subscriptions instead of silently stalling. The
 * executor writes here on every tick/charge; the health routes only read.
 */
class ExecutorHealthTracker {
  private enabled = false;
  private running = false;
  private startedAt: number | null = null;
  private lastRunAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastRunError: string | null = null;
  private expectedIntervalMs = DEFAULT_EXPECTED_INTERVAL_MS;
  private recentOutcomes: ChargeOutcome[] = [];
  private balanceXlm: string | null = null;
  private currentRunSuccessCount = 0;
  private currentRunFailureCount = 0;
  private lastRun: ExecutorRunHealth | null = null;

  markEnabled(expectedIntervalMs?: number): void {
    this.enabled = true;
    this.startedAt = Date.now();
    this.expectedIntervalMs =
      expectedIntervalMs && expectedIntervalMs > 0
        ? expectedIntervalMs
        : DEFAULT_EXPECTED_INTERVAL_MS;
  }

  markDisabled(): void {
    this.enabled = false;
    this.startedAt = null;
  }

  /** Records the executor account's XLM balance (null when unreadable). */
  setBalance(balanceXlm: string | null): void {
    this.balanceXlm = balanceXlm;
  }

  runStarted(): void {
    this.running = true;
    this.currentRunSuccessCount = 0;
    this.currentRunFailureCount = 0;
  }

  runFinished(ok: boolean, error?: string, at = Date.now()): void {
    this.running = false;
    this.lastRunAt = at;

    const successCount = this.currentRunSuccessCount;
    const failureCount = this.currentRunFailureCount;
    const attemptedCount = successCount + failureCount;
    const failureRate = attemptedCount > 0 ? failureCount / attemptedCount : 0;

    // A tick that threw is failed outright. A tick that completed but had
    // every attempted charge fail is failed too: the executor is running, yet
    // no subscription is actually being charged (#500).
    const runStatus: ExecutorRunHealth["status"] = !ok
      ? "failed"
      : attemptedCount > 0 && successCount === 0
        ? "failed"
        : failureRate > RUN_FAILURE_RATE_DEGRADED_THRESHOLD
          ? "degraded"
          : "ok";

    this.lastRun = { successCount, failureCount, attemptedCount, failureRate, status: runStatus };

    if (ok) {
      this.lastRunError =
        runStatus === "failed"
          ? `all ${attemptedCount} attempted charge${attemptedCount === 1 ? "" : "s"} failed`
          : null;
      if (runStatus !== "failed") this.lastSuccessAt = at;
    } else {
      this.lastRunError = error || "run failed";
    }
  }

  reset(): void {
    this.enabled = false;
    this.running = false;
    this.startedAt = null;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastRunError = null;
    this.expectedIntervalMs = DEFAULT_EXPECTED_INTERVAL_MS;
    this.recentOutcomes = [];
    this.balanceXlm = null;
    this.currentRunSuccessCount = 0;
    this.currentRunFailureCount = 0;
    this.lastRun = null;
  }

  recordCharge(subscriptionId: number, status: ChargeOutcome["status"], error?: string): void {
    if (status === "success") {
      this.currentRunSuccessCount += 1;
    } else {
      this.currentRunFailureCount += 1;
    }
    const outcome: ChargeOutcome = {
      at: new Date().toISOString(),
      subscriptionId,
      status,
      ...(status === "failure" && error ? { error } : {}),
    };
    this.recentOutcomes = [...this.recentOutcomes, outcome].slice(-RECENT_OUTCOMES_MAX);
  }

  getHealth(now = Date.now()): ExecutorHealthReport {
    const reference = this.lastRunAt ?? this.startedAt;
    const msSinceLastRun = reference != null ? now - reference : null;

    let status: ExecutorHealthReport["status"];
    if (!this.enabled) {
      status = "disabled";
    } else if (msSinceLastRun == null || msSinceLastRun > this.expectedIntervalMs) {
      status = "unhealthy";
    } else if (this.lastRun?.status === "failed") {
      // The executor is running on schedule, but its last run charged
      // nothing successfully. Reporting `ok` here kept uptime monitors green
      // while no subscription was actually being charged (#500).
      status = "unhealthy";
    } else if (this.lastRun?.status === "degraded") {
      status = "degraded";
    } else {
      status = "ok";
    }

    const outcomes = [...this.recentOutcomes];
    const lowBalanceThresholdXlm = getExecutorLowBalanceXlm();
    return {
      status,
      enabled: this.enabled,
      running: this.running,
      startedAt: this.startedAt != null ? new Date(this.startedAt).toISOString() : null,
      lastRunAt: this.lastRunAt != null ? new Date(this.lastRunAt).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt != null ? new Date(this.lastSuccessAt).toISOString() : null,
      lastRunError: this.lastRunError,
      expectedIntervalMs: this.expectedIntervalMs,
      msSinceLastRun,
      lastRun: this.lastRun ? { ...this.lastRun } : null,
      balanceXlm: this.balanceXlm,
      lowBalance:
        this.balanceXlm != null && Number(this.balanceXlm) < lowBalanceThresholdXlm,
      recentCharges: {
        successCount: outcomes.filter((o) => o.status === "success").length,
        failureCount: outcomes.filter((o) => o.status === "failure").length,
        lastOutcomeAt: outcomes.length > 0 ? outcomes[outcomes.length - 1].at : null,
        outcomes,
      },
    };
  }
}

export const executorHealth = new ExecutorHealthTracker();
