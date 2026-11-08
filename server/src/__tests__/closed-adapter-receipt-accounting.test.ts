import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, costEvents, createDb, environmentLeases, environments, heartbeatRuns,
  type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { accountRunCost, readCostAccountingWork, reconcileRunCosts } from "../services/run-cost-accounting.js";
import { persistUsageReceipt } from "../services/usage-receipts.js";
import { legacyControllerBootId, settleTerminalLegacyController } from "../services/legacy-controller-lease.js";
import { DELIVERY_QUEUES, notifyDeliveryWork, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerCostAccountingWork } from "../services/budget-enforcement-worker.js";
import { reconcileDatabaseWork } from "@paperclipai/db/work-signals";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("closed remote adapter receipt accounting", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("closed-adapter-receipt-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE companies CASCADE`);
  }); });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(change: Partial<typeof heartbeatRuns.$inferInsert> = {}, proof: "stopped" | "missing" | "foreign" | "active" = "stopped") {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), sourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stopped adapter", issuePrefix: "STOP" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Adapter", role: "engineer", status: "idle", adapterType: "opencode_local" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", runtimeMode: "legacy",
      status: "failed", finishedAt: new Date(), controllerBootId: randomUUID(), controllerLeaseExpiresAt: null,
      processPid: null, processGroupId: null, processStartedAt: null, executionControlDeadlineAt: null,
      costAccountingPending: true, usageJson: { accountingReceiptReady: false, accountingReceiptSourceId: sourceId,
        accountingReceiptSequence: 5, provider: "openai", biller: "openai", model: "gpt-6.1-sol",
        billingType: "metered_api", usageSource: "per_run", inputTokens: 66096, outputTokens: 913,
        costUsd: 0.1974522, budgetExposure: { sourceId, sequence: 5, costCents: "19.7452200" } }, ...change });
    const [environment] = await db.insert(environments).values({ name: `Stopped ${runId}`, driver: "sandbox", config: { provider: "test-provider" } }).returning();
    const leaseId = randomUUID(), providerLeaseId = randomUUID();
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId: environment.id, heartbeatRunId: runId,
      provider: "test-provider", providerLeaseId, leasePolicy: "ephemeral", status: proof === "active" ? "active" : "failed",
      cleanupStatus: proof === "active" ? null : "success", releasedAt: proof === "active" ? null : new Date(),
      metadata: proof === "missing" ? {} : { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1",
        companyId, runId, leaseId, provider: "test-provider", providerLeaseId: proof === "foreign" ? randomUUID() : providerLeaseId,
        state: "stopped", confirmedAt: new Date().toISOString() } } });
    const readRun = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
    const charges = () => db.select().from(costEvents).where(and(eq(costEvents.companyId, companyId), eq(costEvents.heartbeatRunId, runId)));
    return { companyId, agentId, runId, sourceId, leaseId, readRun, charges };
  }

  it("settles historical stopped adapter debt once as a lower bound, not complete usage", async () => {
    const f = await fixture();
    expect((await readCostAccountingWork(db)).pending).toBe(true);
    expect(await reconcileRunCosts(db)).toMatchObject({ accounted: 1 });
    expect(await accountRunCost(db, f.runId)).toBe(false);
    const run = await f.readRun();
    expect(run).toMatchObject({ status: "failed", runtimeMode: "legacy", costAccountingPending: false,
      usageJson: { accountingReceiptReady: false, accountingReceiptUnavailable: true, costStatus: "estimated" } });
    expect(await f.charges()).toMatchObject([{ costStatus: "estimated", costCents: 19.74522,
      pricingProvenance: { evidence: expect.stringContaining("lower bound") } }]);
    expect(await f.charges()).toHaveLength(1);
    expect(await readCostAccountingWork(db)).toEqual({ pending: false, nextRunAt: null });
  });

  it.each(["failed", "timed_out", "cancelled", "interrupted"])("settles only closed remote %s producers", async status => {
    const f = await fixture({ status });
    expect(await accountRunCost(db, f.runId)).toBe(true);
    expect((await f.readRun()).status).toBe(status);
  });

  it.each(["missing", "foreign", "active"] as const)("retains debt with %s stop proof", async proof => {
    const f = await fixture({}, proof);
    expect(await accountRunCost(db, f.runId)).toBe(false);
    expect((await f.readRun()).costAccountingPending).toBe(true);
    expect(await f.charges()).toHaveLength(0);
  });

  it.each([
    { status: "running", finishedAt: null }, { status: "succeeded" }, { finishedAt: null },
    { controllerLeaseExpiresAt: new Date(Date.now() + 60000) }, { executionControlDeadlineAt: new Date() },
    { processPid: 123, processGroupId: 123, processStartedAt: new Date() },
    { scheduledRetryAt: new Date(Date.now() + 60000) }, { runtimeMode: "native" },
  ])("does not infer closure from terminal status or process absence alone: %j", async change => {
    const f = await fixture(change);
    expect(await accountRunCost(db, f.runId)).toBe(false);
    expect((await f.readRun()).costAccountingPending).toBe(true);
    expect(await f.charges()).toHaveLength(0);
  });

  it("requires a stop receipt for every allocation, not merely the latest", async () => {
    const f = await fixture();
    const [first] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: first.environmentId,
      heartbeatRunId: f.runId, provider: "test-provider", providerLeaseId: randomUUID(), leasePolicy: "ephemeral",
      status: "failed", cleanupStatus: "success", releasedAt: new Date(), metadata: {} });
    expect(await accountRunCost(db, f.runId)).toBe(false);
    expect(await f.charges()).toHaveLength(0);
  });

  it("reconciles a later complete receipt as growth, without double-charging", async () => {
    const f = await fixture();
    expect(await accountRunCost(db, f.runId)).toBe(true);
    await persistUsageReceipt(db, { schema: "paperclip/accounting-receipt/v1", id: randomUUID(),
      companyId: f.companyId, runId: f.runId, adapterType: "opencode_local", sourceId: f.sourceId, sequence: 6,
      receivedAt: new Date().toISOString(), receipt: { complete: true, usageBasis: "per_run", provider: "openai", biller: "openai",
        model: "gpt-6.1-sol", billingType: "metered_api", costUsd: 0.25, costStatus: "reported",
        usage: { inputTokens: 80000, cachedInputTokens: 0, outputTokens: 1000 },
        pricingProvenance: { source: "provider_reported", version: "test" } } });
    await accountRunCost(db, f.runId);
    const charges = await f.charges();
    expect(charges.reduce((sum, row) => sum + Number(row.costCents), 0)).toBeCloseTo(25, 6);
    expect((await f.readRun()).costAccountingPending).toBe(false);
  });

  it("wakes accounting when terminal teardown clears authority after the cleanup wake was consumed", async () => {
    const f = await fixture({ controllerBootId: legacyControllerBootId, controllerLeaseExpiresAt: new Date(Date.now() + 60000) });
    const errors: unknown[] = [];
    const reconcile = vi.fn(() => reconcileRunCosts(db));
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = registerCostAccountingWork(db, coordinator, reconcile);
    try {
      await worker.ready;
      await db.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.environmentCleanup, f.companyId));
      await vi.waitFor(() => expect(reconcile.mock.calls.length).toBeGreaterThanOrEqual(2));
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
      expect(await f.charges()).toHaveLength(0);
      expect((await f.readRun()).costAccountingPending).toBe(true);
      const before = reconcile.mock.calls.length;
      await settleTerminalLegacyController(db, { id: f.runId, companyId: f.companyId });
      await vi.waitFor(async () => expect(await f.charges()).toHaveLength(1));
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
      expect(reconcile.mock.calls.length).toBeGreaterThan(before);
      expect((await f.readRun()).usageJson).toMatchObject({ accountingReceiptReady: false, costStatus: "estimated" });
      expect(await accountRunCost(db, f.runId)).toBe(false);
      expect(errors).toEqual([]);
    } finally { worker.stop(); await coordinator.stop(); }
  });

  it("defers accounting wake to outer settlement and retains authority on rollback", async () => {
    const f = await fixture({ controllerBootId: legacyControllerBootId, controllerLeaseExpiresAt: new Date(Date.now() + 60000) });
    const wake = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.accounting, wake);
    try {
      await expect(db.transaction(async tx => {
        await settleTerminalLegacyController(tx as unknown as Db, { id: f.runId, companyId: f.companyId });
        expect(wake).not.toHaveBeenCalled();
        expect((await f.readRun()).controllerLeaseExpiresAt).not.toBeNull();
        expect(await readCostAccountingWork(db)).toEqual({ pending: false, nextRunAt: null });
        throw new Error("rollback teardown");
      })).rejects.toThrow("rollback teardown");
      // The shared protocol also wakes on a failed transaction to resolve its
      // uncertain outcome; that hint is not evidence that authority cleared.
      expect(wake).toHaveBeenCalledTimes(1);
      expect((await f.readRun()).controllerLeaseExpiresAt).not.toBeNull();
      await reconcileDatabaseWork(db, DELIVERY_QUEUES.accounting);
      expect(await accountRunCost(db, f.runId)).toBe(false);
      expect(await f.charges()).toHaveLength(0);
      wake.mockClear();
      await db.transaction(async tx => {
        await settleTerminalLegacyController(tx as unknown as Db, { id: f.runId, companyId: f.companyId });
        expect(wake).not.toHaveBeenCalled();
      });
      expect(wake).toHaveBeenCalledTimes(1);
      expect((await f.readRun()).controllerLeaseExpiresAt).toBeNull();
    } finally { unsubscribe(); }
  });
});
