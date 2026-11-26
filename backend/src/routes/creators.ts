import { Router } from "express";
import { Prisma, Creator } from "@prisma/client";
import prisma from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { validate } from "../middleware/validate";
import {
  createCreatorParamsSchema,
  createCreatorSchema,
  leaderboardQuerySchema,
  listCreatorsQuerySchema,
  updateCreatorSchema,
  updateThemeSchema,
  usernameParamSchema,
} from "../schemas/creators";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../errors/AppError";
import { challenges } from "./auth";
import { verifyWalletOwnership } from "../services/walletProof";
import { TtlCache } from "../services/ttlCache";
import { toAmount, MoneyValue } from "../lib/money";
import { toPublicCreator } from "../lib/publicCreator";
import { getCreatorStats } from "../services/creatorStats";

const router = Router();

// Cache creator profile lookups by username with a 5-minute TTL.
// Profiles change infrequently, so this reduces DB load while staying fresh.
// Exported so tests can reset it between cases.
export const creatorProfileCache = new TtlCache<Creator>(5 * 60 * 1000, 500);
creatorProfileCache.startSweeping();

export function formatCreator<T extends { presetAmounts?: unknown }>(creator: T): T {
  if (!creator) return creator;
  if (!Array.isArray(creator.presetAmounts)) return creator;
  return {
    ...creator,
    presetAmounts: creator.presetAmounts.map((p: unknown) => toAmount(p as MoneyValue)),
  };
}

interface LeaderboardEntry {
  rank: number;
  total: number;
  donationCount: number;
}

interface CreatorLeaderboardEntry extends LeaderboardEntry {
  creator: { id: number; username: string; displayName: string | null; avatarUrl: string | null };
}

interface SupporterLeaderboardEntry extends LeaderboardEntry {
  // Supporters are wallet addresses, not necessarily linked accounts —
  // most donors never create a SupportMe account at all.
  senderAddress: string;
}

// Aggregation scans every donation row for the chosen currency, which gets
// more expensive as donation volume grows (#16's own stated concern); a
// short TTL keeps the leaderboard responsive without needing a shared
// cache/Redis for a single-instance API, while still being fresh within a
// donation's-eye-view of "shortly after it happened". Exported so tests
// can reset it between cases instead of sharing state across the file.
export const leaderboardCache = new TtlCache<{ entries: LeaderboardEntry[]; total: number }>(30_000, 200);
leaderboardCache.startSweeping();

const WALLET_TAKEN_MESSAGE = "This wallet address is already linked to another creator profile";

// A creator profile may only be tied to a wallet its owner has proven control
// of (#276): either the wallet they signed in with, or another wallet for
// which they present a signature over a fresh /api/auth/challenge message.
function assertWalletOwnership(
  user: NonNullable<AuthRequest["user"]>,
  walletAddress: string,
  walletSignature: string | undefined
): void {
  if (walletAddress === user.walletAddress) return;
  if (!walletSignature) {
    throw new ForbiddenError(
      "Prove you control this wallet: sign a message from /api/auth/challenge and send it as walletSignature"
    );
  }
  verifyWalletOwnership(challenges, walletAddress, walletSignature);
}

// Two profiles must never share a payout wallet: donations and the
// goal-update reconciliation are keyed by wallet address.
async function assertWalletAvailable(walletAddress: string, excludeCreatorId?: number) {
  const holder = await prisma.creator.findFirst({
    where: {
      walletAddress,
      ...(excludeCreatorId === undefined ? {} : { id: { not: excludeCreatorId } }),
    },
    select: { id: true },
  });
  if (holder) {
    throw new ConflictError(WALLET_TAKEN_MESSAGE);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// Discovery/search: browse creators by name or username, sorted by newest
// or by donation count ("most supported" — a currency-agnostic proxy for
// popularity, since a creator's donations can span multiple assets).
router.get(
  "/",
  validate({ query: listCreatorsQuerySchema }),
  asyncHandler(async (req, res) => {
    const { q, sort, page, limit } = req.query as unknown as {
      q?: string;
      sort: "newest" | "most-supported";
      page: number;
      limit: number;
    };

    const where: Prisma.CreatorWhereInput = {
      walletAddress: { not: null },
      ...(q
        ? {
            OR: [
              { username: { contains: q, mode: "insensitive" as const } },
              { displayName: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    // Prisma 5 cannot filter a relation inside `orderBy`, so the verified
    // count used for "most-supported" ranking is computed in SQL. Using the
    // raw ordered ids and then reloading the rows keeps the same verified
    // count in both the ranking and the `_count` returned to the client.
    // `id` is always the final sort key so paging over ties is stable (#392).
    const countSelect = {
      select: { donations: { where: { verified: true } } },
    } as const;
    let creators: Array<Creator & { _count: { donations: number } }>;

    if (sort === "most-supported") {
      const ranked = await prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        SELECT c.id
        FROM "Creator" c
        LEFT JOIN (
          SELECT "creatorId", COUNT(*)::int AS "verifiedDonations"
          FROM "Donation"
          WHERE verified = true
          GROUP BY "creatorId"
        ) counts ON counts."creatorId" = c.id
        WHERE c."walletAddress" IS NOT NULL
          AND (
            ${q ?? null}::text IS NULL
            OR strpos(lower(c."username"), lower(${q ?? null}::text)) > 0
            OR strpos(lower(coalesce(c."displayName", '')), lower(${q ?? null}::text)) > 0
          )
        ORDER BY COALESCE(counts."verifiedDonations", 0) DESC, c.id DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}
      `);

      const rows = ranked.length
        ? await prisma.creator.findMany({
            where: { id: { in: ranked.map((row) => row.id) } },
            include: { _count: countSelect },
          })
        : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      creators = ranked
        .map((row) => byId.get(row.id))
        .filter((row): row is Creator & { _count: { donations: number } } => row !== undefined);
    } else {
      creators = await prisma.creator.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        include: { _count: countSelect },
      });
    }

    const total = await prisma.creator.count({ where });

    return res.json({
      items: creators.map((creator) => ({
        ...toPublicCreator(creator),
        _count: { donations: creator._count.donations },
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  })
);

router.get(
  "/me",
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const creator = await prisma.creator.findUnique({ where: { userId: req.user.id } });
    if (!creator) {
      throw new NotFoundError("Creator not found");
    }

    return res.json(formatCreator(creator));
  })
);

// Dashboard metrics for the signed-in creator (#224). Computed in the database
// over all verified donations, not just the page the dashboard has loaded.
router.get(
  "/me/stats",
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const creator = await prisma.creator.findUnique({ where: { userId: req.user.id } });
    if (!creator) {
      throw new NotFoundError("Creator not found");
    }

    return res.json(await getCreatorStats(creator.id));
  })
);

// Leaderboard (#16): top creators by total received, or top supporters by
// total given, for one currency at a time. Must be registered before
// "/:username" or Express would match "/leaderboard" as a username.
router.get(
  "/leaderboard",
  validate({ query: leaderboardQuerySchema }),
  asyncHandler(async (req, res) => {
    const { type, currency, period, page, limit } = req.query as unknown as {
      type: "creators" | "supporters";
      currency: string;
      period: "all" | "month" | "week";
      page: number;
      limit: number;
    };

    const now = new Date();
    let periodStart: Date | undefined;
    if (period === "month") {
      periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    } else if (period === "week") {
      periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const daysSinceMonday = (periodStart.getUTCDay() + 6) % 7;
      periodStart.setUTCDate(periodStart.getUTCDate() - daysSinceMonday);
    }

    const cacheKey = `${type}:${currency}:${periodStart?.toISOString() ?? "all"}`;
    const { entries: allRanked, total } = await leaderboardCache.getOrSet(cacheKey, async () => {
      const donationWhere = {
        currency,
        ...(periodStart ? { createdAt: { gte: periodStart } } : {}),
      };

      if (type === "creators") {
        const grouped = await prisma.donation.groupBy({
          by: ["creatorId"],
          where: { ...donationWhere, creator: { walletAddress: { not: null } } },
          _sum: { amount: true },
          _count: { _all: true },
          orderBy: { _sum: { amount: "desc" } },
        });

        const creators = await prisma.creator.findMany({
          where: { id: { in: grouped.map((g) => g.creatorId) } },
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        });
        const creatorById = new Map(creators.map((c) => [c.id, c]));

        const entries: CreatorLeaderboardEntry[] = grouped
          .filter((g) => creatorById.has(g.creatorId))
          .map((g, index) => ({
            rank: index + 1,
            total: toAmount(g._sum.amount),
            donationCount: g._count._all,
            creator: creatorById.get(g.creatorId)!,
          }));

        return { entries, total: entries.length };
      }

      const grouped = await prisma.donation.groupBy({
        by: ["senderAddress"],
        where: donationWhere,
        _sum: { amount: true },
        _count: { _all: true },
        orderBy: { _sum: { amount: "desc" } },
      });

      const entries: SupporterLeaderboardEntry[] = grouped.map((g, index) => ({
        rank: index + 1,
        total: toAmount(g._sum.amount),
        donationCount: g._count._all,
        senderAddress: g.senderAddress,
      }));

      return { entries, total: entries.length };
    });

    const items = allRanked.slice((page - 1) * limit, (page - 1) * limit + limit);

    return res.json({
      items,
      currency,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  })
);

router.get(
  "/:username",
  validate({ params: usernameParamSchema }),
  asyncHandler(async (req, res) => {
    const { username } = req.params;

    try {
      const creator = await creatorProfileCache.getOrSet(username, async () => {
        const profile = await prisma.creator.findUnique({
          where: { username },
        });
        if (!profile) {
          throw new NotFoundError("Creator not found");
        }
        return profile;
      });

      return res.json(toPublicCreator(creator));
    } catch (error) {
      // If cache fails, fall back to direct DB read
      if (error instanceof NotFoundError) {
        throw error;
      }
      const creator = await prisma.creator.findUnique({
        where: { username },
      });

      if (!creator) {
        throw new NotFoundError("Creator not found");
      }

      return res.json(toPublicCreator(creator));
    }
  })
);

router.post(
  "/:username/create",
  authMiddleware,
  validate({ params: createCreatorParamsSchema, body: createCreatorSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { username } = req.params;
    const { walletAddress, walletSignature, displayName, bio, avatarUrl } = req.body;

    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const existing = await prisma.creator.findUnique({ where: { username } });
    if (existing) {
      throw new ConflictError("Username already exists");
    }

    const userCreator = await prisma.creator.findUnique({
      where: { userId: req.user.id },
    });
    if (userCreator) {
      throw new ConflictError("User already has a creator profile");
    }

    // Default to the wallet the user signed in with; a magic-link/OAuth user
    // with no wallet yet gets null (payout wallet connected later).
    const payoutWallet: string | null = walletAddress || req.user.walletAddress || null;
    if (payoutWallet) {
      assertWalletOwnership(req.user, payoutWallet, walletSignature);
      await assertWalletAvailable(payoutWallet);
    }

    let creator: Creator;
    try {
      creator = await prisma.creator.create({
        data: {
          userId: req.user.id,
          username,
          walletAddress: payoutWallet,
          displayName,
          bio,
          avatarUrl,
        },
      });
    } catch (err) {
      // Lost a race with another request claiming the same wallet.
      if (isUniqueViolation(err)) throw new ConflictError(WALLET_TAKEN_MESSAGE);
      throw err;
    }

    return res.status(201).json(formatCreator(creator));
  })
);

router.put(
  "/:username",
  authMiddleware,
  validate({ params: usernameParamSchema, body: updateCreatorSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { username } = req.params;
    const { walletSignature, ...updates } = req.body;

    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const existing = await prisma.creator.findUnique({ where: { username } });
    if (!existing) {
      throw new NotFoundError("Creator not found");
    }

    // A profile can only be edited by its owner — otherwise anyone could
    // overwrite another creator's payout wallet and redirect their donations.
    if (existing.userId !== req.user.id) {
      throw new ForbiddenError("You can only edit your own profile");
    }

    // Re-pointing the payout wallet needs proof of control and must not
    // collide with another profile.
    if (updates.walletAddress !== undefined && updates.walletAddress !== existing.walletAddress) {
      assertWalletOwnership(req.user, updates.walletAddress, walletSignature);
      await assertWalletAvailable(updates.walletAddress, existing.id);
    }

    let creator: Creator;
    try {
      creator = await prisma.creator.update({
        where: { username },
        data: updates,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(WALLET_TAKEN_MESSAGE);
      throw err;
    }

    // Invalidate cache when profile is updated
    creatorProfileCache.clear();
    leaderboardCache.clear();

    return res.json(formatCreator(creator));
  })
);

// Saves (or, with `theme: null`, resets) the creator's public profile theme.
router.patch(
  "/:username/theme",
  authMiddleware,
  validate({ params: usernameParamSchema, body: updateThemeSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { username } = req.params;
    const { theme } = req.body;

    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const existing = await prisma.creator.findUnique({ where: { username } });
    if (!existing) {
      throw new NotFoundError("Creator not found");
    }
    if (existing.userId !== req.user.id) {
      throw new ForbiddenError("You can only edit your own profile");
    }

    const creator = await prisma.creator.update({
      where: { username },
      data: { theme: theme ?? Prisma.DbNull },
    });

    creatorProfileCache.clear();

    return res.json(formatCreator(creator));
  })
);

export default router;
