import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentTaskSessions, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues } from "@paperclipai/db";
import { adapterExecutionTargetSessionIdentity, adapterExecutionTargetSessionMatches, runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { execute } from "@paperclipai/adapter-opencode-local/server";
import { createPaperclipAssignmentReceipt } from "@paperclipai/adapter-utils/server-utils";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { environmentService } from "./environments.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { resolveEnvironmentExecutionTarget } from "./environment-execution-target.js";
import { getAdapterSessionCodec, resolveNextSessionState } from "./heartbeat/run-state.js";

vi.mock("@paperclipai/adapter-utils/execution-target", async importOriginal => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  prepareAdapterExecutionTargetRuntime: async () => ({
    workspaceRemoteDir: "/workspace/project", runtimeRootDir: "/workspace/project/.paperclip-runtime/opencode",
    assetDirs: {}, restoreWorkspace: async () => {},
  }),
  readAdapterExecutionTargetHomeDir: async () => "/home/guest",
  startAdapterExecutionTargetPaperclipBridge: async () => null,
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: async (_db: unknown, _company: string, environment: { config: { reuse?: boolean } }) => ({
    driver: "sandbox", config: { provider: "test-provider", reuseLease: environment.config.reuse !== false },
  }),
}));

describe("sandbox session continuity from authoritative lease handoffs", () => {
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("session-continuity-");
    db = createDb(postgres.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await postgres?.cleanup(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Continuity", issuePrefix: `S${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Session agent", adapterType: "opencode_local" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Continue" }).returning();
    const [environment] = await db.insert(environments).values({ name: randomUUID(), driver: "sandbox", config: {} }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: company.id, name: "Session workspace", mode: "shared_workspace", strategyType: "test" }).returning();
    const [firstRun, secondRun] = await db.insert(heartbeatRuns).values([
      { companyId: company.id, agentId: agent.id, issueId: issue.id, status: "succeeded", finishedAt: new Date() },
      { companyId: company.id, agentId: agent.id, issueId: issue.id, status: "running" },
    ]).returning();
    const svc = environmentService(db);
    const values = { companyId: company.id, environmentId: environment.id, executionWorkspaceId: workspace.id,
      issueId: issue.id, provider: "test-provider", providerLeaseId: randomUUID(), leasePolicy: "reuse_by_environment" as const,
      metadata: { agentId: agent.id, remoteCwd: "/workspace/project", sandboxLeaseAcquisition: { outcome: "resumed" } } };
    const previous = await svc.acquireLease({ ...values, heartbeatRunId: firstRun.id });
    const release = async (lease: typeof previous) => svc.releaseLease(lease.id, "released", {
      cleanupStatus: "success", remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }),
    });
    await release(previous);
    const current = await svc.acquireLease({ ...values, heartbeatRunId: secondRun.id, replacesReusableLeaseId: previous.id });
    const resolve = async (lease: typeof current | typeof environmentLeases.$inferSelect = current, reuse = true) => resolveEnvironmentExecutionTarget({ db, companyId: company.id, adapterType: "opencode_local",
      environment: { ...environment, config: { reuse } }, leaseId: lease.id, leaseMetadata: lease.metadata, lease: lease as never,
      environmentRuntime: { supportsSync: () => false, execute: async (input: { cwd?: string }) => {
        expect(input.cwd === "/" || input.cwd === "/workspace" || input.cwd?.startsWith("/workspace/")).toBe(true);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      } } as never });
    const identity = (id: string) => ({ transport: "sandbox", providerKey: values.provider, environmentId: environment.id,
      leaseId: id, remoteCwd: "/workspace/project" });
    const read = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0];
    return { company, agent, issue, environment, workspace, firstRun, secondRun, svc, values, previous, current, release, resolve, identity, read };
  }

  it("resumes A→B→C using only the immediate predecessor, preserving current saved identity", async () => {
    const f = await fixture();
    const secondTarget = await f.resolve();
    expect(adapterExecutionTargetSessionMatches(f.identity(f.previous.id), secondTarget)).toBe(true);
    expect(adapterExecutionTargetSessionIdentity(secondTarget)).toEqual(f.identity(f.current.id));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.secondRun.id));
    await f.release(f.current);
    const [thirdRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, issueId: f.issue.id, status: "running" }).returning();
    const third = await f.svc.acquireLease({ ...f.values, heartbeatRunId: thirdRun.id, replacesReusableLeaseId: f.current.id });
    const thirdTarget = await f.resolve(third);
    expect(adapterExecutionTargetSessionMatches(f.identity(f.current.id), thirdTarget)).toBe(true);
    expect(adapterExecutionTargetSessionMatches(f.identity(f.previous.id), thirdTarget)).toBe(false);
    expect(adapterExecutionTargetSessionIdentity(thirdTarget)).toEqual(f.identity(third.id));
    // Reconstructing the target from persisted rows after a controller restart
    // recreates the host-only grant; no ephemeral process map owns continuity.
    expect(adapterExecutionTargetSessionMatches(f.identity(f.current.id), await f.resolve(await f.read(third.id)))).toBe(true);
  });

  it.each(["company", "environment", "workspace", "issue", "agent", "provider", "allocation", "prior_active", "cleanup", "policy", "timestamp", "acquired", "missing_incoming", "missing_outgoing", "altered_receipt", "malformed_id", "no_stop", "destroyed", "wrong_stop", "prior_run_active", "prior_run_agent", "current_inactive", "current_policy", "current_successor", "replacement", "acquisition_allocation", "stop_missing_time", "stop_invalid_time", "stop_future_time", "stop_early_time", "current_run_idle", "current_run_company", "current_run_agent", "current_run_issue", "missing_acquisition", "created_acquisition"])(
    "denies continuity for %s without weakening exact-current matching", async fault => {
      const f = await fixture();
      const previous = await f.read(f.previous.id), current = await f.read(f.current.id);
      let before: Partial<typeof previous> = {}, after: Partial<typeof current> = {};
      if (["company", "environment", "workspace", "issue"].includes(fault)) {
        const other = await fixture();
        if (fault === "company") before.companyId = other.company.id;
        if (fault === "environment") before.environmentId = other.environment.id;
        if (fault === "workspace") before.executionWorkspaceId = other.workspace.id;
        if (fault === "issue") before.issueId = other.issue.id;
      }
      if (fault === "agent") before.metadata = { ...previous.metadata, agentId: randomUUID() };
      if (fault === "provider") before.provider = "different-provider";
      if (fault === "allocation") before.providerLeaseId = randomUUID();
      if (fault === "prior_active") before.status = "active";
      if (fault === "cleanup") before.cleanupStatus = "failed";
      if (fault === "policy") before.leasePolicy = "ephemeral";
      if (fault === "timestamp") before.releasedAt = new Date(current.acquiredAt.getTime() + 1);
      if (fault === "acquired") before.acquiredAt = new Date(current.acquiredAt.getTime() + 1);
      if (fault === "missing_incoming") { after.metadata = { ...current.metadata }; delete after.metadata.reusableLeasePredecessor; }
      if (fault === "missing_outgoing") { before.metadata = { ...previous.metadata }; delete before.metadata.reusableLeaseSuccessor; }
      if (fault === "altered_receipt" || fault === "malformed_id") after.metadata = { ...current.metadata,
        reusableLeasePredecessor: { ...(current.metadata!.reusableLeasePredecessor as object),
          ...(fault === "malformed_id" ? { previousLeaseId: "not-a-uuid" } : { handoffId: randomUUID() }) } };
      if (fault === "no_stop") { before.metadata = { ...previous.metadata }; delete before.metadata.remoteExecutionTermination; }
      if (fault === "destroyed" || fault === "wrong_stop") before.metadata = { ...previous.metadata,
        remoteExecutionTermination: { ...(previous.metadata!.remoteExecutionTermination as object),
          ...(fault === "destroyed" ? { state: "destroyed" } : { runId: randomUUID() }) } };
      if (fault.startsWith("stop_") && fault.endsWith("time")) {
        const stop = { ...(previous.metadata!.remoteExecutionTermination as Record<string, unknown>) };
        if (fault === "stop_missing_time") delete stop.confirmedAt;
        if (fault === "stop_invalid_time") stop.confirmedAt = "not-a-date";
        if (fault === "stop_future_time") stop.confirmedAt = new Date(current.acquiredAt.getTime() + 1).toISOString();
        if (fault === "stop_early_time") stop.confirmedAt = new Date(previous.acquiredAt.getTime() - 1).toISOString();
        before.metadata = { ...previous.metadata, remoteExecutionTermination: stop };
      }
      if (fault === "prior_run_active") await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.firstRun.id));
      if (fault === "prior_run_agent") {
        const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "Other", adapterType: "opencode_local" }).returning();
        await db.update(heartbeatRuns).set({ agentId: other.id }).where(eq(heartbeatRuns.id, f.firstRun.id));
      }
      if (fault === "current_inactive") after.status = "released";
      if (fault === "current_policy") after.leasePolicy = "ephemeral";
      if (fault === "current_successor") after.metadata = { ...current.metadata, reusableLeaseSuccessor: {} };
      if (fault === "current_run_idle") await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.secondRun.id));
      if (fault === "current_run_company") {
        const other = await fixture();
        await db.update(heartbeatRuns).set({ companyId: other.company.id }).where(eq(heartbeatRuns.id, f.secondRun.id));
      }
      if (fault === "current_run_agent") {
        const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "Other", adapterType: "opencode_local" }).returning();
        await db.update(heartbeatRuns).set({ agentId: other.id }).where(eq(heartbeatRuns.id, f.secondRun.id));
      }
      if (fault === "current_run_issue") {
        const [other] = await db.insert(issues).values({ companyId: f.company.id, title: "Other" }).returning();
        // Run task bindings are immutable in PostgreSQL; corrupt the lease side
        // to exercise the resolver's independent current-run binding check.
        after.issueId = other.id;
      }
      if (fault === "missing_acquisition") { after.metadata = { ...current.metadata }; delete after.metadata.sandboxLeaseAcquisition; }
      if (fault === "created_acquisition") after.metadata = { ...current.metadata, sandboxLeaseAcquisition: { outcome: "created" } };
      if (fault === "replacement" || fault === "acquisition_allocation") after.metadata = { ...current.metadata,
        sandboxLeaseAcquisition: { outcome: fault === "replacement" ? "replacement" : "resumed",
          providerLeaseId: fault === "replacement" ? current.providerLeaseId : randomUUID() } };
      if (Object.keys(before).length) await db.update(environmentLeases).set(before).where(eq(environmentLeases.id, previous.id));
      if (Object.keys(after).length) await db.update(environmentLeases).set(after).where(eq(environmentLeases.id, current.id));
      // Deliberately pass the stale original lease: the resolver must use DB truth.
      const target = await f.resolve();
      expect(adapterExecutionTargetSessionMatches(f.identity(previous.id), target)).toBe(false);
      expect(adapterExecutionTargetSessionMatches(f.identity(current.id), target)).toBe(true);
    });

  it("cannot manufacture or replace authority through provider metadata", async () => {
    const f = await fixture();
    const forged = { schema: "paperclip.reusable-lease-handoff.v1", previousLeaseId: f.previous.id };
    const updated = await f.svc.updateLeaseMetadata(f.current.id, { ...f.current.metadata, reusableLeasePredecessor: forged });
    expect(updated!.metadata!.reusableLeasePredecessor).toEqual(f.current.metadata!.reusableLeasePredecessor);
    const fresh = await f.svc.acquireLease({ ...f.values, providerLeaseId: randomUUID(), heartbeatRunId: f.secondRun.id,
      metadata: { ...f.values.metadata, reusableLeasePredecessor: forged } });
    expect(fresh.metadata?.reusableLeasePredecessor).toBeUndefined();
    expect(adapterExecutionTargetSessionMatches(f.identity(f.previous.id), await f.resolve(fresh))).toBe(false);
  });

  it("grants no extra match with reusable leases disabled", async () => {
    const f = await fixture();
    expect(adapterExecutionTargetSessionMatches(f.identity(f.previous.id), await f.resolve(f.current, false))).toBe(false);
  });

  it.each([false, true])("composes Core handoff verification, persisted OpenCode session state and the real adapter invocation (receipt=%s)", async hasReceipt => {
    const f = await fixture();
    const codec = getAdapterSessionCodec("opencode_local");
    const sessionId = "ses_persisted";
    const context = {
      paperclipIssue: { id: f.issue.id },
      paperclipTaskMarkdownAssignment: "gh-sweep read-only full plan; no product effects.",
      paperclipTaskMarkdownAssignmentUnchanged: "Current policy; unchanged plan revision available on demand.",
      paperclipWake: { reason: "issue_commented", issue: { id: f.issue.id, status: "in_progress", workMode: "standard" } },
    };
    const delivery = createPaperclipAssignmentReceipt(context, { companyId: f.company.id, agentId: f.agent.id, sessionId });
    const first = resolveNextSessionState({ adapterType: "opencode_local", codec, outcome: "succeeded",
      adapterResult: { exitCode: 0, signal: null, timedOut: false, sessionId, sessionParams: {
        sessionId, cwd: "/workspace/project", remoteExecution: f.identity(f.previous.id),
        ...(hasReceipt ? { paperclipAssignmentReceipt: delivery } : {}),
      } }, previousParams: null, previousDisplayId: null, previousLegacySessionId: null });
    const [stored] = await db.insert(agentTaskSessions).values({ companyId: f.company.id, agentId: f.agent.id,
      adapterType: "opencode_local", taskKey: f.issue.id, sessionParamsJson: first.params,
      sessionDisplayId: first.displayId, lastRunId: f.firstRun.id }).returning();
    const [loaded] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, stored.id));
    const params = codec.deserialize(loaded.sessionParamsJson);
    expect(params?.remoteExecution).toEqual(f.identity(f.previous.id));
    expect(params?.paperclipAssignmentReceipt).toEqual(hasReceipt ? delivery : undefined);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-session-invocation-"));
    vi.stubEnv("XDG_CONFIG_HOME", root);
    const processMock = vi.mocked(runAdapterExecutionTargetProcess);
    processMock.mockReset().mockResolvedValue({ exitCode: 0, signal: null, timedOut: false,
      stdout: JSON.stringify({ type: "text", sessionID: sessionId, part: { text: "Done" } }),
      stderr: "", pid: null, startedAt: new Date().toISOString() } as never);
    try {
      let prompt = "";
      const result = await execute({ runId: f.secondRun.id, agent: f.agent,
        runtime: { sessionId, sessionParams: params, sessionDisplayId: sessionId, taskKey: f.issue.id },
        executionTarget: await f.resolve(), config: { cwd: root, command: "opencode", model: "openai/test",
          env: { OPENCODE_ALLOW_ALL_MODELS: "1" } }, context, onLog: async () => {},
          onMeta: async meta => { prompt = String(meta.prompt ?? ""); } });
      const args = processMock.mock.calls[0][3];
      expect(args[args.indexOf("--session") + 1]).toBe(sessionId);
      expect(result.sessionId).toBe(sessionId);
      expect(prompt).toContain(hasReceipt ? context.paperclipTaskMarkdownAssignmentUnchanged : context.paperclipTaskMarkdownAssignment);
      if (hasReceipt) expect(prompt).not.toContain(context.paperclipTaskMarkdownAssignment);
      const next = resolveNextSessionState({ adapterType: "opencode_local", codec, outcome: "succeeded",
        adapterResult: result, previousParams: params, previousDisplayId: first.displayId, previousLegacySessionId: first.legacySessionId });
      expect(codec.deserialize(next.params)?.remoteExecution).toEqual(f.identity(f.current.id));
      expect(codec.deserialize(next.params)?.paperclipAssignmentReceipt).toEqual(delivery);
    } finally { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
