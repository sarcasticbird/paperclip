import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

import { adapterSandboxSessionContinuation, runAdapterExecutionTargetProcess, type AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { execute } from "./execute.js";

describe("OpenCode sandbox session invocation across a Core-verified handoff", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each([false, true])("passes --session only with host-verified continuity (grant=%s)", async grant => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-session-invocation-"));
    vi.stubEnv("XDG_CONFIG_HOME", root);
    const sessionId = "ses_previous";
    const processMock = vi.mocked(runAdapterExecutionTargetProcess);
    processMock.mockReset().mockResolvedValue({ exitCode: 0, signal: null, timedOut: false,
      stdout: JSON.stringify({ type: "text", sessionID: grant ? sessionId : "ses_fresh", part: { text: "Done" } }),
      stderr: "", pid: null, startedAt: new Date().toISOString() } as never);
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote", transport: "sandbox", providerKey: "test-provider", environmentId: "environment",
      leaseId: "current", remoteCwd: "/workspace/project",
      ...(grant ? adapterSandboxSessionContinuation("current", "previous") : {}),
      runner: { execute: async options => {
        // Exercise probes with the real remote path boundary, not host cwd.
        expect(options.cwd === "/" || options.cwd === "/workspace" || options.cwd?.startsWith("/workspace/")).toBe(true);
        return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: "" };
      } },
    };
    const logs: string[] = [];
    try {
      const result = await execute({
        runId: "second-run", agent: { id: "agent", companyId: "company", name: "Agent", adapterType: "opencode_local", adapterConfig: {} },
        // Previous-release saved shape: no new session field or migration.
        runtime: { sessionId, sessionDisplayId: sessionId, taskKey: "issue", sessionParams: {
          sessionId, cwd: "/workspace/project", remoteExecution: { transport: "sandbox", providerKey: "test-provider",
            environmentId: "environment", leaseId: "previous", remoteCwd: "/workspace/project" },
        } },
        executionTarget: target, config: { cwd: root, command: "opencode", model: "openai/test", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
        context: {}, onLog: async (_stream, chunk) => { logs.push(chunk); },
      });
      expect(processMock).toHaveBeenCalledOnce();
      const args = processMock.mock.calls[0][3];
      expect(args.includes("--session")).toBe(grant);
      if (grant) expect(args[args.indexOf("--session") + 1]).toBe(sessionId);
      expect(result.sessionId).toBe(grant ? sessionId : "ses_fresh");
      expect(result.sessionParams).toMatchObject({ remoteExecution: { leaseId: "current" } });
      expect(logs.join("").includes("does not match the current remote execution identity")).toBe(!grant);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
