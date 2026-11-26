import express, { type Request } from "express";
import { timingSafeEqual } from "crypto";
import cors from "cors";
import * as Sentry from "@sentry/node";
import authRouter from "./routes/auth";
import creatorsRouter from "./routes/creators";
import donationsRouter from "./routes/donations";
import withdrawalsRouter from "./routes/withdrawals";
import subscriptionsRouter from "./routes/subscriptions";
import goalsRouter from "./routes/goals";
import eventsRouter from "./routes/events";
import adminRouter from "./routes/admin";
import activityRouter from "./routes/activity";
import accountRouter from "./routes/account";
import emailWebhooksRouter from "./routes/emailWebhooks";
import seoRouter from "./routes/seo";
import emailPreviewRouter from "./routes/emailPreview";
import { errorHandler } from "./middleware/errorHandler";
import { requestLogger } from "./middleware/requestLogger";
import { checkSorobanRpc } from "./services/sorobanHealth";
import { executorHealth } from "./services/executorHealth";
import { eventListenerHealth } from "./services/eventListenerHealth";
import { networkReset } from "./services/networkReset";
import { getAllowedOrigins, getRateLimitConfig, getTrustProxy } from "./config";
import { log } from "./lib/logger";
import { TtlCache } from "./services/ttlCache";
import { RateLimiter } from "./services/rateLimiter";
import { clientIp, rateLimit } from "./middleware/rateLimit";

const rateLimits = getRateLimitConfig();
export const sorobanRpcCache = new TtlCache<{ status: "ok" | "down"; latencyMs?: number }>(5_000);
export const healthIpLimiter = new RateLimiter(rateLimits.health.ipMax, rateLimits.health.windowMs);

const app = express();

/**
 * CORS is restricted to an explicit allowlist of frontend origins (#179).
 *
 * The default `cors()` reflects any request's Origin, which lets any
 * third-party page make authenticated API calls using a token held in
 * browser JS storage and read the responses back. Resolving the allowlist
 * per request (rather than once at import) keeps it configurable from the
 * environment without a code change, so preview and staging domains can be
 * added by configuration alone.
 *
 * A request with no Origin header (server-to-server calls, curl, health
 * probes) is allowed through: the browser always sends Origin on a
 * cross-origin request, so its absence cannot be attacker-controlled from
 * a page.
 *
 * A disallowed origin is a policy outcome, not a server fault (#518). The
 * origin callback resolves to `false`, so `cors` simply omits the
 * Access-Control headers and the request is handled like any other non-CORS
 * request; the browser discards the response. Raising an error here used to
 * surface as a 500 and a Sentry event for every bot, scanner or preview
 * deployment that sent an unlisted Origin, which hid real failures and
 * inflated the error-rate alerts.
 */
function isOriginAllowed(origin: string): boolean {
  return getAllowedOrigins().includes(origin.replace(/\/$/, ""));
}

// Built per request so a rejected origin can log the request id alongside the
// origin (#518), while the allowlist is still read from the environment on
// every call rather than frozen at import.
function corsOptionsFor(req: Request): cors.CorsOptions {
  return {
    origin(origin, callback) {
      // Same-origin and non-browser callers send no Origin header.
      if (!origin) return callback(null, true);
      if (isOriginAllowed(origin)) return callback(null, true);
      // `false` (rather than an Error) makes `cors` drop the headers without
      // echoing the untrusted origin, and keeps this out of errorHandler.
      log("warn", "cors origin rejected", { requestId: req.requestId, origin });
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  };
}

const corsOptionsDelegate: cors.CorsOptionsDelegate<Request> = (req, callback) => {
  callback(null, corsOptionsFor(req));
};

// Initialize Sentry if DSN is configured
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
  });
}

// Set TRUST_PROXY to the number of reverse-proxy hops in front of the API (e.g.
// 1 on Railway) so req.ip, and therefore the per-IP rate limits, reflects the
// real client instead of the proxy. Unset keeps Express's default. Parsed by
// getTrustProxy (#439): a typo used to become NaN via Number() and reach
// Express, silently breaking req.ip.
const trustProxy = getTrustProxy();
if (trustProxy !== undefined) {
  app.set("trust proxy", trustProxy);
}

app.use(requestLogger);
app.use(cors(corsOptionsDelegate));

// Mounted with express.raw() ahead of the global express.json() below: Svix
// signature verification (see routes/emailWebhooks.ts) needs the exact raw
// request body, not one that's already been parsed and would have to be
// re-serialized (and could byte-for-byte differ from what Resend signed).
app.use("/api/webhooks/email", express.raw({ type: "application/json" }), emailWebhooksRouter);

/**
 * JSON bodies are capped deliberately at 100kb (#519) instead of inheriting
 * body-parser's default, so the limit is visible in one place and documented
 * in docs/CONFIGURATION.md. Over-limit requests are answered with a 413
 * PAYLOAD_TOO_LARGE by errorHandler; email webhooks use express.raw() above
 * and are verified against the exact bytes they received.
 */
const JSON_BODY_LIMIT = "100kb";

app.use(express.json({ limit: JSON_BODY_LIMIT }));

// SEO routes (standard paths: /sitemap.xml, /robots.txt)
app.use("/", seoRouter);

/**
 * Detailed health reports expose operator-only data: executor balances,
 * raw charge/error strings and subscription ids, the listener cursor and the
 * network reset reason. Health probes are usually hit by monitors with no user
 * session, so the admin credential here is a shared secret header rather than
 * a JWT. Fail-closed: with no secret configured the detail is never served and
 * every caller receives only the aggregate status (#440).
 */
function hasHealthDetailAccess(req: Request): boolean {
  const expected = process.env.HEALTH_DETAIL_SECRET;
  if (!expected) return false;
  const provided = req.get("X-Health-Detail-Key");
  if (!provided) return false;
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  return (
    expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf)
  );
}

// One rate limiter shared by every health route, so probing any of them
// consumes the same per-IP budget (#440).
const healthRateLimit = rateLimit(healthIpLimiter, clientIp, "health probe");

// Cheap liveness probe that never touches dependencies (#373). Rate limited
// like the other health routes (#440).
app.get("/health/live", healthRateLimit, (_req, res) => {
  return res.json({ status: "ok" });
});

app.get("/health", healthRateLimit, async (req, res) => {
  const sorobanRpc = await sorobanRpcCache.getOrSet("rpc", () => checkSorobanRpc());
  const subscriptionExecutor = executorHealth.getHealth();
  const eventListener = eventListenerHealth.getHealth();
  const network = networkReset.getState();
  // A detected testnet reset is the most severe state: the backend is running
  // against a chain that no longer matches its configuration, so report
  // unhealthy regardless of the other dependencies (#278). The runbook is in
  // docs/testnet-troubleshooting.md.
  //
  // A cursor-recovery gap (#268) is reported as "degraded" rather than
  // "unhealthy": it means a past window of events was permanently missed,
  // which an operator should see and investigate, but the listener itself
  // has already recovered and is polling normally again.
  const status =
    network.status === "reset_detected"
      ? "unhealthy"
      : subscriptionExecutor.status === "unhealthy"
        ? "unhealthy"
        : subscriptionExecutor.status === "degraded"
          ? "degraded"
          : sorobanRpc.status !== "ok"
            ? "degraded"
            : eventListener.gapDetected
              ? "degraded"
              : "ok";
  // Public liveness stays minimal. The dependency breakdown (including the
  // listener cursor and reset reason) is only for authorized operators (#440).
  if (!hasHealthDetailAccess(req)) return res.json({ status });
  return res.json({
    status,
    timestamp: new Date().toISOString(),
    network: network.status,
    dependencies: { sorobanRpc, subscriptionExecutor, eventListener, network },
  });
});

app.get("/health/executor", healthRateLimit, (req, res) => {
  const subscriptionExecutor = executorHealth.getHealth();
  // `disabled` stays `ok` for backward compatibility; `degraded` and
  // `unhealthy` are passed through so monitors see a run whose charges are
  // mostly or entirely failing (#500).
  const status = subscriptionExecutor.status === "disabled" ? "ok" : subscriptionExecutor.status;
  // Unauthenticated callers get only the aggregate status. Balances, error
  // strings and subscription ids require the operator detail secret (#440).
  if (!hasHealthDetailAccess(req)) return res.json({ status });
  return res.json({
    status,
    timestamp: new Date().toISOString(),
    subscriptionExecutor,
  });
});

app.use("/api/auth", authRouter);
app.use("/api/creators", creatorsRouter);
app.use("/api/donations", donationsRouter);
app.use("/api/withdrawals", withdrawalsRouter);
app.use("/api/subscriptions", subscriptionsRouter);
app.use("/api/goals", goalsRouter);
app.use("/api/events", eventsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/activity", activityRouter);
app.use("/api/account", accountRouter);
// Email preview is a developer tool and should not be exposed in production (#272)
app.use("/api/email/preview", (req, res, next) => {
  if (process.env.NODE_ENV === "production" && process.env.EMAIL_PREVIEW_ENABLED !== "true") {
    return res.sendStatus(404);
  }
  return next();
}, emailPreviewRouter);
app.use("/api", seoRouter);

app.use((req, res) => {
  return res.status(404).json({
    error: "Not Found",
    code: "NOT_FOUND",
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
});

app.use(errorHandler);

export default app;



