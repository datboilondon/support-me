import { nativeToScVal } from "@stellar/stellar-sdk";
import prisma from "../prisma";
import { SorobanEventListener, RawEvent } from "../services/sorobanEventListener";

const wallet = "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW";
let creatorId: number;
let onChainId = 1;

beforeEach(async () => {
  const schema = process.env.INTEGRATION_SCHEMA;
  if (!schema || !/^integration_[a-f0-9]{32}$/.test(schema)) {
    throw new Error("Use npm run test:integration to create an isolated schema");
  }
  const configuredSchema = new URL(process.env.DATABASE_URL!).searchParams.get("schema");
  if (configuredSchema !== schema) throw new Error("Refusing to truncate outside the integration schema");
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "${schema}"."User", "${schema}"."Creator", "${schema}"."Donation", ` +
      `"${schema}"."DonationIdempotencyKey", "${schema}"."Goal", "${schema}"."Withdrawal", ` +
      `"${schema}"."Subscription" RESTART IDENTITY CASCADE`
  );
  onChainId = 1;
  const creator = await prisma.creator.create({
    data: { username: "constraint-creator", walletAddress: wallet, user: { create: { walletAddress: wallet } } },
  });
  creatorId = creator.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function donation(amount: number) {
  return prisma.donation.create({ data: { creatorId, senderAddress: wallet, amount } });
}

function withdrawal(amountIn: number) {
  return prisma.withdrawal.create({
    data: { creatorId, amountIn, anchorTxId: `constraint-anchor-${onChainId++}` },
  });
}

function subscription(amount: number, intervalSecs: number) {
  return prisma.subscription.create({
    data: {
      creatorId,
      supporterAddress: wallet,
      token: "XLM",
      amount,
      intervalSecs,
      onChainId: onChainId++,
      nextChargeAt: new Date(),
    },
  });
}

function goal(targetAmount: number, currentAmount: number) {
  return prisma.goal.create({ data: { creatorId, targetAmount, currentAmount, currency: "XLM" } });
}

const violatingRows = [
  { name: "a zero donation", constraint: "Donation_amount_positive", write: () => donation(0) },
  { name: "a negative donation", constraint: "Donation_amount_positive", write: () => donation(-1) },
  { name: "a zero withdrawal", constraint: "Withdrawal_amountIn_positive", write: () => withdrawal(0) },
  { name: "a negative withdrawal", constraint: "Withdrawal_amountIn_positive", write: () => withdrawal(-1) },
  { name: "a zero subscription amount", constraint: "Subscription_amount_positive", write: () => subscription(0, 30) },
  { name: "a negative subscription amount", constraint: "Subscription_amount_positive", write: () => subscription(-1, 30) },
  { name: "a zero subscription interval", constraint: "Subscription_intervalSecs_positive", write: () => subscription(1, 0) },
  { name: "a negative subscription interval", constraint: "Subscription_intervalSecs_positive", write: () => subscription(1, -30) },
  { name: "a zero goal target", constraint: "Goal_targetAmount_positive", write: () => goal(0, 0) },
  { name: "a negative goal target", constraint: "Goal_targetAmount_positive", write: () => goal(-1, 0) },
  { name: "negative goal progress", constraint: "Goal_currentAmount_nonnegative", write: () => goal(10, -1) },
];

it.each(violatingRows)("rejects $name at the database", async ({ constraint, write }) => {
  const error = await write().then(
    () => null,
    (reason: Error) => reason
  );

  expect(error).not.toBeNull();
  expect(error!.message).toContain(constraint);
  // SQLSTATE 23514 is check_violation. Prisma's ORM path buries it in the
  // wrapped PostgresError message rather than exposing a stable error code.
  expect(error!.message).toMatch(/23514|violates check constraint/i);
  expect(await prisma.donation.count()).toBe(0);
  expect(await prisma.withdrawal.count()).toBe(0);
  expect(await prisma.subscription.count()).toBe(0);
  expect(await prisma.goal.count()).toBe(0);
});

it("still accepts boundary-valid rows", async () => {
  const smallestDonation = 0.0000001; // one stroop in whole units
  await donation(smallestDonation);
  await withdrawal(0.0000001);
  await subscription(0.0000001, 1);
  await goal(0.0000001, 0);

  expect(await prisma.donation.count()).toBe(1);
  expect(await prisma.withdrawal.count()).toBe(1);
  expect(await prisma.subscription.count()).toBe(1);
  expect((await prisma.goal.findFirstOrThrow()).currentAmount.toString()).toBe("0");
});

it("logs and skips a listener event whose donation amount violates the CHECK constraint", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  const encode = (value: unknown) => nativeToScVal(value).toXDR("base64");
  const event: RawEvent = {
    type: "contract",
    ledger: 1200,
    id: "constraint-rpc-event",
    txHash: "constraint-transaction",
    topic: [encode("donated"), encode(wallet), encode(wallet)],
    value: encode({ amount: -100000000n, memo: "invalid", timestamp: 1713182400n }),
  };

  try {
    const listener = new SorobanEventListener();
    // The bad event is handled and skipped, not rethrown into poll(), so the
    // cursor can advance past it instead of replaying it forever.
    await expect(listener.processEvent(event)).resolves.toBe(true);

    expect(await prisma.donation.count()).toBe(0);
    expect(await prisma.goal.count()).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skipping donated event"),
      expect.stringContaining("Donation_amount_positive")
    );
  } finally {
    warn.mockRestore();
  }
});
