import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { pack } from "tar-stream";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandManagedRuntimeClient } from "./command-managed-runtime.js";
import { exportSandboxWorkspaceSnapshot } from "./sandbox-managed-runtime.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(environment: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-snapshot-command-")); roots.push(root);
  const source = path.join(root, "source"), staging = path.join(root, "staging");
  await mkdir(source); await mkdir(path.join(source, ".paperclip-runtime"));
  await writeFile(path.join(source, "saved.txt"), "saved work\n");
  await writeFile(path.join(source, ".paperclip-runtime", "private.txt"), "must not export\n");
  const client = createCommandManagedRuntimeClient({ commandCwd: source, timeoutMs: 30_000, runner: {
    execute: input => new Promise((resolve, reject) => {
      const startedAt = new Date().toISOString();
      const child = execFile(input.command, input.args ?? [], { cwd: input.cwd,
        env: { ...process.env, ...environment, ...input.env }, timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ exitCode: error ? typeof error.code === "number" ? error.code : 1 : 0,
        signal: error?.signal ?? null, timedOut: error?.killed ?? false, stdout, stderr, pid: child.pid ?? null, startedAt }));
      child.stdin?.on("error", reject); child.stdin?.end(input.stdin ?? "");
    }),
  } });
  return { root, source, staging, client };
}

describe("snapshot preservation over the existing command-only transport", () => {
  it.each([40, 65, 129])("applies the 64 MiB archive budget in a POSIX shell to a %s MiB file", async mib => {
    const f = await fixture({ POSIXLY_CORRECT: "1" });
    const bytes = Buffer.alloc(mib * 1024 * 1024, 97);
    await writeFile(path.join(f.source, "large.bin"), bytes);
    const snapshot = exportSandboxWorkspaceSnapshot({ client: f.client, remoteDir: f.source,
      stagingDir: f.staging, operationId: "posix-size-boundary" });
    if (mib > 64) {
      await expect(snapshot).rejects.toMatchObject({ code: "WORKSPACE_SNAPSHOT_EXPORT_UNSUPPORTED" });
      expect(await readdir(f.staging)).toEqual([]);
    } else {
      await snapshot;
      expect((await readFile(path.join(f.staging, "large.bin"))).equals(bytes)).toBe(true);
    }
    expect((await readFile(path.join(f.source, "large.bin"))).equals(bytes)).toBe(true);
  }, 120_000);

  it.each([{ exitCode: 153, timedOut: false }, { exitCode: 153, timedOut: true }, { exitCode: 2, timedOut: false }])(
    "classifies producer failure without masking unrelated failures: %j", async failure => {
      const f = await fixture(), error = Object.assign(new Error("producer failed"), failure);
      vi.spyOn(f.client, "run").mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
      vi.spyOn(f.client, "remove").mockResolvedValue(undefined);
      const snapshot = exportSandboxWorkspaceSnapshot({ client: f.client, remoteDir: f.source,
        stagingDir: f.staging, operationId: "producer-failure" });
      if (failure.exitCode === 153 && !failure.timedOut)
        await expect(snapshot).rejects.toMatchObject({ code: "WORKSPACE_SNAPSHOT_EXPORT_UNSUPPORTED" });
      else await expect(snapshot).rejects.toBe(error);
      expect(await readdir(f.staging)).toEqual([]);
    });

  it("validates the entire untrusted archive before writing any host member", async () => {
    const f = await fixture(), archive = pack(), chunks: Buffer[] = [];
    const collected = (async () => { for await (const chunk of archive) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); })();
    archive.entry({ name: "good.txt" }, "must not be extracted");
    archive.entry({ name: "external", type: "symlink", linkname: "../outside.txt" }); archive.finalize();
    vi.spyOn(f.client, "run").mockResolvedValue({} as never);
    vi.spyOn(f.client, "remove").mockResolvedValue(undefined);
    vi.spyOn(f.client, "readFile").mockResolvedValue(await collected);
    await expect(exportSandboxWorkspaceSnapshot({ client: f.client, remoteDir: f.source,
      stagingDir: f.staging, operationId: "untrusted" })).rejects.toMatchObject({ code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" });
    expect(await readdir(f.staging)).toEqual([]);
  });
  it("exports committed and untracked bytes without native sync or a host overlay", async () => {
    const f = await fixture();
    await mkdir(path.join(f.source, ".git")); await writeFile(path.join(f.source, ".git", "HEAD"), "ref: refs/heads/work\n");
    await writeFile(path.join(f.root, "newer-host-work.txt"), "keep newer work\n");
    await exportSandboxWorkspaceSnapshot({ client: f.client, remoteDir: f.source, stagingDir: f.staging, operationId: "test" });
    expect(await readFile(path.join(f.staging, "saved.txt"), "utf8")).toBe("saved work\n");
    expect(await readFile(path.join(f.staging, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/work\n");
    await expect(readFile(path.join(f.staging, ".paperclip-runtime", "private.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(f.root, "newer-host-work.txt"), "utf8")).toBe("keep newer work\n");
  });

  it("keeps internal links but refuses external links instead of following them", async () => {
    const f = await fixture();
    await symlink("saved.txt", path.join(f.source, "internal"));
    await exportSandboxWorkspaceSnapshot({ client: f.client, remoteDir: f.source, stagingDir: f.staging, operationId: "internal" });
    expect(await readFile(path.join(f.staging, "internal"), "utf8")).toBe("saved work\n");
    await symlink("../outside.txt", path.join(f.source, "external"));
    await writeFile(path.join(f.root, "outside.txt"), "outside\n");
    await expect(exportSandboxWorkspaceSnapshot({ client: f.client, remoteDir: f.source,
      stagingDir: path.join(f.root, "unsafe-staging"), operationId: "external" }))
      .rejects.toMatchObject({ code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" });
    expect(await readFile(path.join(f.root, "outside.txt"), "utf8")).toBe("outside\n");
  });

  it("bounds command-only buffering and removes only its confirmed temporary directory", async () => {
    const f = await fixture();
    const remove = vi.spyOn(f.client, "remove");
    vi.spyOn(f.client, "readFile").mockImplementation(async (_file, options) => {
      options?.onProgress?.(0, 65 * 1024 * 1024);
      throw new Error("size limit did not stop the transfer");
    });
    await expect(exportSandboxWorkspaceSnapshot({ client: f.client, remoteDir: f.source,
      stagingDir: f.staging, operationId: "large" })).rejects.toMatchObject({ code: "WORKSPACE_SNAPSHOT_EXPORT_UNSUPPORTED" });
    expect(remove).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\/tmp\/paperclip-recovery-[0-9a-f-]+$/));
    expect(await readFile(path.join(f.source, "saved.txt"), "utf8")).toBe("saved work\n");
  });

  it("does not delete a remote path after an unconfirmed creation", async () => {
    const f = await fixture();
    const remove = vi.spyOn(f.client, "remove");
    vi.spyOn(f.client, "run").mockRejectedValue(new Error("creation reply lost"));
    await expect(exportSandboxWorkspaceSnapshot({ client: f.client, remoteDir: f.source,
      stagingDir: f.staging, operationId: "lost" })).rejects.toThrow("creation reply lost");
    expect(remove).not.toHaveBeenCalled();
  });

  it.runIf(process.env.PAPERCLIP_LIVE_APPLE_SNAPSHOT_TEST_IMAGE)(
    "qualifies sparse and unwritten file bytes in a fresh credential-free Apple guest", async () => {
      const image = process.env.PAPERCLIP_LIVE_APPLE_SNAPSHOT_TEST_IMAGE!;
      expect(image).toMatch(/^docker\.io\/library\/wrap-runtime@sha256:[a-f0-9]{64}$/);
      const cli = "/opt/homebrew/bin/container", token = randomUUID(), id = `wrap-snapshot-uat-${token}`;
      const host = (args: string[], stdin?: string) => new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = execFile(cli, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout, stderr) => resolve({ exitCode: error ? typeof error.code === "number" ? error.code : 1 : 0, stdout, stderr }));
        child.stdin?.on("error", reject); child.stdin?.end(stdin ?? "");
      });
      const checked = async (args: string[]) => {
        const result = await host(args); expect(result.exitCode, result.stderr).toBe(0); return result;
      };
      const inventory = async () => JSON.parse((await checked(["list", "--all", "--format", "json"])).stdout) as Array<{
        id: string; status: { state: string }; configuration: { labels: Record<string, string>; mounts: unknown[]; networks: unknown[] };
      }>;
      await checked(["image", "inspect", image]);
      expect((await inventory()).some(row => row.id === id)).toBe(false);
      try {
        await checked(["run", "--detach", "--name", id, "--network", "none", "--user", "1000:1000",
          "--cpus", "1", "--memory", "1024M", "--label", `paperclip.snapshot-test=${token}`,
          "--entrypoint", "/bin/sh", image, "-c", "exec sleep infinity"]);
        const row = (await inventory()).find(row => row.id === id)!;
        expect(row.configuration.mounts).toEqual([]); expect(row.configuration.networks).toEqual([]);
        const source = "/workspace/project";
        await checked(["exec", id, "node", "-e", `const fs=require('node:fs');fs.mkdirSync('${source}',{recursive:true});
          fs.writeFileSync('${source}/saved.txt','saved work\\n');fs.mkdirSync('${source}/.paperclip-runtime');
          fs.writeFileSync('${source}/.paperclip-runtime/private.txt','excluded');
          fs.writeFileSync('${source}/large.bin',Buffer.alloc(40*1024*1024,97));
          const fd=fs.openSync('${source}/sparse.bin','wx');fs.writeSync(fd,Buffer.from('A'),0,1,0);
          fs.writeSync(fd,Buffer.from('B'),0,1,1048576);fs.closeSync(fd);`]);
        await checked(["exec", id, "/usr/bin/fallocate", "-l", "16384", `${source}/unwritten.bin`]);
        const client = createCommandManagedRuntimeClient({ commandCwd: source, timeoutMs: 60_000, runner: {
          execute: async input => {
            expect(input.env ?? {}).toEqual({});
            return { ...await host(["exec", "--interactive", "--workdir", input.cwd ?? source,
              id, input.command, ...(input.args ?? [])], input.stdin), signal: null, timedOut: false,
              pid: null, startedAt: new Date().toISOString() };
          },
        } });
        const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-live-snapshot-")); roots.push(root);
        await exportSandboxWorkspaceSnapshot({ client, remoteDir: source, stagingDir: path.join(root, "files"), operationId: token });
        expect(await readFile(path.join(root, "files", "saved.txt"), "utf8")).toBe("saved work\n");
        expect(await readFile(path.join(root, "files", "unwritten.bin"))).toEqual(Buffer.alloc(16384));
        expect((await readFile(path.join(root, "files", "large.bin"))).equals(Buffer.alloc(40 * 1024 * 1024, 97))).toBe(true);
        const sparse = Buffer.alloc(1048577); sparse[0] = 65; sparse[1048576] = 66;
        expect(await readFile(path.join(root, "files", "sparse.bin"))).toEqual(sparse);
        await expect(readFile(path.join(root, "files", ".paperclip-runtime", "private.txt"))).rejects.toMatchObject({ code: "ENOENT" });
        await checked(["exec", id, "node", "-e", `const fs=require('node:fs');const fd=fs.openSync('${source}/oversize.bin','wx');
          fs.ftruncateSync(fd,129*1024*1024);fs.closeSync(fd);`]);
        await expect(exportSandboxWorkspaceSnapshot({ client, remoteDir: source, stagingDir: path.join(root, "oversize"),
          operationId: `${token}:oversize` })).rejects.toMatchObject({ code: "WORKSPACE_SNAPSHOT_EXPORT_UNSUPPORTED" });
        expect(await readdir(path.join(root, "oversize"))).toEqual([]);
      } finally {
        const row = (await inventory()).find(row => row.id === id);
        if (row) {
          expect(row.configuration.labels["paperclip.snapshot-test"]).toBe(token);
          if (row.status.state !== "stopped") await checked(["stop", "--signal", "KILL", "--time", "0", id]);
          expect((await inventory()).find(row => row.id === id)?.status.state).toBe("stopped");
          console.info(`Snapshot UAT retained stopped allocation ${id}`);
        }
      }
    }, 180_000);
});
