ALTER TABLE "EmailEvent" ADD COLUMN "svixId" TEXT;

CREATE UNIQUE INDEX "EmailEvent_svixId_key" ON "EmailEvent"("svixId");
