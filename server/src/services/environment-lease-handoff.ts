import { randomUUID } from "node:crypto";
import type { environmentLeases } from "@paperclipai/db";

type Lease = typeof environmentLeases.$inferSelect;
type Binding = Pick<Lease, "id" | "companyId" | "environmentId" | "executionWorkspaceId" | "issueId" |
  "heartbeatRunId" | "provider" | "providerLeaseId" | "metadata" | "acquiredAt">;
const outgoingKey = "reusableLeaseSuccessor";
const incomingKey = "reusableLeasePredecessor";

export function withoutReusableLeaseHandoff(metadata: Record<string, unknown> | null | undefined) {
  if (metadata == null) return null;
  const result = { ...metadata };
  delete result[outgoingKey];
  delete result[incomingKey];
  return result;
}

export function preserveReusableLeaseHandoff(previous: Record<string, unknown> | null,
  metadata: Record<string, unknown> | null | undefined) {
  const result = withoutReusableLeaseHandoff(metadata);
  const proof = Object.fromEntries([outgoingKey, incomingKey]
    .filter(key => Object.hasOwn(previous ?? {}, key)).map(key => [key, previous![key]]));
  return Object.keys(proof).length ? { ...result, ...proof } : result;
}

function handoffBinding(previous: Binding, current: Binding) {
  return { schema: "paperclip.reusable-lease-handoff.v1",
    previousLeaseId: previous.id, successorLeaseId: current.id,
    previousRunId: previous.heartbeatRunId, successorRunId: current.heartbeatRunId,
    companyId: current.companyId, environmentId: current.environmentId,
    workspaceId: current.executionWorkspaceId, issueId: current.issueId,
    agentId: current.metadata?.agentId ?? null, provider: current.provider,
    providerLeaseId: current.providerLeaseId, recordedAt: current.acquiredAt.toISOString() };
}

export function createReusableLeaseHandoff(previous: Binding, current: Binding) {
  return { ...handoffBinding(previous, current), handoffId: randomUUID() };
}

/** A single reciprocal Core-issued edge, independent of earlier handoffs. */
export function isReusableLeaseHandoff(previous: Lease, successor: Lease): boolean {
  const raw = successor.metadata?.[incomingKey];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const receipt = raw as Record<string, unknown>;
  if (receipt.previousLeaseId !== previous.id || previous.status !== "expired" || previous.cleanupStatus !== "success" ||
      previous.leasePolicy !== "reuse_by_environment" || !previous.heartbeatRunId ||
      !successor.heartbeatRunId || previous.heartbeatRunId === successor.heartbeatRunId ||
      typeof receipt.handoffId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.handoffId)) return false;
  const expected = { ...handoffBinding(previous, successor), handoffId: receipt.handoffId };
  const outgoing = previous.metadata?.[outgoingKey];
  return Boolean(outgoing && typeof outgoing === "object" && !Array.isArray(outgoing) &&
    Object.keys(receipt).length === Object.keys(expected).length &&
    Object.keys(outgoing).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => receipt[key] === value &&
      (outgoing as Record<string, unknown>)[key] === value) &&
    previous.environmentId && previous.issueId && typeof previous.metadata?.agentId === "string" &&
    previous.companyId === successor.companyId && previous.environmentId === successor.environmentId &&
    previous.executionWorkspaceId === successor.executionWorkspaceId && previous.issueId === successor.issueId &&
    previous.metadata.agentId === successor.metadata?.agentId && previous.provider === successor.provider &&
    previous.providerLeaseId === successor.providerLeaseId &&
    previous.releasedAt?.getTime() === successor.acquiredAt.getTime() &&
    previous.acquiredAt.getTime() <= successor.acquiredAt.getTime());
}

export function retiredReusableLeasePredecessors(current: Lease, history: Lease[]): Lease[] | null {
  if (Object.hasOwn(current.metadata ?? {}, outgoingKey)) return null;
  const remaining = new Map(history.map(lease => [lease.id, lease]));
  if (remaining.size !== history.length) return null;
  const result: Lease[] = [];
  let successor = current;
  while (remaining.size) {
    const raw = successor.metadata?.[incomingKey];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const receipt = raw as Record<string, unknown>;
    const previous = remaining.get(String(receipt.previousLeaseId));
    if (!previous || !isReusableLeaseHandoff(previous, successor) ||
        previous.companyId !== current.companyId || previous.environmentId !== current.environmentId ||
        previous.executionWorkspaceId !== current.executionWorkspaceId || previous.issueId !== current.issueId ||
        previous.metadata?.agentId !== current.metadata?.agentId ||
        previous.provider !== current.provider || previous.providerLeaseId !== current.providerLeaseId) return null;
    result.push(previous);
    remaining.delete(previous.id);
    successor = previous;
  }
  return Object.hasOwn(successor.metadata ?? {}, incomingKey) ? null : result;
}
