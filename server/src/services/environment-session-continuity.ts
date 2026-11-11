import { and, eq } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { isReusableLeaseHandoff } from "./environment-lease-handoff.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Authorize only the immediate predecessor of this active sandbox lease.
 * Two indexed reads per real handoff; no retained-history scan or idle work.
 * Provider metadata is only a hint to read: authority comes from reciprocal
 * Core-owned rows plus a separate, exact stopped receipt and run bindings. */
export async function resolveSandboxSessionPredecessor(db: Db, input: {
  companyId: string; environmentId: string; provider: string; leaseId: string;
  lease: Pick<EnvironmentLease, "id" | "companyId" | "environmentId" | "heartbeatRunId" | "provider" | "providerLeaseId">;
}): Promise<string | null> {
  const expected = input.lease;
  if (!uuid.test(input.leaseId) || expected.id !== input.leaseId ||
      expected.companyId !== input.companyId || expected.environmentId !== input.environmentId ||
      expected.provider !== input.provider || !expected.providerLeaseId) return null;
  const read = async (id: string) => (await db.select({ lease: environmentLeases, run: heartbeatRuns })
    .from(environmentLeases).innerJoin(heartbeatRuns, eq(heartbeatRuns.id, environmentLeases.heartbeatRunId))
    .where(and(eq(environmentLeases.id, id), eq(environmentLeases.companyId, input.companyId))).limit(1))[0];
  const active = await read(input.leaseId);
  if (!active) return null;
  const { lease: current, run } = active;
  const acquisition = current.metadata?.sandboxLeaseAcquisition as Record<string, unknown> | undefined;
  if (current.environmentId !== input.environmentId || current.provider !== input.provider ||
      current.providerLeaseId !== expected.providerLeaseId || current.heartbeatRunId !== expected.heartbeatRunId ||
      current.status !== "active" || current.leasePolicy !== "reuse_by_environment" || current.releasedAt ||
      acquisition?.outcome !== "resumed" ||
      (acquisition.providerLeaseId !== undefined && acquisition.providerLeaseId !== current.providerLeaseId) ||
      Object.hasOwn(current.metadata ?? {}, "reusableLeaseSuccessor") ||
      run.companyId !== current.companyId || run.issueId !== current.issueId || run.agentId !== current.metadata?.agentId ||
      run.status !== "running") return null;
  const proof = current.metadata?.reusableLeasePredecessor as Record<string, unknown> | undefined;
  const previousId = proof?.previousLeaseId;
  if (typeof previousId !== "string" || !uuid.test(previousId) || previousId === current.id) return null;
  const prior = await read(previousId);
  const stop = prior?.lease.metadata?.remoteExecutionTermination as Record<string, unknown> | undefined;
  const confirmedAt = typeof stop?.confirmedAt === "string" ? Date.parse(stop.confirmedAt) : NaN;
  // A shared workspace may change tasks for upstream warm recovery. That is
  // not authority to continue another task's saved adapter conversation.
  if (!prior || prior.lease.issueId !== current.issueId || !isReusableLeaseHandoff(prior.lease, current) ||
      prior.run.companyId !== current.companyId || prior.run.issueId !== current.issueId ||
      prior.run.agentId !== run.agentId || !prior.run.finishedAt ||
      !["succeeded", "failed", "timed_out", "cancelled", "interrupted"].includes(prior.run.status) ||
      !hasRemoteTerminationReceipt(prior.lease) ||
      stop?.state !== "stopped" || !Number.isFinite(confirmedAt) ||
      new Date(confirmedAt).toISOString() !== stop.confirmedAt ||
      confirmedAt < prior.lease.acquiredAt.getTime() || confirmedAt > current.acquiredAt.getTime()) return null;
  return prior.lease.id;
}
