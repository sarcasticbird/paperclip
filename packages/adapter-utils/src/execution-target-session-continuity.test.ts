import { describe, expect, it } from "vitest";
import {
  adapterExecutionTargetSessionIdentity, adapterExecutionTargetSessionMatches,
  adapterSandboxSessionContinuation, overrideAdapterExecutionTargetRemoteCwd,
  readAdapterExecutionTarget, type AdapterSandboxExecutionTarget,
} from "./execution-target.js";

const target: AdapterSandboxExecutionTarget = {
  kind: "remote", transport: "sandbox", providerKey: "test-provider",
  environmentId: "environment", leaseId: "current", remoteCwd: "/workspace/project",
};
const saved = { ...adapterExecutionTargetSessionIdentity(target), leaseId: "previous" };

describe("host-verified sandbox session continuation", () => {
  it("accepts only the exact lease by default, or its Core-verified immediate predecessor", () => {
    expect(adapterExecutionTargetSessionMatches(saved, target)).toBe(false);
    const granted = { ...target, ...adapterSandboxSessionContinuation("current", "previous") };
    expect(adapterExecutionTargetSessionMatches(saved, granted)).toBe(true);
    expect(adapterExecutionTargetSessionMatches({ ...saved, leaseId: "older" }, granted)).toBe(false);
    expect(adapterExecutionTargetSessionMatches(adapterExecutionTargetSessionIdentity(target), target)).toBe(true);
    expect(adapterExecutionTargetSessionIdentity(granted)).toEqual(adapterExecutionTargetSessionIdentity(target));
  });

  it.each(["providerKey", "environmentId", "remoteCwd", "transport"])("retains the %s boundary", key => {
    const granted = { ...target, ...adapterSandboxSessionContinuation("current", "previous") };
    expect(adapterExecutionTargetSessionMatches({ ...saved, [key]: "other" }, granted)).toBe(false);
  });

  it("does not transfer a grant to another current lease or grant an empty saved identity", () => {
    const granted = { ...target, ...adapterSandboxSessionContinuation("current", "previous") };
    expect(adapterExecutionTargetSessionMatches(saved, { ...granted, leaseId: "another" })).toBe(false);
    expect(adapterExecutionTargetSessionMatches({ ...saved, leaseId: "" }, {
      ...target, ...adapterSandboxSessionContinuation("current", ""),
    })).toBe(false);
  });

  it("preserves host authority through cwd copies but loses it across JSON serialization", () => {
    const granted = { ...target, ...adapterSandboxSessionContinuation("current", "previous") };
    const copied = overrideAdapterExecutionTargetRemoteCwd(granted, "/workspace/project");
    expect(adapterExecutionTargetSessionMatches(saved, copied)).toBe(true);
    expect(adapterExecutionTargetSessionMatches(saved,
      overrideAdapterExecutionTargetRemoteCwd(granted, "/workspace/other"))).toBe(false);
    expect(adapterExecutionTargetSessionMatches({ ...saved, remoteCwd: "/workspace/other" },
      overrideAdapterExecutionTargetRemoteCwd(granted, "/workspace/other"))).toBe(true);
    const serialized = JSON.parse(JSON.stringify({ ...granted, sessionResumeLeaseId: "previous" }));
    expect(adapterExecutionTargetSessionMatches(saved,
      readAdapterExecutionTarget({ executionTarget: serialized }))).toBe(false);
  });

  it("keeps local and SSH matching unchanged", () => {
    expect(adapterExecutionTargetSessionMatches({}, { kind: "local" })).toBe(true);
    expect(adapterExecutionTargetSessionMatches(saved, { kind: "local" })).toBe(false);
    const ssh = { kind: "remote" as const, transport: "ssh" as const, remoteCwd: "/workspace/project",
      spec: { host: "host.example", port: 22, username: "guest", remoteCwd: "/workspace/project",
        remoteWorkspacePath: "/workspace/project", privateKey: null, knownHosts: null, strictHostKeyChecking: true } };
    const identity = adapterExecutionTargetSessionIdentity(ssh);
    expect(adapterExecutionTargetSessionMatches(identity, ssh)).toBe(true);
    expect(adapterExecutionTargetSessionMatches({ ...identity, host: "other.example" }, ssh)).toBe(false);
  });
});
