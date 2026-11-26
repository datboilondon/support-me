import { executorHealth } from "../../services/executorHealth";

beforeEach(() => {
  executorHealth.reset();
});

describe("executorHealth", () => {
  it("reports disabled when the executor was never started", () => {
    const health = executorHealth.getHealth();
    expect(health.status).toBe("disabled");
    expect(health.enabled).toBe(false);
    expect(health.lastRunAt).toBeNull();
  });

  it("reports ok right after a successful run within the expected interval", () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runStarted();
    executorHealth.runFinished(true);

    const health = executorHealth.getHealth();
    expect(health.status).toBe("ok");
    expect(health.lastRunAt).not.toBeNull();
    expect(health.lastSuccessAt).toBe(health.lastRunAt);
    expect(health.lastRunError).toBeNull();
    expect(health.expectedIntervalMs).toBe(60_000);
  });

  it("reports unhealthy when the last run is older than the expected interval", () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runFinished(true, undefined, Date.now() - 120_000);

    const health = executorHealth.getHealth();
    expect(health.status).toBe("unhealthy");
    expect(health.msSinceLastRun).toBeGreaterThanOrEqual(120_000);
  });

  it("reports unhealthy when enabled but no run has completed within the interval", () => {
    executorHealth.markEnabled(1);

    const health = executorHealth.getHealth(Date.now() + 10);
    expect(health.status).toBe("unhealthy");
    expect(health.lastRunAt).toBeNull();
  });

  it("keeps the last run error when a run fails", () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runFinished(false, "database unavailable");

    const health = executorHealth.getHealth();
    expect(health.lastRunError).toBe("database unavailable");
    expect(health.lastSuccessAt).toBeNull();
  });

  it("reports unhealthy and failed counts when every charge in a run fails (#500)", () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runStarted();
    executorHealth.recordCharge(1, "failure", "insufficient balance");
    executorHealth.recordCharge(2, "failure", "allowance revoked");
    executorHealth.runFinished(true);

    const health = executorHealth.getHealth();
    expect(health.status).toBe("unhealthy");
    expect(health.lastRun).toEqual({
      successCount: 0,
      failureCount: 2,
      attemptedCount: 2,
      failureRate: 1,
      status: "failed",
    });
    expect(health.lastRunError).toBe("all 2 attempted charges failed");
    // A run that charged nothing successfully is not a success.
    expect(health.lastSuccessAt).toBeNull();
  });

  it("reports degraded when the failure rate in a mixed run exceeds the threshold (#500)", () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runStarted();
    executorHealth.recordCharge(1, "success");
    executorHealth.recordCharge(2, "failure", "insufficient balance");
    executorHealth.recordCharge(3, "failure", "allowance revoked");
    executorHealth.runFinished(true);

    const health = executorHealth.getHealth();
    expect(health.status).toBe("degraded");
    expect(health.lastRun).toMatchObject({
      successCount: 1,
      failureCount: 2,
      attemptedCount: 3,
      status: "degraded",
    });
    expect(health.lastRun?.failureRate).toBeCloseTo(2 / 3);
    expect(health.lastSuccessAt).not.toBeNull();
  });

  it("stays ok for a mixed run at or below the failure-rate threshold (#500)", () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runStarted();
    executorHealth.recordCharge(1, "success");
    executorHealth.recordCharge(2, "success");
    executorHealth.recordCharge(3, "failure", "allowance revoked");
    executorHealth.runFinished(true);

    const health = executorHealth.getHealth();
    expect(health.status).toBe("ok");
    expect(health.lastRun).toMatchObject({
      successCount: 2,
      failureCount: 1,
      attemptedCount: 3,
      status: "ok",
    });
  });

  it("reports ok with success counts when every charge in a run succeeds (#500)", () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runStarted();
    executorHealth.recordCharge(1, "success");
    executorHealth.recordCharge(2, "success");
    executorHealth.recordCharge(3, "success");
    executorHealth.runFinished(true);

    const health = executorHealth.getHealth();
    expect(health.status).toBe("ok");
    expect(health.lastRun).toEqual({
      successCount: 3,
      failureCount: 0,
      attemptedCount: 3,
      failureRate: 0,
      status: "ok",
    });
  });

  it("counts charge outcomes per run instead of cumulatively across runs (#500)", () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runStarted();
    executorHealth.recordCharge(1, "failure", "insufficient balance");
    executorHealth.runFinished(true);

    executorHealth.runStarted();
    executorHealth.recordCharge(2, "success");
    executorHealth.runFinished(true);

    const health = executorHealth.getHealth();
    expect(health.status).toBe("ok");
    expect(health.lastRun).toMatchObject({ successCount: 1, failureCount: 0 });
  });

  it("reports ok for a run that had no due charges (#500)", () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runStarted();
    executorHealth.runFinished(true);

    const health = executorHealth.getHealth();
    expect(health.status).toBe("ok");
    expect(health.lastRun).toEqual({
      successCount: 0,
      failureCount: 0,
      attemptedCount: 0,
      failureRate: 0,
      status: "ok",
    });
  });

  it("tracks recent charge outcomes with success/failure counts", () => {
    executorHealth.markEnabled(60_000);
    executorHealth.recordCharge(1, "success");
    executorHealth.recordCharge(2, "failure", "allowance revoked");
    executorHealth.recordCharge(3, "success");

    const health = executorHealth.getHealth();
    expect(health.recentCharges.successCount).toBe(2);
    expect(health.recentCharges.failureCount).toBe(1);
    expect(health.recentCharges.outcomes).toHaveLength(3);
    expect(health.recentCharges.lastOutcomeAt).not.toBeNull();
    expect(health.recentCharges.outcomes[1]).toMatchObject({
      subscriptionId: 2,
      status: "failure",
      error: "allowance revoked",
    });
  });

  it("caps the outcome window at the 20 most recent charges", () => {
    for (let i = 1; i <= 25; i++) {
      executorHealth.recordCharge(i, "success");
    }

    const health = executorHealth.getHealth();
    expect(health.recentCharges.outcomes).toHaveLength(20);
    expect(health.recentCharges.outcomes[0].subscriptionId).toBe(6);
    expect(health.recentCharges.outcomes[19].subscriptionId).toBe(25);
  });

  it("returns to disabled after markDisabled", () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runFinished(true);
    executorHealth.markDisabled();

    const health = executorHealth.getHealth();
    expect(health.status).toBe("disabled");
    expect(health.enabled).toBe(false);
  });
});
