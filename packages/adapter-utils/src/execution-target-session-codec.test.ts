import { describe, expect, it } from "vitest";
import { withExecutionTargetSessionIdentity } from "./execution-target-session-codec.js";
import { adapterExecutionTargetSessionMatches } from "./execution-target.js";

// Representative legacy codec: provider-owned fields only, dropping runtime fields.
const codec = withExecutionTargetSessionIdentity({
  serialize: params => params?.sessionId ? { sessionId: params.sessionId } : null,
  deserialize: raw => raw && typeof raw === "object" && "sessionId" in raw ? { sessionId: raw.sessionId } : null,
  getDisplayId: params => String(params?.sessionId),
});

describe("shared execution identity survives provider session codecs", () => {
  it.each([
    { transport: "sandbox", providerKey: "provider", environmentId: "env", leaseId: "lease", remoteCwd: "/workspace" },
    { transport: "ssh", host: "host.example", port: 22, username: "guest", remoteCwd: "/workspace" },
  ])("round-trips $transport identity without credentials or arbitrary metadata", remoteExecution => {
    const params = { sessionId: "session", remoteExecution: { ...remoteExecution, privateKey: "do-not-persist", arbitrary: "discard" } };
    const persisted = codec.serialize(params);
    expect(persisted).toEqual({ sessionId: "session", remoteExecution });
    expect(codec.deserialize(JSON.parse(JSON.stringify(persisted)))).toEqual(persisted);
    expect(codec.getDisplayId!(persisted)).toBe("session");
  });

  it("does not fabricate missing previous-release identity or revive cleared sessions", () => {
    expect(codec.deserialize({ sessionId: "old" })).toEqual({ sessionId: "old" });
    expect(codec.serialize(null)).toBeNull();
    expect(codec.deserialize({ remoteExecution: { transport: "sandbox" } })).toBeNull();
  });

  it.each([null, [], "bad", { transport: "unknown" }])("keeps malformed remote state from matching local: %j", remoteExecution => {
    const decoded = codec.deserialize(codec.serialize({ sessionId: "session", remoteExecution }));
    expect(adapterExecutionTargetSessionMatches(decoded!.remoteExecution, { kind: "local" })).toBe(false);
  });
});
