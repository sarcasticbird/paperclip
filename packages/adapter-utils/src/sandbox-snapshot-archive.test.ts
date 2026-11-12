import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { pack, type Headers } from "tar-stream";
import { afterEach, expect, it } from "vitest";
import { extractSandboxSnapshotArchive } from "./sandbox-snapshot-archive.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  await chmod(path.join(root, "staging", "restricted"), 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
} });
async function archive(entries: Array<[Headers, string?]>) {
  const writer = pack(), chunks: Buffer[] = [];
  const result = (async () => { for await (const chunk of writer) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); })();
  for (const [header, text] of entries) writer.entry(header, text ?? "");
  writer.finalize(); return result;
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "snapshot-archive-adversarial-")); roots.push(root);
  const localDir = path.join(root, "staging"); await mkdir(localDir);
  return { root, localDir };
}
it.each([
  [{ name: "/absolute" }],
  [{ name: "../outside" }],
  [{ name: "nested/../outside" }],
  [{ name: "good" }, { name: "./good" }],
  [{ name: "device", type: "character-device" }],
  [{ name: "special", mode: 0o4755 }],
  [{ name: "private/.paperclip-runtime/state" }],
  [{ name: "bad\\name" }],
  [{ name: "line\nbreak" }],
  [{ name: "external", type: "symlink", linkname: "../outside" }],
  [{ name: "external", type: "link", linkname: "/outside" }],
  [{ name: "missing", type: "link", linkname: "absent" }],
  [{ name: "cycle", type: "symlink", linkname: "cycle" }],
  [{ name: "a", type: "symlink", linkname: "b" }, { name: "b", type: "symlink", linkname: "a" }],
  [{ name: "alias", type: "symlink", linkname: "." }, { name: "escape", type: "symlink", linkname: "alias/../outside" }],
  [{ name: "alias", type: "symlink", linkname: "directory" }, { name: "alias/child" }],
  [{ name: "alias/child" }, { name: "alias", type: "symlink", linkname: "directory" }],
  [{ name: "sparse", pax: { "GNU.sparse.realsize": "999999999999" } }],
] as Headers[][])("refuses hostile metadata before creating any host entry: %j", async (...headers: Headers[]) => {
  const f = await fixture();
  const bytes = await archive([[{ name: "innocent" }, "not written"], ...headers.map(h => [h] as [Headers])]);
  await expect(extractSandboxSnapshotArchive({ ...f, bytes })).rejects.toMatchObject({ code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" });
  expect(await readdir(f.localDir)).toEqual([]);
});

it("preserves regular bytes, executable modes, internal symlinks and forward hardlinks", async () => {
  const f = await fixture();
  const bytes = await archive([[{ name: "hard", type: "link", linkname: "nested/file" }],
    [{ name: "nested", type: "directory", mode: 0o755 }], [{ name: "nested/file", mode: 0o755 }, "saved\n"],
    [{ name: "relative", type: "symlink", linkname: "nested/file" }]]);
  await extractSandboxSnapshotArchive({ ...f, bytes });
  expect(await readFile(path.join(f.localDir, "relative"), "utf8")).toBe("saved\n");
  expect((await stat(path.join(f.localDir, "nested/file"))).mode & 0o777).toBe(0o755);
  expect((await stat(path.join(f.localDir, "hard"))).ino).toBe((await stat(path.join(f.localDir, "nested/file"))).ino);
});

it("refuses compressed input, truncated input, entry quotas and hardlink expansion", async () => {
  const f = await fixture(), bytes = await archive([[{ name: "saved" }, "hello"], [{ name: "hard", type: "link", linkname: "saved" }]]);
  for (const input of [{ bytes: gzipSync(bytes) }, { bytes: bytes.subarray(0, 700) },
    { bytes, maximumEntries: 1 }, { bytes, maximumBytes: 9 }]) {
    await expect(extractSandboxSnapshotArchive({ ...f, ...input })).rejects.toMatchObject({ code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" });
    expect(await readdir(f.localDir)).toEqual([]);
  }
});

it("settles a deadline during parsing without creating host entries", async () => {
  const f = await fixture(), bytes = await archive([[{ name: "large" }, "x".repeat(2 * 1024 * 1024)]]);
  await expect(extractSandboxSnapshotArchive({ ...f, bytes, timeoutMs: 1 })).rejects.toMatchObject({ code: "ETIMEDOUT" });
  expect(await readdir(f.localDir)).toEqual([]);
});

it("counts hardlink logical expansion independently of transferred archive size", async () => {
  const f = await fixture(), bytes = await archive([[{ name: "file" }, "x".repeat(8192)],
    ...[1, 2, 3, 4].map(i => [{ name: `hard${i}`, type: "link", linkname: "file" }] as [Headers])]);
  expect(bytes.length).toBeLessThan(5 * 8192);
  await expect(extractSandboxSnapshotArchive({ ...f, bytes, maximumBytes: bytes.length }))
    .rejects.toMatchObject({ code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" });
  expect(await readdir(f.localDir)).toEqual([]);
});

it.each(["Z", "S"])("refuses raw unknown/sparse tar type %s instead of treating it as a file", async flag => {
  const f = await fixture(), bytes = await archive([[{ name: "unsupported" }, "compact payload"]]);
  bytes[156] = flag.charCodeAt(0); bytes.fill(32, 148, 156);
  const sum = bytes.subarray(0, 512).reduce((total, value) => total + value, 0);
  bytes.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  await expect(extractSandboxSnapshotArchive({ ...f, bytes })).rejects.toMatchObject({ code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" });
  expect(await readdir(f.localDir)).toEqual([]);
});

it("counts implicit parent directories in the node quota and refuses excessive depth", async () => {
  const f = await fixture();
  for (const [name, maximumEntries] of [["a/b/c/file", 3], [Array(66).fill("a").join("/"), 100]] as const) {
    await expect(extractSandboxSnapshotArchive({ ...f, bytes: await archive([[{ name }, "data"]]), maximumEntries }))
      .rejects.toMatchObject({ code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" });
    expect(await readdir(f.localDir)).toEqual([]);
  }
});

it.each([0o500, 0o000])("retains unsupported directory mode %s without creating an uncleanable tree", async mode => {
  const f = await fixture(), bytes = await archive([[{ name: "restricted", type: "directory", mode }],
    [{ name: "restricted/file" }, "data"]]);
  if (mode === 0) {
    bytes.write("0000000\0", 100, 8, "ascii"); bytes.fill(32, 148, 156);
    const sum = bytes.subarray(0, 512).reduce((total, value) => total + value, 0);
    bytes.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  }
  await expect(extractSandboxSnapshotArchive({ ...f, bytes })).rejects.toMatchObject({ code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" });
  expect(await readdir(f.localDir)).toEqual([]);
});
