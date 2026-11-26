-- History of a recurring goal's finished periods: a reset records how much
-- the period raised and whether it reached its target before zeroing
-- Goal.currentAmount.
-- CreateTable
CREATE TABLE "GoalPeriod" (
    "id" SERIAL NOT NULL,
    "goalId" INTEGER NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "raised" DECIMAL(20,7) NOT NULL,
    "targetAmount" DECIMAL(20,7) NOT NULL,
    "reached" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoalPeriod_goalId_end_idx" ON "GoalPeriod"("goalId", "end");

-- AddForeignKey
ALTER TABLE "GoalPeriod" ADD CONSTRAINT "GoalPeriod_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
