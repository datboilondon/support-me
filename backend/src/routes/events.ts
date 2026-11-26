import { Router } from "express";
import {
  DONATION_EVENT,
  SUBSCRIPTION_CREATED_EVENT,
  SUBSCRIPTION_CANCELLED_EVENT,
  GOAL_UPDATED_EVENT,
  DONATION_RECORDED_EVENT,
  DonationEvent,
  SubscriptionCreatedEvent,
  SubscriptionCancelledEvent,
  GoalUpdatedEvent,
  DonationRecordedEvent,
  eventBus,
} from "../services/eventBus";
import { clientIp } from "../middleware/rateLimit";
import { verifyToken } from "../lib/tokens";
import { parseCookie, isUserDeleted } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";

const router = Router();

export const DEFAULT_MAX_GLOBAL_EVENTS_CONNECTIONS = 50;
export const DEFAULT_MAX_IP_EVENTS_CONNECTIONS = 5;

export let maxGlobalConnections =
  Number(process.env.EVENTS_MAX_GLOBAL_CONNECTIONS) || DEFAULT_MAX_GLOBAL_EVENTS_CONNECTIONS;
export let maxIpConnections =
  Number(process.env.EVENTS_MAX_IP_CONNECTIONS) || DEFAULT_MAX_IP_EVENTS_CONNECTIONS;

export function setEventsConnectionLimits(limits: { global?: number; ip?: number }) {
  if (limits.global !== undefined) maxGlobalConnections = limits.global;
  if (limits.ip !== undefined) maxIpConnections = limits.ip;
  eventBus.setMaxListeners(Math.max(100, (maxGlobalConnections + 10) * 5));
}

// Deliberately set max listeners based on connection cap (#370)
eventBus.setMaxListeners(Math.max(100, (maxGlobalConnections + 10) * 5));

let activeGlobalConnections = 0;
const activeIpConnections = new Map<string, number>();
const activeEventStreamClosers = new Set<() => void>();

export function endActiveEventsStreams(): void {
  for (const close of [...activeEventStreamClosers]) close();
}

export function getActiveEventsConnectionCounts() {
  return {
    global: activeGlobalConnections,
    ips: new Map(activeIpConnections),
  };
}

export function resetEventsConnections() {
  activeGlobalConnections = 0;
  activeIpConnections.clear();
  maxGlobalConnections = DEFAULT_MAX_GLOBAL_EVENTS_CONNECTIONS;
  maxIpConnections = DEFAULT_MAX_IP_EVENTS_CONNECTIONS;
  eventBus.setMaxListeners(Math.max(100, (maxGlobalConnections + 10) * 5));
}

/**
 * Server-Sent Events stream of on-chain contract events (#370, #495).
 * Supports:
 * - Scoped filtering by ?creator= (or token-scoped)
 * - Sanitizing private fields (e.g. memo) on the public stream
 * - Global and per-IP connection limits with 429 responses
 * - Authenticates via Authorization header or httpOnly cookie (#495)
 * - Soft-deleted accounts cannot open authenticated streams (#495)
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const ip = clientIp(req);
    const ipCount = activeIpConnections.get(ip) ?? 0;

    if (activeGlobalConnections >= maxGlobalConnections || ipCount >= maxIpConnections) {
      res.setHeader("Retry-After", "30");
      return res.status(429).json({
        error: "Too many concurrent event connections, please retry later",
        code: "TOO_MANY_REQUESTS",
      });
    }

    activeGlobalConnections++;
    activeIpConnections.set(ip, ipCount + 1);

    const rawCreator = typeof req.query.creator === "string" ? req.query.creator.trim() : undefined;

    let isAuthorized = false;
    const authHeader = req.headers.authorization?.split(" ")[1];
    const cookieToken = parseCookie(req.headers.cookie, "token");
    const token = authHeader || cookieToken;

    let tokenWallet: string | null = null;
    if (token) {
      try {
        const decoded = verifyToken(token);
        if (!(await isUserDeleted(decoded.id))) {
          tokenWallet = decoded.walletAddress;
        }
      } catch {
        // Invalid token -> treated as public client
      }
    }

    const creatorFilter = rawCreator || (tokenWallet ?? undefined);
    if (tokenWallet && creatorFilter && tokenWallet.toLowerCase() === creatorFilter.toLowerCase()) {
      isAuthorized = true;
    }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();

  // Comment ping so proxies/browsers don't time out an idle connection.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 30000);

  const onDonation = (payload: DonationEvent) => {
    if (creatorFilter && payload.creator.toLowerCase() !== creatorFilter.toLowerCase()) {
      return;
    }
    // Strip private fields (e.g. memo) on the public stream (#370)
    if (isAuthorized) {
      res.write(`event: donation\ndata: ${JSON.stringify(payload)}\n\n`);
    } else {
      const { memo: _memo, ...sanitized } = payload;
      res.write(`event: donation\ndata: ${JSON.stringify(sanitized)}\n\n`);
    }
  };

  const onSubCreated = (payload: SubscriptionCreatedEvent) => {
    if (creatorFilter && payload.creator.toLowerCase() !== creatorFilter.toLowerCase()) {
      return;
    }
    res.write(`event: subscription_created\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const onSubCancelled = (payload: SubscriptionCancelledEvent) => {
    if (
      creatorFilter &&
      payload.creator &&
      payload.creator.toLowerCase() !== creatorFilter.toLowerCase()
    ) {
      return;
    }
    res.write(`event: subscription_cancelled\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const onGoalUpdated = (payload: GoalUpdatedEvent) => {
    if (creatorFilter && payload.creator.toLowerCase() !== creatorFilter.toLowerCase()) {
      return;
    }
    res.write(`event: goal_updated\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const onDonationRecorded = (payload: DonationRecordedEvent) => {
    if (creatorFilter && payload.creator.toLowerCase() !== creatorFilter.toLowerCase()) {
      return;
    }
    res.write(`event: donation_recorded\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  eventBus.on(DONATION_EVENT, onDonation);
  eventBus.on(SUBSCRIPTION_CREATED_EVENT, onSubCreated);
  eventBus.on(SUBSCRIPTION_CANCELLED_EVENT, onSubCancelled);
  eventBus.on(GOAL_UPDATED_EVENT, onGoalUpdated);
  eventBus.on(DONATION_RECORDED_EVENT, onDonationRecorded);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;

    activeGlobalConnections = Math.max(0, activeGlobalConnections - 1);
    const count = activeIpConnections.get(ip) ?? 1;
    if (count <= 1) {
      activeIpConnections.delete(ip);
    } else {
      activeIpConnections.set(ip, count - 1);
    }

    clearInterval(heartbeat);
    eventBus.off(DONATION_EVENT, onDonation);
    eventBus.off(SUBSCRIPTION_CREATED_EVENT, onSubCreated);
    eventBus.off(SUBSCRIPTION_CANCELLED_EVENT, onSubCancelled);
    eventBus.off(GOAL_UPDATED_EVENT, onGoalUpdated);
    eventBus.off(DONATION_RECORDED_EVENT, onDonationRecorded);
    activeEventStreamClosers.delete(cleanup);
    res.end();
  };

  activeEventStreamClosers.add(cleanup);
  req.on("close", cleanup);
  res.on("close", cleanup);
}));

export default router;
