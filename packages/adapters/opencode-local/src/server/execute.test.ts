import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

import { ensureRemoteOpenCodeModelConfiguredAndAvailable, execute } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import { createPaperclipAssignmentReceipt } from "@paperclipai/adapter-utils/server-utils";
import { sessionCodec } from "./index.js";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);

async function createSkillDir(root: string, name: string): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
  return skillDir;
}

function probeResult(overrides: Record<string, unknown>) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

describe("OpenCode local skill injection", () => {
  let configHome: string;

  beforeEach(async () => {
    configHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-config-"));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(configHome, { recursive: true, force: true });
  });

  it.each(["complete", "missing", "ready-only"].flatMap(mode => [false, true].map(streamed => ({ mode, streamed }))))(
    "merges attempt-scoped V2 compaction receipts and preserves incomplete accounting ($mode, streamed=$streamed)", async ({ mode, streamed }) => {
    const missing = mode !== "complete";
    const commandPath = path.join(configHome, "fake-opencode-compaction");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const checkpoints: Array<{ costUsd?: number | null; costStatus?: string; complete?: boolean }> = [];
    runProcessMock.mockReset().mockImplementation(async (_run, _target, command, _args, options) => {
      if (command !== "node") {
        const stdout = JSON.stringify({ type: "step_finish", sessionID: "session-usage",
          part: { cost: 0.121055, tokens: { input: 43304, output: 860, cache: { read: 42025 } } } }) + "\n";
        if (streamed) await options.onLog("stdout", stdout);
        options.onProcessStopped?.();
        return probeResult({ stdout });
      }
      const captureId = options.env!.PAPERCLIP_OPENCODE_COMPACTION_ID;
      const rows = [{ version: 1, captureId, type: "ready", runtime: "2.2.5" },
        { version: 1, captureId, type: "started", sessionId: "session-usage" },
        { version: 1, captureId, type: "completed", sessionId: "session-usage", aggregateId: "session-usage",
          eventId: "evt-1", sequence: 22, model: { providerID: "openai", id: "gpt-6.1-sol" }, cost: 0.0414047,
          tokens: { input: 3, output: 925, cache: { read: 24962, write: 11861 } } },
        { version: 1, captureId, type: "finalized", runtime: "2.2.5", records: 3 }];
      return probeResult({ stdout: mode === "missing" ? "" : (mode === "ready-only" ? rows.slice(0, 1) : rows)
        .map(r => JSON.stringify(r) + "\n").join("") });
    });
    const result = await execute({ runId: "run-compaction", agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: configHome, model: "openai/gpt-6.1-sol", captureOpenCodeV2CompactionUsage: true,
        extraArgs: ["--", "--standalone"],
        env: { OPENCODE_ALLOW_ALL_MODELS: "1" } }, context: {}, onLog: async () => {},
      onUsage: async checkpoint => { checkpoints.push(checkpoint); } });
    if (missing) {
      expect(result.costUsd).toBeNull();
      expect(result.errorMessage).toContain("opencode_compaction_accounting_incomplete");
      expect(result.usageComplete).toBe(false);
      expect(result.costStatus).toBe("unpriced");
      expect(result.exitCode).toBe(1);
      expect(checkpoints.at(-1)).toMatchObject({ costUsd: null, costStatus: "unpriced", complete: false });
    } else {
      expect(result.costUsd).toBeCloseTo(0.1624597, 9);
      expect(result.usage).toEqual({ inputTokens: 55168, cachedInputTokens: 66987, outputTokens: 1785 });
      expect(checkpoints.at(-1)?.costUsd).toBeCloseTo(0.1624597, 9);
      expect(checkpoints.at(-1)?.complete).toBe(true);
    }
    expect(runProcessMock.mock.calls[0]![3]).toContain("--standalone");
    const args = runProcessMock.mock.calls[0]![3];
    expect(args.indexOf("--standalone")).toBeLessThan(args.indexOf("--"));
    expect(runProcessMock).toHaveBeenCalledTimes(2);
  });

  it("rejects external-server capture before invoking an unowned runtime", async () => {
    const commandPath = path.join(configHome, "fake-opencode-external");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    await expect(execute({ runId: "run-external", agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: configHome, model: "openai/gpt-6.1-sol", captureOpenCodeV2CompactionUsage: true,
        extraArgs: ["--server=http://unowned.invalid"], env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: {}, onLog: async () => {} })).rejects.toThrow("opencode_compaction_capture_external_server_unsupported");
    expect(runProcessMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "successful output mentions unknown session", stopped: true, primary: {} },
    { name: "timeout", stopped: true, primary: { timedOut: true } },
    { name: "signal", stopped: true, primary: { signal: "SIGTERM" } },
    { name: "unknown stop", stopped: false, primary: { errorCode: "duplex_channel_lost" } },
    { name: "missing stop receipt", stopped: false, primary: {} },
  ])("does not replay or read after an unsafe accounting boundary: $name", async ({ stopped, primary }) => {
    const commandPath = path.join(configHome, "fake-opencode-safe-boundary");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const checkpoints: Array<{ complete?: boolean; costStatus?: string }> = [];
    runProcessMock.mockReset().mockImplementation(async (_run, _target, command, _args, options) => {
      if (command === "node") return probeResult({ stdout: "" });
      const stdout = [
        { type: "text", sessionID: "previous", part: { text: "Turn completed; documentation mentions unknown session." } },
        { type: "step_finish", sessionID: "previous", part: { cost: 0.1, tokens: { input: 5, output: 1 } } },
      ].map(value => JSON.stringify(value) + "\n").join("");
      await options.onLog("stdout", stdout);
      if (stopped) options.onProcessStopped?.();
      return probeResult({ stdout, ...primary });
    });
    const result = await execute({ runId: "run-safe-boundary",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: "previous", sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: configHome, model: "openai/gpt-6.1-sol",
        captureOpenCodeV2CompactionUsage: true, env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: {}, onLog: async () => {}, onUsage: async receipt => { checkpoints.push(receipt); } });
    const calls = runProcessMock.mock.calls;
    expect(calls.filter(call => call[2] !== "node")).toHaveLength(1);
    const safeRead = stopped && !Object.keys(primary).length;
    expect(calls.filter(call => call[2] === "node")).toHaveLength(safeRead ? 1 : 0);
    expect(result.costUsd).toBeNull();
    expect(result.usageComplete).toBe(false);
    expect(result.costStatus).toBe("unpriced");
    expect(checkpoints.at(-1)).toMatchObject({ complete: false, costStatus: "unpriced" });
  });

  it.each(["truncated stream", "mixed errors", "executed tool", "unconfirmed stop"])(
    "does not treat ambiguous primary output as a safe missing-session retry (%s)", async kind => {
      const commandPath = path.join(configHome, "fake-opencode-retry-guard");
      await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const error = JSON.stringify({ type: "error", error: { message: "unknown session: previous" } }) + "\n";
      const tool = JSON.stringify({ type: "tool_use", part: { state: { status: "completed" } } }) + "\n";
      runProcessMock.mockReset().mockImplementation(async (_run, _target, _command, _args, options) => {
        const stdout = kind === "executed tool" ? tool + error : kind === "mixed errors"
          ? error + JSON.stringify({ type: "error", error: { message: "provider failed" } }) + "\n" : error;
        await options.onLog("stdout", kind === "truncated stream" ? tool + stdout : stdout);
        if (kind !== "unconfirmed stop") options.onProcessStopped?.();
        return probeResult({ stdout, exitCode: 1 });
      });
      await execute({ runId: "run-retry-guard",
        agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: "previous", sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: configHome, model: "openai/gpt-6.1-sol", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
        context: {}, onLog: async () => {} });
      expect(runProcessMock).toHaveBeenCalledTimes(1);
    });

  it.each([false, true])("keeps chat policy with a legacy OpenCode prompt (custom=%s)", async (custom) => {
    const commandPath = path.join(configHome, "fake-opencode");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValue(probeResult({ stdout: JSON.stringify({
      type: "text", sessionID: "chat-session", part: { text: "Reply" },
    }) }));
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    let prompt = "";
    const result = await execute({
      runId: "chat-run",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
        ...(custom ? { promptTemplate: "Custom agent instruction." } : {}),
      },
      context: {
        conversationMode: true,
        paperclipTaskMarkdown: directive,
        paperclipWake: {
          reason: "issue_commented", issue: { id: "chat-1", status: "in_progress", workMode: "planning" },
          interactionKind: "request_confirmation", interactionStatus: "accepted",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => { prompt = String(meta.prompt ?? ""); },
    });
    expect(result.exitCode).toBe(0);
    expect(prompt).toContain(directive);
    expect(prompt).toContain(custom ? "Custom agent instruction." : "You are agent agent-1");
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("Create child issues");
  });

  it("delivers assignment context on an ordinary task turn and rebuilds it after resume fallback", async () => {
    const commandPath = path.join(configHome, "fake-opencode-context");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const prompts: string[] = [];
    const context = { ...createPromptContextFixture(), paperclipTaskMarkdownAssignmentUnchanged: "## Compact assignment\nPlan revision: approved-revision-2" };
    const receipt = createPaperclipAssignmentReceipt(context, { companyId: "company-1", agentId: "agent-1", sessionId: "previous" });
    runProcessMock
      .mockReset()
      .mockImplementationOnce(async (_run, _target, _command, _args, options) => {
        options.onProcessStopped?.();
        return probeResult({ stdout: JSON.stringify({ type: "error", error: "unknown session" }) });
      })
      .mockResolvedValueOnce(probeResult({ stdout: JSON.stringify({ type: "text", sessionID: "fresh", part: { text: "done" } }) }));
    await execute({
      runId: "run-context-fallback",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: "previous", sessionParams: { paperclipAssignmentReceipt: receipt }, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context,
      onLog: async () => {},
      onMeta: async (meta) => { prompts.push(String(meta.prompt ?? "")); },
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("## Compact assignment");
    expect(prompts[1]).toContain("## Owned assignment");
    for (const prompt of prompts) expect(prompt).not.toContain("Execution contract:");
    expect(prompts[1]).toContain("You are agent agent-1 (OpenCode).");
    expect(prompts[1]).toContain("Connection tools:");
  });

  it("round-trips a delivered assignment and sends changed scope instead of replaying unchanged plans", async () => {
    const commandPath = path.join(configHome, "fake-opencode-resume");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const context = { ...createPromptContextFixture(),
      paperclipTaskMarkdownAssignmentUnchanged: "Current policy; approved plan revision-2 unchanged." };
    const config = { command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } };
    const agent = { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} };
    const prompts: string[] = [];
    const turn = async (params: Record<string, unknown> | null, mutateAfterSubmission = false) => {
      runProcessMock.mockReset().mockResolvedValue(probeResult({ stdout: JSON.stringify({ type: "text", sessionID: "native-resume", part: { text: "Done" } }) }));
      return execute({ runId: "resume-run", agent, config, context,
        runtime: { sessionId: params ? "native-resume" : null, sessionParams: params, sessionDisplayId: null, taskKey: "issue-1" },
        onLog: async () => {}, onMeta: async meta => {
          prompts.push(String(meta.prompt));
          if (mutateAfterSubmission) context.paperclipTaskMarkdownAssignment += "\nLate scope was not submitted.";
        } });
    };
    const first = await turn(null);
    const saved = sessionCodec.deserialize(sessionCodec.serialize(first.sessionParams ?? null));
    expect(saved?.paperclipAssignmentReceipt).toMatchObject({ version: 1, sessionId: "native-resume" });
    await turn(saved);
    expect(prompts[0]).toContain("## Owned assignment");
    expect(prompts[1]).toContain(context.paperclipTaskMarkdownAssignmentUnchanged);
    expect(prompts[1]).not.toContain("## Owned assignment");
    expect(prompts[1]).toContain("Change the final scope to the launch checklist.");
    context.paperclipTaskMarkdownAssignment += "\nNew scope; approved revision-3 must be delivered.";
    await turn(saved);
    expect(prompts[2]).toContain("New scope; approved revision-3 must be delivered.");
    const fourth = await turn(saved, true);
    expect(prompts[3]).not.toContain("Late scope was not submitted.");
    await turn(sessionCodec.deserialize(sessionCodec.serialize(fourth.sessionParams ?? null)));
    expect(prompts[4]).toContain("Late scope was not submitted.");
    expect(runProcessMock).toHaveBeenCalledOnce();
  });

  it("preserves old session parameters without manufacturing a receipt and drops foreign receipt identity", () => {
    const saved = { session_id: "old-session", workdir: "/workspace/project" };
    expect(sessionCodec.deserialize(sessionCodec.serialize(saved))).toEqual({ sessionId: "old-session", cwd: "/workspace/project" });
    const context = { ...createPromptContextFixture(), paperclipTaskMarkdownAssignmentUnchanged: "Unchanged plan." };
    const receipt = createPaperclipAssignmentReceipt(context, { companyId: "company-1", agentId: "agent-1", sessionId: "other-session" });
    expect(sessionCodec.deserialize({ sessionId: "old-session", paperclipAssignmentReceipt: receipt })?.paperclipAssignmentReceipt).toBeUndefined();
  });

  it.each(["failed", "signal", "transport", "parsed-error", "timeout", "substituted-session"])("does not publish a new assignment receipt for %s", async fault => {
    const commandPath = path.join(configHome, "fake-opencode-fault");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const context = { ...createPromptContextFixture(), paperclipTaskMarkdownAssignmentUnchanged: "Unchanged plan reference." };
    const overrides = fault === "failed" ? { exitCode: 1 } : fault === "signal" ? { signal: "SIGTERM" } :
      fault === "transport" ? { errorCode: "duplex_channel_lost" } : fault === "timeout" ? { timedOut: true } : {};
    runProcessMock.mockReset().mockResolvedValue(probeResult({ ...overrides, stdout: JSON.stringify(
      fault === "parsed-error" ? { type: "error", sessionID: "expected", error: "refused" } :
        { type: "text", sessionID: fault === "substituted-session" ? "substitute" : "expected", part: { text: "Done" } }) }));
    const result = await execute({ runId: "fault", agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      config: { command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context, runtime: { sessionId: "expected", sessionParams: { sessionId: "expected" }, sessionDisplayId: null, taskKey: "issue-1" }, onLog: async () => {} });
    expect(result.sessionParams?.paperclipAssignmentReceipt).toBeUndefined();
    expect(runProcessMock).toHaveBeenCalledOnce();
  });

  it("injects runtime skills into the configured child HOME", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-configured-home-"));
    const processHome = path.join(root, "process-home");
    const configuredHome = path.join(root, "configured-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const skillSource = await createSkillDir(path.join(root, "runtime-skills"), "paperclip");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = processHome;
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValueOnce(probeResult({
      stdout: JSON.stringify({
        type: "text",
        sessionID: "session-configured-home",
        part: { text: "done" },
      }),
    }));

    try {
      const result = await execute({
        runId: "run-configured-home",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5",
          env: {
            HOME: configuredHome,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          paperclipRuntimeSkills: [{
            key: "paperclipai/paperclip/paperclip",
            runtimeName: "paperclip",
            source: skillSource,
          }],
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const installedSkill = path.join(configuredHome, ".claude", "skills", "paperclip");
      expect((await fs.lstat(installedSkill)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(installedSkill)).toBe(await fs.realpath(skillSource));
      await expect(fs.lstat(path.join(processHome, ".claude", "skills", "paperclip"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("preserves API billing in streamed usage and final results without leaking keys (timedOut=%s)", async (timedOut) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-openrouter-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const apiKey = "openrouter-test-secret";
    const model = "openrouter/anthropic/claude-sonnet-4.5";
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);
    runProcessMock.mockReset();
    const usageLine = JSON.stringify({ type: "step_finish", sessionID: "session-openrouter",
      part: { cost: 0.0025, tokens: { input: 10, output: 2, cache: { read: 100, write: 0 } } } });
    runProcessMock.mockImplementationOnce(async (...args) => {
      await args[4].onLog("stdout", `${usageLine}\n`);
      return probeResult({ stdout: usageLine, timedOut, exitCode: timedOut ? 143 : 0, signal: timedOut ? "SIGTERM" : null });
    });
    const logs: string[] = [];
    const metadata: unknown[] = [];
    const onUsage = vi.fn();

    try {
      const result = await execute({
        runId: "run-openrouter",
        agent: {
          id: "agent-openrouter",
          companyId: "company-1",
          name: "OpenRouter Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model,
          env: {
            OPENROUTER_API_KEY: apiKey,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          promptTemplate: "Run the task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onUsage,
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
        onMeta: async (value) => {
          metadata.push(value);
        },
      });

      expect(result.exitCode).toBe(timedOut ? 143 : 0);
      expect(result.usageComplete).toBe(!timedOut);
      expect(result.model).toBe(model);
      expect(result.billingType).toBe("metered_api");
      expect(result.biller).toBe("openrouter");
      expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ billingType: "metered_api", biller: "openrouter", model, complete: false }));
      expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ billingType: "metered_api", biller: "openrouter", model, complete: !timedOut }));
      const executionCall = runProcessMock.mock.calls.at(-1)!;
      expect(executionCall[3]).toContain("--model");
      expect(executionCall[3]).toContain(model);
      expect((executionCall[4] as { env: Record<string, string> }).env.OPENROUTER_API_KEY).toBe(apiKey);
      expect(JSON.stringify({ logs, metadata, result })).not.toContain(apiKey);
      expect(JSON.stringify(metadata)).toContain('"OPENROUTER_API_KEY":"***REDACTED***"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable — probe is non-fatal when it cannot run", () => {
  const target = { kind: "remote", transport: "ssh" } as never;
  const base = {
    runId: "run-probe",
    executionTarget: target,
    command: "opencode",
    cwd: "/tmp",
    env: {} as Record<string, string>,
    timeoutSec: 30,
    graceSec: 5,
  };

  beforeEach(() => {
    runProcessMock.mockReset();
  });

  it("proceeds when the remote probe exits non-zero (e.g. a transient `Unexpected error`)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 1, stderr: "Unexpected error" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe times out", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ timedOut: true, exitCode: null }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe returns no models", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("still rejects when the probe succeeds but the configured model is absent (guard retained)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "openai/gpt-4.1\n" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).rejects.toThrow("Configured OpenCode model is unavailable on the remote execution target");
  });
});
