import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const mocks = vi.hoisted(() => ({ process: vi.fn(), restore: vi.fn(), stop: vi.fn(), bridgeStop: vi.fn() }));
vi.mock("@paperclipai/adapter-utils/execution-target", async original => ({
  ...await original<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  ensureAdapterExecutionTargetCommandResolvable: async () => {},
  ensureAdapterExecutionTargetRuntimeCommandInstalled: async () => {},
  prepareAdapterExecutionTargetRuntime: async () => ({
    workspaceRemoteDir: "/workspace/project", runtimeRootDir: "/workspace/.runtime", assetDirs: {},
    restoreWorkspace: mocks.restore,
  }),
  startAdapterExecutionTargetPaperclipBridge: async () => ({ env: {}, stop: mocks.bridgeStop }),
  runAdapterExecutionTargetProcess: mocks.process,
}));

import { execute } from "../../../packages/adapters/opencode-local/src/server/execute.js";

describe("OpenCode workspace restore settlement", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.resetAllMocks();
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function fixture(timedOut = false, confirmedStop = true) {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-opencode-restore-"));
    dirs.push(dir);
    const stdout = [
      { type: "step_start", sessionID: "ses_saved" },
      { type: "text", part: { type: "text", text: "Saved audit evidence." } },
      { type: "step_finish", part: { cost: 0.004, tokens: { input: 20, output: 10, cache: { read: 100 } } } },
    ].map(event => JSON.stringify(event)).join("\n") + "\n";
    mocks.process.mockImplementation(async (_run, _target, _command, _args, options) => {
      await options.onLog("stdout", stdout);
      if (confirmedStop) await options.onProcessStopped();
      return { exitCode: timedOut ? null : 0, signal: timedOut ? "SIGKILL" : null, timedOut, stdout, stderr: "", pid: null };
    });
    mocks.restore.mockResolvedValue(undefined);
    mocks.stop.mockResolvedValue(undefined);
    mocks.bridgeStop.mockResolvedValue(undefined);
    const onUsage = vi.fn();
    const context: AdapterExecutionContext = {
      runId: "restore-run", agent: { id: "agent", companyId: "company", name: "Worker", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "opencode", cwd: dir, model: "openai/test", paperclipRuntimeSkills: [],
        env: { XDG_CONFIG_HOME: dir, OPENAI_API_KEY: "fixture-only", OPENCODE_ALLOW_ALL_MODELS: "1" } },
      executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace/project",
        runner: { execute: async () => { throw new Error("unexpected remote command"); } } },
      context: {}, onLog: async () => {}, onUsage, onProviderStopped: mocks.stop,
    };
    return { context, onUsage };
  }

  it("retains the timeout, signal and observed cost when stopped-sandbox export fails", async () => {
    const { context, onUsage } = await fixture(true);
    mocks.restore.mockImplementation(async () => {
      expect(mocks.stop).toHaveBeenCalledTimes(1);
      throw new Error("Lease is not running; private restore output");
    });
    const result = await execute(context);
    expect(result).toMatchObject({
      errorCode: "workspace_restore_failed", timedOut: false, signal: "SIGKILL", usageComplete: false,
      usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 100 }, costUsd: 0.004,
      resultJson: { workspaceRestoreFailure: "restore_failed", finalResponseRecorded: false,
        executionBeforeRestore: { timedOut: true, signal: "SIGKILL", exitCode: null } },
    });
    expect(result.errorMessage).toContain("OpenCode execution timed out");
    expect(result.errorMessage).toContain("Workspace restore failed");
    expect(JSON.stringify(result)).not.toContain("private restore output");
    expect(onUsage.mock.calls.at(-1)?.[0]).toMatchObject({ costUsd: 0.004, complete: false });
    expect(mocks.process).toHaveBeenCalledTimes(1);
    expect(mocks.restore).toHaveBeenCalledTimes(1);
  });

  it("preserves the successful turn and session but does not claim delivery after failed export", async () => {
    const { context } = await fixture();
    mocks.restore.mockRejectedValue(new Error("private host path"));
    const result = await execute(context);
    expect(result).toMatchObject({ errorCode: "workspace_restore_failed", sessionId: "ses_saved", costUsd: 0.004,
      summary: "Saved audit evidence.", resultJson: { finalResponseRecorded: true,
        executionBeforeRestore: { timedOut: false, exitCode: 0 } } });
    expect(JSON.stringify(result)).not.toContain("private host path");
  });

  it.each([false, true])("keeps clean restore behavior (timeout=%s)", async timedOut => {
    const { context } = await fixture(timedOut);
    const result = await execute(context);
    expect(result.timedOut).toBe(timedOut);
    expect(result.errorCode).toBeFalsy();
    expect(result.resultJson?.workspaceRestoreFailure).toBeUndefined();
    expect(mocks.restore).toHaveBeenCalledTimes(1);
  });

  it("keeps unknown execution/stop state unknown when restoration also fails", async () => {
    const { context } = await fixture(false, false);
    mocks.process.mockRejectedValue(new Error("Transport lost; allocation state unknown; do not retry writes"));
    mocks.restore.mockRejectedValue(new Error("private export error"));
    const result = await execute(context);
    expect(result).toMatchObject({ errorCode: "workspace_restore_failed",
      resultJson: { finalResponseRecorded: false, executionBeforeRestore: { timedOut: false, errorCode: "adapter_failed" } } });
    expect(result.errorMessage).toContain("state unknown; do not retry writes");
    expect(result.usageComplete).not.toBe(true);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.process).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private export error");
  });

  it.each([false, true])("does not replace execution evidence with failed post-stop collection (timeout=%s)", async timedOut => {
    const { context } = await fixture(timedOut);
    mocks.stop.mockRejectedValue(new Error("private instruction failure"));
    const result = await execute(context);
    expect(result.timedOut).toBe(timedOut);
    expect(result.errorCode).toBe(timedOut ? undefined : "instruction_collection_failed");
    expect(result.resultJson?.instructionCollectionFailure).toBe("collection_failed");
    expect(result.costUsd).toBe(0.004);
    expect(mocks.restore).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private instruction failure");
  });

  it("preserves settled timeout and accounting evidence when bridge cleanup also rejects", async () => {
    const { context } = await fixture(true);
    const onLog = vi.fn(async () => {});
    context.onLog = onLog;
    mocks.restore.mockRejectedValue(new Error("private export error"));
    mocks.bridgeStop.mockRejectedValue(new Error("private bridge cleanup error"));
    const result = await execute(context);
    expect(result).toMatchObject({ errorCode: "workspace_restore_failed", costUsd: 0.004, usageComplete: false,
      resultJson: { executionBeforeRestore: { timedOut: true, signal: "SIGKILL" } } });
    expect(onLog).toHaveBeenCalledWith("stderr", "[paperclip] OpenCode bridge cleanup unconfirmed; execution outcome preserved.\n");
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("private bridge cleanup error");
    expect(mocks.process).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it("preserves the original unknown-stop exception even when bridge cleanup and warning logging fail", async () => {
    const { context } = await fixture(false, false);
    const error = new Error("Transport lost; allocation state unknown; do not retry writes");
    mocks.process.mockRejectedValue(error);
    mocks.bridgeStop.mockRejectedValue(new Error("private bridge cleanup error"));
    context.onLog = async stream => { if (stream === "stderr") throw new Error("log unavailable"); };
    await expect(execute(context)).rejects.toBe(error);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.process).toHaveBeenCalledTimes(1);
    expect(mocks.bridgeStop).toHaveBeenCalledTimes(1);
  });
});
