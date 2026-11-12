import { promises as fs } from "node:fs";
import path from "node:path";
import { extract } from "tar-stream";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
const MAX_NAMES = 8 * 1024 * 1024;
const unsafe = () => Object.assign(new Error("Unsafe or unsupported workspace snapshot archive; source retained"),
  { code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" });
type Member = { name: string; type: string; mode: number; link: string; bytes: Buffer; size: number };

export async function extractSandboxSnapshotArchive(input: {
  bytes: Buffer; localDir: string; timeoutMs?: number;
  maximumBytes?: number; maximumEntries?: number;
}): Promise<void> {
  const maximumBytes = Math.min(MAX_BYTES, input.maximumBytes ?? MAX_BYTES);
  const maximumEntries = Math.min(MAX_ENTRIES, input.maximumEntries ?? MAX_ENTRIES);
  const timeoutMs = Math.min(120_000, input.timeoutMs ?? 120_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 ||
      !Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || input.bytes.length > maximumBytes) throw unsafe();
  const controller = new AbortController(), signal = controller.signal;
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("Workspace snapshot extraction timed out; source retained"),
    { code: "ETIMEDOUT" })), timeoutMs);
  const members = new Map<string, Member>();
  const confined = (name: string) => {
    if (!name || Buffer.byteLength(name) > 4096 || /[\x00-\x1f\x7f\\]/.test(name) || path.posix.isAbsolute(name)) throw unsafe();
    const clean = name.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (!clean || clean.split("/").length > 64 || clean.split("/").some(part => !part || part === "." || part === ".." || part === ".paperclip-runtime")) throw unsafe();
    return clean;
  };
  try {
    let expandedBytes = 0, nameBytes = 0;
    const parser = extract();
      parser.on("entry", (header, stream, next) => {
        void (async () => {
          signal.throwIfAborted();
          const name = confined(header.name), type = header.type, size = header.size ?? 0;
          if (!type) throw unsafe();
          const mode = header.mode ?? 0o644, link = header.linkname ?? "";
          const pax = (header as typeof header & { pax?: Record<string, string> }).pax;
          nameBytes += Buffer.byteLength(name) + Buffer.byteLength(link);
          if (members.has(name) || members.size >= maximumEntries || nameBytes > MAX_NAMES ||
              !["file", "directory", "symlink", "link"].includes(type) || !Number.isSafeInteger(size) || size < 0 ||
              !Number.isSafeInteger(mode) || mode < 0 || (mode & ~0o777) !== 0 ||
              (type === "directory" && (mode & 0o700) !== 0o700) ||
              (type === "file" && (mode & 0o400) !== 0o400) ||
              (type !== "file" && size !== 0) || (pax && Object.keys(pax).some(key =>
                !["path", "linkpath", "size", "mtime", "atime", "ctime"].includes(key)))) throw unsafe();
          expandedBytes += size;
          if (expandedBytes > maximumBytes) throw unsafe();
          if (type === "link") confined(link);
          if (type === "symlink") {
            if (!link || link.split("/").length > 64 || Buffer.byteLength(link) > 4096 || /[\x00-\x1f\x7f\\]/.test(link) || path.posix.isAbsolute(link)) throw unsafe();
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), link));
            if (resolved !== ".") confined(resolved);
          }
          const chunks: Buffer[] = [];
          let length = 0;
          for await (const chunk of stream) {
            signal.throwIfAborted(); length += chunk.length;
            if (length > size) throw unsafe();
            chunks.push(Buffer.from(chunk));
          }
          if (length !== size) throw unsafe();
          members.set(name, { name, type, size, mode, link, bytes: Buffer.concat(chunks, length) });
          next();
        })().catch(error => { parser.destroy(error as Error); });
      });
      const source = Readable.from((async function* () {
        for (let offset = 0; offset < input.bytes.length; offset += 64 * 1024) {
          signal.throwIfAborted();
          yield input.bytes.subarray(offset, offset + 64 * 1024);
          await setImmediate(undefined, { signal });
        }
      })());
    try { await pipeline(source, parser, { signal }); }
    catch { if (signal.aborted) throw signal.reason; throw unsafe(); }
    signal.throwIfAborted();
    const directories = new Set<string>(["."]);
    const nodes = new Set(members.keys());
    let steps = 0;
    const checkpoint = async () => {
      signal.throwIfAborted();
      if (++steps % 128 === 0) await setImmediate(undefined, { signal });
    };
    for (const member of members.values()) {
      await checkpoint();
      if (member.type === "directory") directories.add(member.name);
      for (let parent = path.posix.dirname(member.name); parent !== "."; parent = path.posix.dirname(parent)) {
        await checkpoint();
        nodes.add(parent);
        if (nodes.size > maximumEntries) throw unsafe();
        directories.add(parent);
        if (members.has(parent) && members.get(parent)!.type !== "directory") throw unsafe();
      }
      if (member.type === "link") {
        const target = members.get(confined(member.link));
        if (target?.type !== "file") throw unsafe();
        expandedBytes += target.size;
        if (expandedBytes > maximumBytes) throw unsafe();
      }
    }
    for (const member of members.values()) {
      await checkpoint();
      if (member.type !== "symlink") continue;
      const stack = path.posix.dirname(member.name) === "." ? [] : path.posix.dirname(member.name).split("/");
      let pending = member.link.split("/"), hops = 0;
      while (pending.length) {
        await checkpoint();
        const part = pending.shift()!;
        if (!part || part === ".") continue;
        if (part === "..") { if (!stack.length) throw unsafe(); stack.pop(); continue; }
        stack.push(part);
        const current = stack.join("/"), entry = members.get(current);
        if (entry?.type === "symlink") {
          if (++hops > 40) throw unsafe();
          stack.pop(); pending = [...entry.link.split("/"), ...pending];
        } else if (!entry && !directories.has(current)) throw unsafe();
        else if (pending.length && !directories.has(current)) throw unsafe();
      }
    }
    const root = await fs.realpath(input.localDir);
    if (!(await fs.lstat(input.localDir)).isDirectory() || (await fs.readdir(root)).length) throw unsafe();
    for (const member of members.values()) {
      signal.throwIfAborted();
      const destination = path.join(root, member.name);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      if (member.type === "directory") await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      if (member.type === "file") {
        await fs.writeFile(destination, member.bytes, { flag: "wx", mode: 0o600, signal });
        await fs.chmod(destination, member.mode);
      }
    }
    for (const member of members.values()) {
      signal.throwIfAborted();
      if (member.type === "symlink") await fs.symlink(member.link, path.join(root, member.name));
      if (member.type === "link") await fs.link(path.join(root, confined(member.link)), path.join(root, member.name));
    }
    for (const member of [...members.values()].filter(entry => entry.type === "directory")
      .sort((a, b) => b.name.length - a.name.length)) {
      signal.throwIfAborted(); await fs.chmod(path.join(root, member.name), member.mode);
    }
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally { clearTimeout(timer); }
}
