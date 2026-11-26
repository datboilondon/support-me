import { Prisma, Goal, RecurrenceInterval } from "@prisma/client";
import prisma from "../prisma";
import { toAmount, MoneyValue } from "../lib/money";

export function formatGoalAmounts<T extends { targetAmount?: unknown; currentAmount?: unknown }>(goal: T): T {
  return {
    ...goal,
    ...(goal.targetAmount !== undefined ? { targetAmount: toAmount(goal.targetAmount as MoneyValue) } : {}),
    ...(goal.currentAmount !== undefined ? { currentAmount: toAmount(goal.currentAmount as MoneyValue) } : {}),
  };
}

/**
 * True when a goal's current amount has reached its target. Decimal
 * comparison, so 0.1 ten times reaches a target of 1 exactly (#372).
 */
export function goalMeetsTarget(goal: { currentAmount: MoneyValue; targetAmount: MoneyValue }): boolean {
  return new Prisma.Decimal(goal.currentAmount).gte(new Prisma.Decimal(goal.targetAmount));
}

/**
 * Shared goal logic used by the donation-recording routes
 * (routes/donations.ts, services/subscriptionExecutor.ts) and by the
 * recurring-reset scheduler (services/goalResetScheduler.ts).
 *
 * Multi-asset design decision (issue #18): goal amounts are tracked
 * per-asset, never normalized to USD. This is a testnet demo app with no
 * price oracle, and the existing single-goal model already assumed one
 * amount unit — adding real USD normalization here would require
 * integrating an external price feed, which is out of scope for this
 * change. A goal is denominated in exactly one `currency` (its `currency`
 * field); a donation only ever contributes to goals whose currency matches
 * the donation's own `currency`/asset code. Multi-asset totals (e.g. a
 * creator's overall "goals" view) are therefore a per-asset breakdown, not a
 * single blended number — see routes/creators.ts's goals list, which
 * returns each goal with its own currency rather than summing across them.
 */

/**
 * Donation-to-goal split rule (issue #20 acceptance criteria: "Donations
 * update the correct goal's progress"):
 *
 * A donation is applied IN FULL to every one of the creator's ACTIVE goals
 * denominated in the same currency as the donation — not divided/split
 * across them. Rationale: each goal is an independent target (e.g. "New
 * microphone — 500 XLM" and "Monthly support — 2000 XLM"); a supporter's tip
 * is genuine progress toward both at once, the same way it would be if the
 * creator tracked each goal by hand. Splitting the amount evenly across N
 * goals would mean adding a second goal silently halves the progress rate on
 * the first, which is surprising to the creator and actively punishes having
 * multiple goals. Applying the full amount to every matching active goal
 * keeps each goal's meaning ("progress toward this specific target")
 * independent of how many other goals happen to exist alongside it.
 *
 * Returns the goals this donation carried to their target, so the caller can
 * send goal-reached notifications once its transaction has committed.
 */
export async function applyDonationToGoals(
  client: Prisma.TransactionClient,
  creatorId: number,
  currency: string,
  amount: MoneyValue
): Promise<Goal[]> {
  const matchingGoals = await client.goal.findMany({
    where: { creatorId, currency, status: "ACTIVE" },
  });
  if (matchingGoals.length === 0) return [];

  const results = await Promise.all(
    matchingGoals.map((goal) => applyAmountToGoal(client, goal, amount))
  );
  return results.filter((goal): goal is Goal => goal !== null);
}

/**
 * Increments one goal's progress and flips it to COMPLETED once it reaches its target (non-recurring goals only — a recurring goal keeps accepting donations until its period resets, see goalResetScheduler.ts).
 * Returns the updated goal if this donation is the one that reached the target, otherwise null.
 *
 * Issue #262: this used to compute `goal.currentAmount + amount` in JS from
 * the value read by applyDonationToGoals's findMany and write the absolute
 * result back — two concurrent donations would both start from the same
 * stale `currentAmount` and the second write would silently erase the first
 * (lost update). The increment is now applied by the database relative to
 * the current row value, inside a guarded conditional update so that of any
 * number of concurrent donations, exactly one "claims" the below-target →
 * at-or-above-target crossing (Postgres re-evaluates the WHERE clause after
 * the row lock is released, so a loser of the race sees the winner's new
 * value and matches zero rows).
 */
async function applyAmountToGoal(
  client: Prisma.TransactionClient,
  goal: Goal,
  amount: MoneyValue
): Promise<Goal | null> {
  // Claim + increment in one atomic statement: only while the goal is still
  // ACTIVE and below its target. The amount is added by the database, never
  // computed from a possibly-stale read.
  const claimed = await client.goal.updateMany({
    where: {
      id: goal.id,
      status: "ACTIVE",
      currentAmount: { lt: goal.targetAmount },
    },
    data: { currentAmount: { increment: amount } },
  });

  if (claimed.count === 0) {
    // The goal was already at/above its target when this donation arrived
    // (a later donation in the same period, or a concurrent donation already
    // carried it over) — still apply the amount so no progress is lost.
    await client.goal.update({
      where: { id: goal.id },
      data: { currentAmount: { increment: amount } },
    });
    // A non-recurring goal stuck above its target (issue #442: its target
    // was lowered by an edit, or it was already over target) completes now
    // instead of staying ACTIVE forever, and reports once so the creator
    // gets the goal-reached email. Recurring goals keep accumulating by
    // design and never complete, so they are left alone here too.
    if (goal.recurring) return null;
    const alreadyThere = await client.goal.findUnique({ where: { id: goal.id } });
    if (!alreadyThere || !goalMeetsTarget(alreadyThere)) return null;
    const flipped = await client.goal.updateMany({
      where: { id: goal.id, status: "ACTIVE" },
      data: { status: "COMPLETED" },
    });
    return flipped.count === 1 ? { ...alreadyThere, status: "COMPLETED" as const } : null;
  }

  const updated = await client.goal.findUnique({ where: { id: goal.id } });
  // The increment alone didn't carry the goal to its target (#372: exact decimal arithmetic).
  if (!updated) return null;
  const current = new Prisma.Decimal(updated.currentAmount);
  const target = new Prisma.Decimal(goal.targetAmount);
  if (current.lt(target)) return null;

  if (goal.recurring) {
    // A recurring goal stays ACTIVE past its target — "completed" isn't a
    // meaningful end state for something that resets on a schedule; it just
    // keeps accumulating until the next period. The claim guard above means
    // only the crossing donation reports it as reached.
    return updated;
  }

  // Flip to COMPLETED conditionally so this can happen at most once: only
  // the first donation to flip ACTIVE → COMPLETED counts as "reached".
  const flipped = await client.goal.updateMany({
    where: { id: goal.id, status: "ACTIVE" },
    data: { status: "COMPLETED" },
  });
  return flipped.count === 1 ? { ...updated, status: "COMPLETED" as const } : null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Moves `from` by `count` recurrence intervals (negative steps back). WEEKLY
 * is a fixed 7 days. MONTHLY is calendar-month arithmetic in UTC: the same
 * day and time of day `count` months later, clamped to the last day of a
 * shorter month (Jan 31 + 1 month = Feb 28/29) instead of overflowing into
 * the following month.
 */
function addIntervals(interval: RecurrenceInterval, from: Date, count: number): Date {
  if (interval === "WEEKLY") return new Date(from.getTime() + count * WEEK_MS);
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + count;
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = new Date(from.getTime());
  result.setUTCFullYear(year, month, Math.min(from.getUTCDate(), lastDayOfMonth));
  return result;
}

/** The instant a new/reset period for this recurrence interval should end, measured from `from` (defaults to now). */
export function computePeriodEnd(interval: RecurrenceInterval, from: Date = new Date()): Date {
  return addIntervals(interval, from, 1);
}

export function formatGoalPeriodAmounts<T extends { raised: MoneyValue; targetAmount: MoneyValue }>(period: T): T {
  return { ...period, raised: toAmount(period.raised), targetAmount: toAmount(period.targetAmount) };
}

/** Only exported for tests — the scheduler in goalResetScheduler.ts is the real caller. */
export async function resetDueGoals(now: Date = new Date()): Promise<number> {
  const due = await prisma.goal.findMany({
    where: { recurring: true, currentPeriodEnd: { lte: now } },
  });

  let resetCount = 0;
  for (const goal of due) {
    const previousEnd = goal.currentPeriodEnd;
    if (!previousEnd) continue;
    // recurrenceInterval is guaranteed non-null whenever recurring is true
    // (enforced by the create/update schemas), but Prisma's generated type
    // still models it as nullable — fall back to MONTHLY defensively rather
    // than throwing and skipping the reset entirely.
    const interval = goal.recurrenceInterval ?? "MONTHLY";

    // The next period ends a whole number of intervals after the previous
    // end, never relative to `now` (the scheduler tick), so the schedule
    // keeps its anchor time. Periods missed while the backend was down are
    // skipped over. Each candidate is stepped from `previousEnd` directly so
    // a month clamped to its last day doesn't pull later month ends earlier.
    let steps = 1;
    let nextEnd = addIntervals(interval, previousEnd, steps);
    while (nextEnd <= now) {
      steps += 1;
      nextEnd = addIntervals(interval, previousEnd, steps);
    }
    const finishedEnd = addIntervals(interval, previousEnd, steps - 1);

    const didReset = await prisma.$transaction(async (tx) => {
      // Claim the period with the same due-condition the findMany used
      // (issue #262): a second scheduler tick that raced this one re-checks
      // the condition after taking the row lock, finds currentPeriodEnd
      // already rolled forward, and matches zero rows — the period can't
      // advance twice. The row lock is held until commit, so no donation
      // increment can land between reading the final amount below and
      // zeroing it: a racing donation counts toward either the finished
      // period or the fresh one, and is never lost.
      const claimed = await tx.goal.updateMany({
        where: { id: goal.id, recurring: true, currentPeriodEnd: { lte: now } },
        data: { currentPeriodEnd: nextEnd },
      });
      if (claimed.count === 0) return false;

      const finished = await tx.goal.findUnique({ where: { id: goal.id } });
      if (!finished) return false;

      // Periods are contiguous: a period starts where the last recorded one
      // ended. A goal with no history yet (first reset, or reset before
      // history existed) starts one interval before its end, but never
      // before the goal was created.
      const lastPeriod = await tx.goalPeriod.findFirst({
        where: { goalId: goal.id },
        orderBy: { end: "desc" },
      });
      const oneIntervalBefore = addIntervals(interval, previousEnd, -1);
      const start =
        lastPeriod?.end ?? (goal.createdAt > oneIntervalBefore ? goal.createdAt : oneIntervalBefore);

      await tx.goalPeriod.create({
        data: {
          goalId: goal.id,
          start,
          end: finishedEnd,
          raised: finished.currentAmount,
          targetAmount: finished.targetAmount,
          reached: goalMeetsTarget(finished),
        },
      });
      await tx.goal.update({
        where: { id: goal.id },
        data: { currentAmount: 0, status: "ACTIVE" },
      });
      return true;
    });
    if (didReset) resetCount += 1;
  }

  return resetCount;
}
