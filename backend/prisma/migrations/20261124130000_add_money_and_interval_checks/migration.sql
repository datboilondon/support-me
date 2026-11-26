-- Money and recurring intervals are currently validated only by zod in the
-- HTTP layer. Rows written by the Soroban listener and services bypass those
-- schemas, so the database must enforce the same invariants (#485).
--
-- Fail closed: never rewrite or delete financial rows to make a constraint
-- fit. If production already contains violators, this migration stops with
-- the row ids so they can be corrected deliberately; applying a CHECK would
-- otherwise fail with a generic Postgres error and no remediation context.
--
-- Share-row-exclusive blocks writes (but not reads) on these tables until the
-- migration commits, so a row cannot slip in between the check and the CHECK.
LOCK TABLE "Donation", "Withdrawal", "Subscription", "Goal"
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  bad_donations bigint;
  bad_withdrawals bigint;
  bad_subscriptions bigint;
  bad_goals bigint;
  donation_ids integer[];
  withdrawal_ids integer[];
  subscription_ids integer[];
  goal_ids integer[];
BEGIN
  SELECT count(*), (array_agg("id" ORDER BY "id"))[1:20]
    INTO bad_donations, donation_ids
    FROM "Donation"
    WHERE "amount" <= 0;

  SELECT count(*), (array_agg("id" ORDER BY "id"))[1:20]
    INTO bad_withdrawals, withdrawal_ids
    FROM "Withdrawal"
    WHERE "amountIn" <= 0;

  SELECT count(*), (array_agg("id" ORDER BY "id"))[1:20]
    INTO bad_subscriptions, subscription_ids
    FROM "Subscription"
    WHERE "amount" <= 0 OR "intervalSecs" <= 0;

  SELECT count(*), (array_agg("id" ORDER BY "id"))[1:20]
    INTO bad_goals, goal_ids
    FROM "Goal"
    WHERE "targetAmount" <= 0 OR "currentAmount" < 0;

  IF bad_donations + bad_withdrawals + bad_subscriptions + bad_goals > 0 THEN
    RAISE EXCEPTION
      'Cannot add money/interval CHECK constraints: existing rows violate them'
      USING DETAIL = format(
        'Donation.amount<=0: %s row(s), sample ids %s; ' ||
        'Withdrawal.amountIn<=0: %s row(s), sample ids %s; ' ||
        'Subscription.amount<=0 OR intervalSecs<=0: %s row(s), sample ids %s; ' ||
        'Goal.targetAmount<=0 OR currentAmount<0: %s row(s), sample ids %s',
        bad_donations, COALESCE(donation_ids::text, '[]'),
        bad_withdrawals, COALESCE(withdrawal_ids::text, '[]'),
        bad_subscriptions, COALESCE(subscription_ids::text, '[]'),
        bad_goals, COALESCE(goal_ids::text, '[]')
      ),
      HINT = 'Correct or archive the listed rows, then re-run the migration. This migration intentionally does not modify financial data.';
  END IF;
END $$;

-- A zero/negative donation has no valid meaning and would corrupt creator
-- totals and goal progress.
ALTER TABLE "Donation"
  ADD CONSTRAINT "Donation_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "Withdrawal"
  ADD CONSTRAINT "Withdrawal_amountIn_positive" CHECK ("amountIn" > 0);

-- intervalSecs = 0 makes the executor consider the subscription due on every
-- tick, producing an unbounded charge loop.
ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "Subscription_intervalSecs_positive" CHECK ("intervalSecs" > 0);

-- A goal starts at 0 and only increases; zero progress is valid, a negative
-- target or progress is not.
ALTER TABLE "Goal"
  ADD CONSTRAINT "Goal_targetAmount_positive" CHECK ("targetAmount" > 0),
  ADD CONSTRAINT "Goal_currentAmount_nonnegative" CHECK ("currentAmount" >= 0);
