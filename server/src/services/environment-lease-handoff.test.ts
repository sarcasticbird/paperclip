import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createReusableLeaseHandoff, isReusableLeaseHandoff, retiredReusableLeasePredecessors } from "./environment-lease-handoff.js";

type Lease = Parameters<typeof isReusableLeaseHandoff>[0];

function edge(sharedWorkspace: boolean, sameTask: boolean) {
  const time = new Date("2026-11-11T00:00:00.000Z");
  const previous: Lease = {
    id: randomUUID(), companyId: randomUUID(), environmentId: randomUUID(),
    executionWorkspaceId: sharedWorkspace ? randomUUID() : null, issueId: randomUUID(),
    heartbeatRunId: randomUUID(), provider: "test-sandbox", providerLeaseId: randomUUID(),
    metadata: { agentId: randomUUID() }, acquiredAt: new Date(time.getTime() - 1000), releasedAt: time,
    status: "expired", cleanupStatus: "success", leasePolicy: "reuse_by_environment",
    createdAt: time, updatedAt: time, lastUsedAt: time, expiresAt: null, failureReason: null,
  };
  const current = { ...previous, id: randomUUID(), heartbeatRunId: randomUUID(),
    issueId: sameTask ? previous.issueId : randomUUID(), metadata: { agentId: previous.metadata!.agentId },
    status: "active", acquiredAt: time, releasedAt: null } as Lease;
  const receipt = createReusableLeaseHandoff(previous, current);
  previous.metadata = { ...previous.metadata, reusableLeaseSuccessor: receipt };
  current.metadata = { ...current.metadata, reusableLeasePredecessor: receipt };
  return { previous, current };
}

describe("upstream warm handoff and adapter predecessor proof integration", () => {
  it.each([true, false])("keeps reciprocal same-task handoffs (shared workspace: %s)", shared => {
    const { previous, current } = edge(shared, true);
    expect(isReusableLeaseHandoff(previous, current)).toBe(true);
    expect(retiredReusableLeasePredecessors(current, [previous])).toEqual([previous]);
  });

  it("preserves upstream cross-task warm handoff only within the same bound workspace", () => {
    const { previous, current } = edge(true, false);
    expect(isReusableLeaseHandoff(previous, current)).toBe(true);
    expect(retiredReusableLeasePredecessors(current, [previous])).toEqual([previous]);
    // This edge is not authority to resume the prior task's adapter session:
    // environment-session-continuity independently checks both run task bindings.
  });

  it("refuses cross-task reuse without an execution workspace", () => {
    const { previous, current } = edge(false, false);
    expect(isReusableLeaseHandoff(previous, current)).toBe(false);
    expect(retiredReusableLeasePredecessors(current, [previous])).toBeNull();
  });

  it.each(["companyId", "environmentId", "executionWorkspaceId", "provider", "providerLeaseId"] as const)(
    "rejects cross-task handoff with changed %s", field => {
      const { previous, current } = edge(true, false);
      previous[field] = randomUUID();
      expect(isReusableLeaseHandoff(previous, current)).toBe(false);
      expect(retiredReusableLeasePredecessors(current, [previous])).toBeNull();
    },
  );

  it("requires reciprocal proof, successful cleanup and exact handoff time", () => {
    for (const fault of ["receipt", "cleanup", "time", "agent"] as const) {
      const { previous, current } = edge(true, false);
      if (fault === "receipt") delete previous.metadata!.reusableLeaseSuccessor;
      if (fault === "cleanup") previous.cleanupStatus = "failed";
      if (fault === "time") previous.releasedAt = new Date(current.acquiredAt.getTime() + 1);
      if (fault === "agent") previous.metadata = { ...previous.metadata, agentId: randomUUID() };
      expect(isReusableLeaseHandoff(previous, current)).toBe(false);
      expect(retiredReusableLeasePredecessors(current, [previous])).toBeNull();
    }
  });
});
