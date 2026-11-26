import { Router, Response, Request } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { validate } from "../middleware/validate";
import { deleteAccountSchema } from "../schemas/account";
import { TooManyRequestsError, UnauthorizedError } from "../errors/AppError";
import { RateLimiter } from "../services/rateLimiter";
import { log } from "../lib/logger";

const router = Router();

export const BATCH_SIZE = 500;

// Rate-limit exports to 5 per hour per user (#369)
export const exportRateLimiter = new RateLimiter(5, 60 * 60 * 1000);
exportRateLimiter.startSweeping();

function isResponseClosed(res: Response, req?: { aborted?: boolean }): boolean {
  return res.closed || res.destroyed || Boolean(req?.aborted);
}

async function writeResponseChunk(
  req: Request | undefined,
  res: Response,
  chunk: string
): Promise<boolean> {
  if (isResponseClosed(res, req)) return false;

  if (res.write(chunk)) return true;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (continued: boolean) => {
      if (settled) return;
      settled = true;
      res.removeListener("drain", onDrain);
      res.removeListener("close", onClose);
      req?.removeListener("close", onClose);
      resolve(continued);
    };
    const onDrain = () => settle(!isResponseClosed(res, req));
    const onClose = () => settle(false);

    res.once("drain", onDrain);
    res.once("close", onClose);
    req?.once("close", onClose);
  });
}

export async function streamBatchedArray<T extends { id: number }>(
  res: Response,
  fetchBatch: (cursorId: number | undefined, take: number) => Promise<T[]>,
  batchSize = BATCH_SIZE,
  req?: Request
): Promise<boolean> {
  let cursorId: number | undefined = undefined;
  let firstItem = true;
  let reqClosed = false;
  const onRequestClose = () => {
    reqClosed = true;
  };
  if (req) req.once("close", onRequestClose);

  while (true) {
    if (reqClosed || isResponseClosed(res, req)) break;
    const rows = await fetchBatch(cursorId, batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      if (reqClosed || isResponseClosed(res, req)) break;
      const separator = firstItem ? "\n        " : ",\n        ";
      if (!(await writeResponseChunk(req, res, separator))) break;
      if (!(await writeResponseChunk(req, res, JSON.stringify(row)))) break;
      firstItem = false;
    }

    if (reqClosed || isResponseClosed(res, req)) break;
    if (rows.length < batchSize) break;
    cursorId = rows[rows.length - 1].id;
  }

  if (req) req.removeListener("close", onRequestClose);
  return !reqClosed && !isResponseClosed(res, req);
}

router.get(
  "/export",
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    if (!exportRateLimiter.attempt(`export:${req.user.id}`)) {
      const retryAfter = exportRateLimiter.retryAfterSeconds(`export:${req.user.id}`);
      res.setHeader("Retry-After", String(retryAfter));
      throw new TooManyRequestsError("Too many export requests, please try again later");
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { creator: true },
    });
    if (!user) {
      throw new UnauthorizedError("User not found");
    }

    const walletAddress = user.walletAddress ?? "";
    const filename = `supportme-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const userPayload = {
      id: user.id,
      walletAddress: user.walletAddress,
      email: user.email,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      deletedAt: user.deletedAt,
    };

    try {
      if (!(await writeResponseChunk(req, res, "{\n"))) return;
      if (!(await writeResponseChunk(req, res, `  "exportedAt": ${JSON.stringify(new Date().toISOString())},\n`))) return;
      if (!(await writeResponseChunk(req, res, `  "user": ${JSON.stringify(userPayload, null, 2).replace(/\n/g, "\n  ")},\n`))) return;
      if (!(await writeResponseChunk(req, res, `  "creator": ${user.creator ? JSON.stringify(user.creator, null, 2).replace(/\n/g, "\n  ") : "null"},\n`))) return;
      if (!(await writeResponseChunk(req, res, '  "donations": {\n    "sent": ['))) return;

      // Stream sent donations
      if (!(await streamBatchedArray(res, async (cursorId, take) => {
        return prisma.donation.findMany({
          where: { senderAddress: walletAddress },
          orderBy: { id: "desc" },
          take,
          ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
        });
      }, BATCH_SIZE, req))) return;

      if (!(await writeResponseChunk(req, res, '\n    ],\n    "received": ['))) return;

      // Stream received donations
      if (user.creator) {
        if (!(await streamBatchedArray(res, async (cursorId, take) => {
          return prisma.donation.findMany({
            where: { creatorId: user.creator!.id },
            orderBy: { id: "desc" },
            take,
            ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
          });
        }, BATCH_SIZE, req))) return;
      }

      if (!(await writeResponseChunk(req, res, '\n    ]\n  },\n  "subscriptions": {\n    "asSupporter": ['))) return;

      // Stream subscriptions as supporter
      if (!(await streamBatchedArray(res, async (cursorId, take) => {
        return prisma.subscription.findMany({
          where: { supporterAddress: walletAddress },
          orderBy: { id: "desc" },
          take,
          ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
          include: {
            creator: { select: { username: true, displayName: true, walletAddress: true } },
          },
        });
      }, BATCH_SIZE, req))) return;

      if (!(await writeResponseChunk(req, res, '\n    ],\n    "asCreator": ['))) return;

      // Stream subscriptions as creator
      if (user.creator) {
        if (!(await streamBatchedArray(res, async (cursorId, take) => {
          return prisma.subscription.findMany({
            where: { creatorId: user.creator!.id },
            orderBy: { id: "desc" },
            take,
            ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
            include: {
              creator: { select: { username: true, displayName: true, walletAddress: true } },
            },
          });
        }, BATCH_SIZE, req))) return;
      }

      if (!(await writeResponseChunk(req, res, '\n    ]\n  },\n  "withdrawals": ['))) return;

      // Stream withdrawals
      if (user.creator) {
        if (!(await streamBatchedArray(res, async (cursorId, take) => {
          return prisma.withdrawal.findMany({
            where: { creatorId: user.creator!.id },
            orderBy: { id: "desc" },
            take,
            ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
          });
        }, BATCH_SIZE, req))) return;
      }

      if (!(await writeResponseChunk(req, res, "\n  ]\n}\n"))) return;
      return res.end();
    } catch (error) {
      if (!isResponseClosed(res, req)) {
        log("error", "Account export streaming failed", {
          requestId: req.requestId,
          userId: req.user?.id,
          error: error instanceof Error ? error.message : String(error),
        });
        res.destroy();
      }
    }
  })
);

router.post(
  "/delete",
  authMiddleware,
  validate({ body: deleteAccountSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { creator: true },
    });
    if (!user) {
      throw new UnauthorizedError("User not found");
    }

    if (user.deletedAt) {
      return res.json({
        deleted: true,
        deletedAt: user.deletedAt,
        alreadyDeleted: true,
        anonymized: [],
        preserved: [],
      });
    }

    // A wallet-less account (magic-link/OAuth sign-in) owns no wallet-linked
    // records; the empty string matches no address rows.
    const walletAddress = user.walletAddress ?? "";
    const creator = user.creator;

    const operations: Prisma.PrismaPromise<unknown>[] = [
      prisma.user.update({
        where: { id: user.id },
        data: { email: null, deletedAt: new Date() },
      }),
      prisma.oAuthIdentity.deleteMany({ where: { userId: user.id } }),
      ...(user.email
        ? [
            prisma.magicLinkToken.deleteMany({
              where: { OR: [{ userId: user.id }, { email: user.email }] },
            }),
          ]
        : [
            prisma.magicLinkToken.deleteMany({ where: { userId: user.id } }),
          ]),
      // Memos the holder wrote on their own donations are personal content;
      // the amounts and transaction hashes stay (they're on-chain referenced).
      prisma.donation.updateMany({
        where: { senderAddress: walletAddress, message: { not: null } },
        data: { message: null },
      }),
      // Stop the executor charging subscriptions the holder started. The rows
      // themselves (on-chain ids, tx hashes, addresses) are preserved.
      prisma.subscription.updateMany({
        where: { supporterAddress: walletAddress, active: true },
        data: { active: false },
      }),
    ];

    if (creator) {
      operations.push(
        prisma.creator.update({
          where: { id: creator.id },
          data: { displayName: null, bio: null, avatarUrl: null, socialLinks: Prisma.DbNull },
        })
      );
    }

    const results = await prisma.$transaction(operations);
    const updatedUser = results[0] as { deletedAt: Date | null };

    return res.json({
      deleted: true,
      deletedAt: updatedUser.deletedAt,
      anonymized: [
        "email",
        "profile.displayName",
        "profile.bio",
        "profile.avatarUrl",
        "profile.socialLinks",
        "donationMessages.sent",
        "activeSubscriptions.deactivated",
      ],
      preserved: [
        "walletAddress",
        "onChainDonationRecords",
        "onChainSubscriptionRecords",
        "withdrawalRecords",
        "creator.username",
      ],
    });
  })
);

export default router;
