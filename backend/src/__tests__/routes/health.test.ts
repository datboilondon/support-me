jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {},
}));
jest.mock("../../services/sorobanHealth", () => ({
  checkSorobanRpc: jest.fn().mockResolvedValue({ status: "ok", latencyMs: 4 }),
}));
jest.mock("../../services/networkReset", () => ({
  networkReset: {
    getState: jest.fn(() => ({
      status: "ok",
      reason: null,
      detectedAt: null,
      lastSeenLedger: null,
      latestLedger: null,
    })),
  },
}));

import request from "supertest";
import app, { sorobanRpcCache, healthIpLimiter } from "../../app";
import { executorHealth } from "../../services/executorHealth";

const DETAIL_SECRET = "operator-detail-secret";
const detail = () => request(app).get("/health").set("X-Health-Detail-Key", DETAIL_SECRET);
const executorDetail = () =>
  request(app).get("/health/executor").set("X-Health-Detail-Key", DETAIL_SECRET);

const originalSecret = process.env.HEALTH_DETAIL_SECRET;

beforeEach(() => {
  executorHealth.reset();
  sorobanRpcCache.clear();
  healthIpLimiter.clear();
  process.env.HEALTH_DETAIL_SECRET = DETAIL_SECRET;
});

afterAll(() => {
  process.env.HEALTH_DETAIL_SECRET = originalSecret;
});

describe("GET /health", () => {
  it("returns only the aggregate status to unauthenticated callers (#440)", async () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runFinished(true);
    executorHealth.recordCharge(7, "failure", "insufficient balance");

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    // No dependency breakdown, executor detail, network state or timestamp.
    expect(res.body.dependencies).toBeUndefined();
    expect(res.body.subscriptionExecutor).toBeUndefined();
    expect(res.body.network).toBeUndefined();
    expect(res.body.timestamp).toBeUndefined();
  });

  it("returns the full report to callers with the operator secret (#440)", async () => {
    const res = await detail();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.network).toBe("ok");
    expect(typeof res.body.timestamp).toBe("string");
    expect(res.body.dependencies.sorobanRpc.status).toBe("ok");
  });

  it("does not serve detail when no secret is configured (#440)", async () => {
    delete process.env.HEALTH_DETAIL_SECRET;

    const res = await detail();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("reports reset_detected and unhealthy when a testnet reset was detected (#278)", async () => {
    const { networkReset } = await import("../../services/networkReset");
    (networkReset.getState as jest.Mock).mockReturnValueOnce({
      status: "reset_detected",
      reason: "latest ledger went backwards",
      detectedAt: "2026-01-01T00:00:00.000Z",
      lastSeenLedger: 900,
      latestLedger: 5,
    });

    // One authorized request carries both the aggregate status and the detail.
    const res = await detail();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.network).toBe("reset_detected");
    expect(res.body.dependencies.network.status).toBe("reset_detected");
  });

  it("reports degraded status when Soroban RPC is unavailable", async () => {
    const { checkSorobanRpc } = await import("../../services/sorobanHealth");
    (checkSorobanRpc as jest.Mock).mockResolvedValueOnce({ status: "down" });

    const res = await detail();
    expect(res.body.status).toBe("degraded");
    expect(res.body.dependencies.sorobanRpc.status).toBe("down");
  });

  it("includes the subscription executor's run status and recent charge outcomes for operators", async () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runFinished(true);
    executorHealth.recordCharge(7, "success");

    const res = await detail();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    const executor = res.body.dependencies.subscriptionExecutor;
    expect(executor.status).toBe("ok");
    expect(typeof executor.lastRunAt).toBe("string");
    expect(typeof executor.lastSuccessAt).toBe("string");
    expect(executor.recentCharges.successCount).toBe(1);
    expect(executor.recentCharges.failureCount).toBe(0);
  });

  it("reports degraded when most charges in the executor's last run failed (#500)", async () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runStarted();
    executorHealth.recordCharge(1, "success");
    executorHealth.recordCharge(2, "failure", "allowance revoked");
    executorHealth.recordCharge(3, "failure", "allowance revoked");
    executorHealth.runFinished(true);

    const publicRes = await request(app).get("/health");
    expect(publicRes.body).toEqual({ status: "degraded" });

    const res = await detail();
    expect(res.body.status).toBe("degraded");
    expect(res.body.dependencies.subscriptionExecutor.status).toBe("degraded");
    expect(res.body.dependencies.subscriptionExecutor.lastRun).toMatchObject({
      successCount: 1,
      failureCount: 2,
      attemptedCount: 3,
    });
  });

  it("reports unhealthy when every charge in the executor's last run failed (#500)", async () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runStarted();
    executorHealth.recordCharge(1, "failure", "insufficient balance");
    executorHealth.recordCharge(2, "failure", "insufficient balance");
    executorHealth.runFinished(true);

    const publicRes = await request(app).get("/health");
    expect(publicRes.body).toEqual({ status: "unhealthy" });

    const res = await detail();
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.dependencies.subscriptionExecutor.status).toBe("unhealthy");
    expect(res.body.dependencies.subscriptionExecutor.lastRun).toMatchObject({
      successCount: 0,
      failureCount: 2,
      status: "failed",
    });
  });

  it("reports an unhealthy overall status when the executor has stalled", async () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runFinished(true, undefined, Date.now() - 5 * 60_000);

    const publicRes = await request(app).get("/health");
    expect(publicRes.body).toEqual({ status: "unhealthy" });

    const res = await detail();
    expect(res.body.dependencies.subscriptionExecutor.status).toBe("unhealthy");
  });

  it("reuses one RPC probe for repeated rapid /health requests inside the cache window (#373)", async () => {
    const { checkSorobanRpc } = await import("../../services/sorobanHealth");
    (checkSorobanRpc as jest.Mock).mockClear();

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    }

    expect(checkSorobanRpc).toHaveBeenCalledTimes(1);
  });

  it("rate limits rapid requests to /health beyond the configured cap (#373)", async () => {
    for (let i = 0; i < 60; i++) {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
    }

    const res = await request(app).get("/health");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("TOO_MANY_REQUESTS");
  });
});

describe("GET /health/live (#373)", () => {
  it("responds with 200 ok without calling Soroban RPC or touching dependencies", async () => {
    const { checkSorobanRpc } = await import("../../services/sorobanHealth");
    (checkSorobanRpc as jest.Mock).mockClear();

    const res = await request(app).get("/health/live");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(checkSorobanRpc).not.toHaveBeenCalled();
  });

  it("is rate limited like every health route (#440)", async () => {
    for (let i = 0; i < 60; i++) {
      expect((await request(app).get("/health/live")).status).toBe(200);
    }

    const res = await request(app).get("/health/live");
    expect(res.status).toBe(429);
  });
});

describe("GET /health/executor (#440)", () => {
  it("returns only status to unauthenticated callers", async () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runFinished(true);
    executorHealth.recordCharge(3, "failure", "insufficient balance");

    const res = await request(app).get("/health/executor");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(res.body.subscriptionExecutor).toBeUndefined();
    expect(res.body.timestamp).toBeUndefined();
  });

  it("still reports an unhealthy status publicly when the executor has stalled", async () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runFinished(true, undefined, Date.now() - 10 * 60_000);

    const res = await request(app).get("/health/executor");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "unhealthy" });
  });

  it("passes a degraded executor status through publicly (#500)", async () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runStarted();
    executorHealth.recordCharge(1, "success");
    executorHealth.recordCharge(2, "failure", "allowance revoked");
    executorHealth.recordCharge(3, "failure", "allowance revoked");
    executorHealth.runFinished(true);

    const res = await request(app).get("/health/executor");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "degraded" });
  });

  it("reports disabled publicly when the executor was never started", async () => {
    const res = await request(app).get("/health/executor");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("returns the full report only with the operator secret", async () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runFinished(true);
    executorHealth.recordCharge(3, "failure", "insufficient balance");

    const res = await executorDetail();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.subscriptionExecutor.status).toBe("ok");
    expect(res.body.subscriptionExecutor.recentCharges.failureCount).toBe(1);
    expect(res.body.subscriptionExecutor.recentCharges.outcomes[0].error).toBe(
      "insufficient balance"
    );
    expect(res.body.subscriptionExecutor.balanceXlm).toBeDefined();
  });

  it("does not serve detail with a wrong secret or when none is configured", async () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runFinished(true);

    const wrong = await request(app)
      .get("/health/executor")
      .set("X-Health-Detail-Key", "wrong");
    expect(wrong.body).toEqual({ status: "ok" });

    delete process.env.HEALTH_DETAIL_SECRET;
    const none = await executorDetail();
    expect(none.body).toEqual({ status: "ok" });
  });

  it("is rate limited like every health route", async () => {
    for (let i = 0; i < 60; i++) {
      expect((await request(app).get("/health/executor")).status).toBe(200);
    }

    const res = await request(app).get("/health/executor");
    expect(res.status).toBe(429);
  });
});

describe("unknown routes", () => {
  it("returns a structured 404", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);

    expect(res.body).toEqual(
      expect.objectContaining({ error: "Not Found", code: "NOT_FOUND" })
    );
    expect(typeof res.body.requestId).toBe("string");
  });
});
