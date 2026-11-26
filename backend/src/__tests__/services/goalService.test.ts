jest.mock("../../prisma", () => {
  const client = {
    goal: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    goalPeriod: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    // The reset runs in an interactive transaction; hand the callback the
    // same mocked client so the in-memory stores below see its writes.
    $transaction: jest.fn((callback: (tx: unknown) => unknown): unknown => callback(client)),
  };
  return { __esModule: true, default: client };
});

import { Prisma } from "@prisma/client";
import prisma from "../../prisma";
import { applyDonationToGoals, computePeriodEnd, resetDueGoals } from "../../services/goalService";

const mockedPrisma = prisma as unknown as {
  goal: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  goalPeriod: {
    findFirst: jest.Mock;
    create: jest.Mock;
  };
};

// applyDonationToGoals takes a Prisma.TransactionClient — a plain mocked
// object with the same shape works fine since the goal delegate is all it
// ever touches.
const fakeTransactionClient = () => mockedPrisma as unknown as Prisma.TransactionClient;

type FakeGoal = {
  id: number;
  creatorId?: number;
  currency?: string;
  currentAmount: number | Prisma.Decimal;
  targetAmount?: number | Prisma.Decimal;
  recurring?: boolean;
  status?: string;
  recurrenceInterval?: string | null;
  currentPeriodEnd?: Date | null;
  createdAt?: Date;
};

// Yields to the event loop so two "concurrent" donation flows can interleave
// between a mock's guard-evaluation and its write — the exact window in which
// the old read-modify-write code lost updates (issue #262).
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type GoalWhere = {
  id?: number;
  status?: string;
  recurring?: boolean;
  currentAmount?: { lt?: number | Prisma.Decimal };
  currentPeriodEnd?: { lte?: Date };
  creatorId?: number;
  currency?: string;
};

type GoalData = {
  currentAmount?: number | Prisma.Decimal | { increment?: number | Prisma.Decimal };
  status?: string;
  currentPeriodEnd?: Date;
};

function rowMatches(row: FakeGoal, where: GoalWhere): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.recurring !== undefined && row.recurring !== where.recurring) return false;
  if (where.currentAmount?.lt !== undefined) {
    const cur = new Prisma.Decimal(row.currentAmount);
    const limit = new Prisma.Decimal(where.currentAmount.lt);
    if (!cur.lt(limit)) return false;
  }
  if (
    where.currentPeriodEnd?.lte !== undefined &&
    !(row.currentPeriodEnd != null && row.currentPeriodEnd <= where.currentPeriodEnd.lte)
  )
    return false;
  return true;
}

function applyData(row: FakeGoal, data: GoalData): void {
  if (data.currentAmount !== undefined) {
    if (typeof data.currentAmount === "object" && "increment" in data.currentAmount) {
      const inc = data.currentAmount.increment!;
      row.currentAmount = new Prisma.Decimal(row.currentAmount).add(new Prisma.Decimal(inc as Prisma.Decimal.Value)).toNumber();
    } else {
      row.currentAmount = new Prisma.Decimal(data.currentAmount as Prisma.Decimal.Value).toNumber();
    }
  }
  if (data.status !== undefined) row.status = data.status;
  if (data.currentPeriodEnd !== undefined) row.currentPeriodEnd = data.currentPeriodEnd;
}

/**
 * Wires the prisma mock to an in-memory goal table with database-like write
 * semantics: increments are applied relative to the CURRENT row value, and
 * updateMany re-checks its WHERE guard after yielding the "row lock" — just
 * as Postgres does under READ COMMITTED, where a concurrent transaction's
 * committed change makes a stale guard match zero rows.
 */
function createGoalStore(initialGoals: FakeGoal[]) {
  const rows = new Map(initialGoals.map((goal) => [goal.id, { ...goal }]));

  mockedPrisma.goal.findMany.mockImplementation(async ({ where = {} }: { where?: GoalWhere } = {}) => {
    await tick();
    return [...rows.values()].filter((row) => rowMatches(row, where)).map((row) => ({ ...row }));
  });
  mockedPrisma.goal.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) => {
    await tick();
    const row = rows.get(where.id);
    return row ? { ...row } : null;
  });
  mockedPrisma.goal.update.mockImplementation(async ({ where, data }: { where: { id: number }; data: GoalData }) => {
    const row = rows.get(where.id);
    if (!row) throw new Error(`No goal with id ${where.id}`);
    await tick();
    applyData(row, data);
    return { ...row };
  });
  mockedPrisma.goal.updateMany.mockImplementation(
    async ({ where = {}, data }: { where?: GoalWhere; data?: GoalData } = {}) => {
      const candidates = [...rows.values()].filter((row) => rowMatches(row, where));
      await tick();
      let count = 0;
      for (const row of candidates) {
        if (!rowMatches(row, where)) continue;
        applyData(row, data ?? {});
        count += 1;
      }
      return { count };
    }
  );

  return rows;
}

type FakePeriod = {
  goalId: number;
  start: Date;
  end: Date;
  raised: number | Prisma.Decimal;
  targetAmount: number | Prisma.Decimal;
  reached: boolean;
};

/** In-memory GoalPeriod table for the reset's history rows. */
function createPeriodStore(initialPeriods: FakePeriod[] = []) {
  const periods = initialPeriods.map((period) => ({ ...period }));

  mockedPrisma.goalPeriod.findFirst.mockImplementation(async ({ where }: { where: { goalId: number } }) => {
    const forGoal = periods.filter((period) => period.goalId === where.goalId);
    forGoal.sort((a, b) => b.end.getTime() - a.end.getTime());
    return forGoal[0] ? { ...forGoal[0] } : null;
  });
  mockedPrisma.goalPeriod.create.mockImplementation(async ({ data }: { data: FakePeriod }) => {
    periods.push({ ...data });
    return { ...data };
  });

  return periods;
}

describe("applyDonationToGoals", () => {
  it("does nothing when the creator has no active goals in that currency", async () => {
    mockedPrisma.goal.findMany.mockResolvedValue([]);

    await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10);

    expect(mockedPrisma.goal.update).not.toHaveBeenCalled();
    expect(mockedPrisma.goal.updateMany).not.toHaveBeenCalled();
  });

  it("applies the full donation amount to a single matching active goal", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 20, targetAmount: 100, recurring: false, status: "ACTIVE" },
    ]);

    await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10);

    expect(mockedPrisma.goal.findMany).toHaveBeenCalledWith({
      where: { creatorId: 1, currency: "XLM", status: "ACTIVE" },
    });
    // The increment is applied by the database relative to the current row
    // value — never an absolute amount computed in JS from a possibly-stale
    // read, which is what lost concurrent donations (issue #262).
    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: "ACTIVE", currentAmount: { lt: 100 } },
      data: { currentAmount: { increment: 10 } },
    });
    expect(rows.get(1)!.currentAmount).toBe(30);
  });

  it("applies the FULL amount to every matching active goal, not a split", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 0, targetAmount: 1000, recurring: false, status: "ACTIVE" },
      { id: 2, creatorId: 1, currency: "XLM", currentAmount: 0, targetAmount: 1000, recurring: false, status: "ACTIVE" },
      { id: 3, creatorId: 1, currency: "XLM", currentAmount: 0, targetAmount: 1000, recurring: false, status: "ACTIVE" },
    ]);

    await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 50);

    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledTimes(3);
    for (const id of [1, 2, 3]) {
      expect(mockedPrisma.goal.updateMany).toHaveBeenCalledWith({
        where: { id, status: "ACTIVE", currentAmount: { lt: 1000 } },
        data: { currentAmount: { increment: 50 } },
      });
      expect(rows.get(id)!.currentAmount).toBe(50);
    }
  });

  it("marks a non-recurring goal COMPLETED once it reaches its target", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 95, targetAmount: 100, recurring: false, status: "ACTIVE" },
    ]);

    const reached = await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10);

    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: "ACTIVE", currentAmount: { lt: 100 } },
      data: { currentAmount: { increment: 10 } },
    });
    // The COMPLETED transition is conditional on the goal still being
    // ACTIVE, so a concurrent crossing can't flip it twice.
    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: "ACTIVE" },
      data: { status: "COMPLETED" },
    });
    expect(rows.get(1)!.currentAmount).toBe(105);
    expect(rows.get(1)!.status).toBe("COMPLETED");
    expect(reached).toEqual([expect.objectContaining({ id: 1, currentAmount: 105, status: "COMPLETED" })]);
  });

  it("does NOT mark a recurring goal COMPLETED when it reaches its target — it keeps accumulating until reset", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 95, targetAmount: 100, recurring: true, status: "ACTIVE" },
    ]);

    const reached = await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10);

    expect(mockedPrisma.goal.updateMany).not.toHaveBeenCalledWith({
      where: { id: 1, status: "ACTIVE" },
      data: { status: "COMPLETED" },
    });
    expect(rows.get(1)!.currentAmount).toBe(105);
    expect(rows.get(1)!.status).toBe("ACTIVE");
    expect(reached).toEqual([expect.objectContaining({ id: 1, currentAmount: 105, status: "ACTIVE" })]);
  });

  it("returns only the goals this donation carried to their target", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 95, targetAmount: 100, recurring: false, status: "ACTIVE" },
      { id: 2, creatorId: 1, currency: "XLM", currentAmount: 0, targetAmount: 100, recurring: false, status: "ACTIVE" },
    ]);

    const reached = await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10);

    expect(reached).toHaveLength(1);
    expect(reached[0]).toMatchObject({ id: 1, currentAmount: 105, status: "COMPLETED" });
    expect(rows.get(2)!.currentAmount).toBe(10);
    expect(rows.get(2)!.status).toBe("ACTIVE");
  });

  it("reports a recurring goal as reached only on the donation that crosses its target", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 95, targetAmount: 100, recurring: true, status: "ACTIVE" },
      { id: 2, creatorId: 1, currency: "XLM", currentAmount: 120, targetAmount: 100, recurring: true, status: "ACTIVE" },
    ]);

    const reached = await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10);

    // Goal 1 crossed the target; goal 2 was already past it, so the
    // below-target claim matches nothing and it just keeps accumulating
    // without being reported as reached.
    expect(reached).toHaveLength(1);
    expect(reached[0]).toMatchObject({ id: 1, currentAmount: 105 });
    expect(rows.get(2)!.currentAmount).toBe(130);
  });

  it("completes a non-recurring goal already at its target when a donation lands on it (issue #442)", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 120, targetAmount: 100, recurring: false, status: "ACTIVE" },
    ]);

    const reached = await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10);

    expect(rows.get(1)!.currentAmount).toBe(130);
    expect(rows.get(1)!.status).toBe("COMPLETED");
    expect(reached).toEqual([expect.objectContaining({ id: 1, currentAmount: 130, status: "COMPLETED" })]);
  });

  it("only touches goals denominated in the donated currency", async () => {
    // findMany is already filtered by currency in the query itself, but this
    // asserts the call shape so a regression (e.g. dropping the `currency`
    // filter) is caught even though the mock would otherwise happily return
    // whatever it's told to.
    mockedPrisma.goal.findMany.mockResolvedValue([]);

    await applyDonationToGoals(fakeTransactionClient(), 1, "USDC", 10);

    expect(mockedPrisma.goal.findMany).toHaveBeenCalledWith({
      where: { creatorId: 1, currency: "USDC", status: "ACTIVE" },
    });
  });

  // Issue #18: `currency` is a free-form asset code, not an enum of known
  // assets — a new asset (USDT) needs zero changes here to work, since
  // amounts are tracked per-asset and matched by exact currency string (see
  // the multi-asset design-decision comment at the top of this file).
  it("applies a USDT donation the same way as any other asset — no special-casing needed", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "USDT", currentAmount: 40, targetAmount: 200, recurring: false, status: "ACTIVE" },
    ]);

    await applyDonationToGoals(fakeTransactionClient(), 1, "USDT", 15);

    expect(mockedPrisma.goal.findMany).toHaveBeenCalledWith({
      where: { creatorId: 1, currency: "USDT", status: "ACTIVE" },
    });
    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: "ACTIVE", currentAmount: { lt: 200 } },
      data: { currentAmount: { increment: 15 } },
    });
    expect(rows.get(1)!.currentAmount).toBe(55);
  });
});

describe("concurrent donations (issue #262)", () => {
  it("never loses an increment when two donations land at once", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 95, targetAmount: 1000, recurring: false, status: "ACTIVE" },
    ]);

    await Promise.all([
      applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10),
      applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10),
    ]);

    // 95 + 10 + 10. With the old absolute-value writes both donations
    // started from the same stale 95 and the second clobbered the first,
    // leaving 105 instead of 115.
    expect(rows.get(1)!.currentAmount).toBe(115);
  });

  it("reports a non-recurring goal reached exactly once when concurrent donations cross the target together", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 95, targetAmount: 100, recurring: false, status: "ACTIVE" },
    ]);

    const [first, second] = await Promise.all([
      applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10),
      applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10),
    ]);

    expect(rows.get(1)!.currentAmount).toBe(115);
    expect(rows.get(1)!.status).toBe("COMPLETED");
    expect(first.length + second.length).toBe(1);
  });

  it("reports a recurring goal's crossing exactly once under concurrency", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 95, targetAmount: 100, recurring: true, status: "ACTIVE" },
    ]);

    const [first, second] = await Promise.all([
      applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10),
      applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10),
    ]);

    expect(rows.get(1)!.currentAmount).toBe(115);
    expect(rows.get(1)!.status).toBe("ACTIVE");
    expect(first.length + second.length).toBe(1);
  });
});

describe("computePeriodEnd", () => {
  it("computes a MONTHLY period end one calendar month out", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const end = computePeriodEnd("MONTHLY", from);
    expect(end.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("clamps a MONTHLY period end to the last day of a shorter month, keeping the time of day", () => {
    expect(computePeriodEnd("MONTHLY", new Date("2026-01-31T15:30:00.000Z")).toISOString()).toBe(
      "2026-02-28T15:30:00.000Z"
    );
    expect(computePeriodEnd("MONTHLY", new Date("2028-01-31T15:30:00.000Z")).toISOString()).toBe(
      "2028-02-29T15:30:00.000Z"
    );
    expect(computePeriodEnd("MONTHLY", new Date("2026-03-31T00:00:00.000Z")).toISOString()).toBe(
      "2026-04-30T00:00:00.000Z"
    );
  });

  it("rolls a MONTHLY period end over the year boundary", () => {
    const end = computePeriodEnd("MONTHLY", new Date("2026-12-31T00:00:00.000Z"));
    expect(end.toISOString()).toBe("2027-01-31T00:00:00.000Z");
  });

  it("computes a WEEKLY period end 7 days out", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const end = computePeriodEnd("WEEKLY", from);
    expect(end.toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });
});

describe("resetDueGoals", () => {
  beforeEach(() => {
    createPeriodStore();
  });

  it("resets currentAmount to 0, reactivates, and rolls currentPeriodEnd forward for every due recurring goal", async () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    const rows = createGoalStore([
      {
        id: 1,
        creatorId: 1,
        currency: "XLM",
        currentAmount: 500,
        targetAmount: 1000,
        recurring: true,
        recurrenceInterval: "MONTHLY",
        status: "COMPLETED",
        currentPeriodEnd: new Date("2026-01-31T00:00:00.000Z"),
      },
    ]);

    const count = await resetDueGoals(now);

    expect(mockedPrisma.goal.findMany).toHaveBeenCalledWith({
      where: { recurring: true, currentPeriodEnd: { lte: now } },
    });
    // The period is claimed with the same due-condition the findMany used,
    // so a racing scheduler tick that already rolled the period forward
    // matches zero rows and can't reset the goal a second time (issue #262).
    // The next end is one calendar month after the previous end (Jan 31 →
    // Feb 28), not one interval after the tick time.
    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledWith({
      where: { id: 1, recurring: true, currentPeriodEnd: { lte: now } },
      data: { currentPeriodEnd: new Date("2026-02-28T00:00:00.000Z") },
    });
    expect(mockedPrisma.goal.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { currentAmount: 0, status: "ACTIVE" },
    });
    expect(count).toBe(1);
    expect(rows.get(1)!.currentAmount).toBe(0);
    expect(rows.get(1)!.status).toBe("ACTIVE");
    expect(rows.get(1)!.currentPeriodEnd).toEqual(new Date("2026-02-28T00:00:00.000Z"));
  });

  it("advances a goal due 10 minutes ago to exactly one interval after its old end, not after now", async () => {
    const weeklyEnd = new Date("2026-03-02T09:00:00.000Z");
    const monthlyEnd = new Date("2026-03-02T09:00:00.000Z");
    const now = new Date(weeklyEnd.getTime() + 10 * 60 * 1000);
    const rows = createGoalStore([
      {
        id: 1,
        currentAmount: 30,
        targetAmount: 100,
        recurring: true,
        recurrenceInterval: "WEEKLY",
        status: "ACTIVE",
        currentPeriodEnd: weeklyEnd,
      },
      {
        id: 2,
        currentAmount: 30,
        targetAmount: 100,
        recurring: true,
        recurrenceInterval: "MONTHLY",
        status: "ACTIVE",
        currentPeriodEnd: monthlyEnd,
      },
    ]);

    const count = await resetDueGoals(now);

    expect(count).toBe(2);
    expect(rows.get(1)!.currentPeriodEnd).toEqual(new Date("2026-03-09T09:00:00.000Z"));
    expect(rows.get(2)!.currentPeriodEnd).toEqual(new Date("2026-04-02T09:00:00.000Z"));
  });

  it("skips over several missed periods, staying on the original schedule", async () => {
    const oldEnd = new Date("2026-03-02T09:00:00.000Z");
    // The backend was down for 17 days: two more weekly boundaries passed.
    const now = new Date(oldEnd.getTime() + 17 * 24 * 60 * 60 * 1000);
    const rows = createGoalStore([
      {
        id: 1,
        currentAmount: 30,
        targetAmount: 100,
        recurring: true,
        recurrenceInterval: "WEEKLY",
        status: "ACTIVE",
        currentPeriodEnd: oldEnd,
      },
    ]);
    const periods = createPeriodStore();

    const count = await resetDueGoals(now);

    expect(count).toBe(1);
    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledTimes(1);
    expect(rows.get(1)!.currentPeriodEnd).toEqual(new Date("2026-03-23T09:00:00.000Z"));
    // One history row covering everything up to the last boundary that passed.
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({
      start: new Date("2026-02-23T09:00:00.000Z"),
      end: new Date("2026-03-16T09:00:00.000Z"),
    });
  });

  it("keeps a monthly goal created on the 31st on valid calendar dates", async () => {
    const createdAt = new Date("2026-01-31T12:00:00.000Z");
    const firstEnd = computePeriodEnd("MONTHLY", createdAt);
    expect(firstEnd).toEqual(new Date("2026-02-28T12:00:00.000Z"));
    const rows = createGoalStore([
      {
        id: 1,
        currentAmount: 0,
        targetAmount: 100,
        recurring: true,
        recurrenceInterval: "MONTHLY",
        status: "ACTIVE",
        currentPeriodEnd: firstEnd,
        createdAt,
      },
    ]);
    const periods = createPeriodStore();

    await resetDueGoals(new Date("2026-02-28T13:00:00.000Z"));
    expect(rows.get(1)!.currentPeriodEnd).toEqual(new Date("2026-03-28T12:00:00.000Z"));

    await resetDueGoals(new Date("2026-03-28T13:00:00.000Z"));
    expect(rows.get(1)!.currentPeriodEnd).toEqual(new Date("2026-04-28T12:00:00.000Z"));

    // The first period starts at creation; later ones start where the
    // previous recorded period ended.
    expect(periods.map(({ start, end }) => [start.toISOString(), end.toISOString()])).toEqual([
      ["2026-01-31T12:00:00.000Z", "2026-02-28T12:00:00.000Z"],
      ["2026-02-28T12:00:00.000Z", "2026-03-28T12:00:00.000Z"],
    ]);
  });

  it("steps missed months from the old end, so a clamped month doesn't pull later ends earlier", async () => {
    const rows = createGoalStore([
      {
        id: 1,
        currentAmount: 0,
        targetAmount: 100,
        recurring: true,
        recurrenceInterval: "MONTHLY",
        status: "ACTIVE",
        currentPeriodEnd: new Date("2026-01-31T00:00:00.000Z"),
      },
    ]);
    const periods = createPeriodStore();

    // Feb 28 and Mar 31 both passed while the backend was down.
    await resetDueGoals(new Date("2026-04-01T00:00:00.000Z"));

    expect(rows.get(1)!.currentPeriodEnd).toEqual(new Date("2026-04-30T00:00:00.000Z"));
    expect(periods[0].end).toEqual(new Date("2026-03-31T00:00:00.000Z"));
  });

  it("records the finished period's final amount and target outcome before zeroing it", async () => {
    const now = new Date("2026-03-09T10:00:00.000Z");
    const rows = createGoalStore([
      {
        id: 1,
        currentAmount: new Prisma.Decimal("120.5"),
        targetAmount: new Prisma.Decimal(100),
        recurring: true,
        recurrenceInterval: "WEEKLY",
        status: "ACTIVE",
        currentPeriodEnd: new Date("2026-03-09T09:00:00.000Z"),
      },
      {
        id: 2,
        currentAmount: 40,
        targetAmount: 100,
        recurring: true,
        recurrenceInterval: "WEEKLY",
        status: "ACTIVE",
        currentPeriodEnd: new Date("2026-03-09T09:00:00.000Z"),
      },
    ]);
    const periods = createPeriodStore([
      {
        goalId: 1,
        start: new Date("2026-02-23T09:00:00.000Z"),
        end: new Date("2026-03-02T09:00:00.000Z"),
        raised: 80,
        targetAmount: 100,
        reached: false,
      },
    ]);

    await resetDueGoals(now);

    expect(mockedPrisma.goalPeriod.create).toHaveBeenCalledWith({
      data: {
        goalId: 1,
        start: new Date("2026-03-02T09:00:00.000Z"),
        end: new Date("2026-03-09T09:00:00.000Z"),
        raised: new Prisma.Decimal("120.5"),
        targetAmount: new Prisma.Decimal(100),
        reached: true,
      },
    });
    expect(periods.find((period) => period.goalId === 2)).toMatchObject({
      start: new Date("2026-03-02T09:00:00.000Z"),
      end: new Date("2026-03-09T09:00:00.000Z"),
      raised: 40,
      reached: false,
    });
    // The history row is written before the amount is zeroed.
    const createOrder = mockedPrisma.goalPeriod.create.mock.invocationCallOrder[0];
    const zeroOrder = mockedPrisma.goal.update.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(zeroOrder);
    expect(rows.get(1)!.currentAmount).toBe(0);
    expect(rows.get(2)!.currentAmount).toBe(0);
  });

  it("does not touch goals whose period has not yet ended", async () => {
    mockedPrisma.goal.findMany.mockResolvedValue([]);

    const count = await resetDueGoals(new Date("2026-02-01T00:00:00.000Z"));

    expect(mockedPrisma.goal.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.goal.update).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it("resets multiple due goals independently, using each one's own interval", async () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    const rows = createGoalStore([
      {
        id: 1,
        creatorId: 1,
        currency: "XLM",
        currentAmount: 10,
        targetAmount: 100,
        recurring: true,
        recurrenceInterval: "MONTHLY",
        status: "ACTIVE",
        currentPeriodEnd: now,
      },
      {
        id: 2,
        creatorId: 1,
        currency: "XLM",
        currentAmount: 20,
        targetAmount: 100,
        recurring: true,
        recurrenceInterval: "WEEKLY",
        status: "ACTIVE",
        currentPeriodEnd: now,
      },
    ]);

    const count = await resetDueGoals(now);

    expect(count).toBe(2);
    expect(rows.get(1)!.currentPeriodEnd).toEqual(computePeriodEnd("MONTHLY", now));
    expect(rows.get(2)!.currentPeriodEnd).toEqual(computePeriodEnd("WEEKLY", now));
    expect(rows.get(1)!.currentAmount).toBe(0);
    expect(rows.get(2)!.currentAmount).toBe(0);
  });

  it("does not re-reset a goal whose period a racing tick already rolled forward", async () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    const alreadyResetPeriodEnd = computePeriodEnd("MONTHLY", now);
    const rows = createGoalStore([
      {
        id: 1,
        creatorId: 1,
        currency: "XLM",
        currentAmount: 42,
        targetAmount: 100,
        recurring: true,
        recurrenceInterval: "MONTHLY",
        status: "ACTIVE",
        currentPeriodEnd: alreadyResetPeriodEnd,
      },
    ]);
    // Simulate the findMany snapshot having been taken before the racing
    // tick's reset committed — the goal looks due in the stale list, but
    // the guarded updateMany re-checks the row and finds it is not due.
    mockedPrisma.goal.findMany.mockResolvedValue([
      {
        id: 1,
        recurring: true,
        recurrenceInterval: "MONTHLY",
        currentAmount: 500,
        status: "COMPLETED",
        currentPeriodEnd: new Date("2026-01-31T00:00:00.000Z"),
      },
    ]);

    const count = await resetDueGoals(now);

    expect(count).toBe(0);
    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledTimes(1);
    expect(rows.get(1)!.currentAmount).toBe(42);
    expect(rows.get(1)!.currentPeriodEnd).toEqual(alreadyResetPeriodEnd);
  });

  it("accumulates small donations using decimal arithmetic: 0.1 ten times reaches a goal of 1 and marks it complete (#372)", async () => {
    const rows = createGoalStore([
      {
        id: 1,
        creatorId: 1,
        currency: "XLM",
        currentAmount: new Prisma.Decimal(0),
        targetAmount: new Prisma.Decimal(1),
        recurring: false,
        status: "ACTIVE",
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let finalCompletedGoal: any = null;
    for (let i = 0; i < 10; i++) {
      const reached = await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 0.1);
      if (reached.length > 0) {
        finalCompletedGoal = reached[0];
      }
    }

    expect(rows.get(1)!.currentAmount).toBe(1);
    expect(rows.get(1)!.status).toBe("COMPLETED");
    expect(finalCompletedGoal).not.toBeNull();
    expect(finalCompletedGoal.status).toBe("COMPLETED");
  });
});
