import fs from "node:fs/promises";
import path from "node:path";
import { preparePluginDirectory } from "./sandbox-tool-memory.js";

const MAX_BYTES = 256 * 1024;
const MAX_RECORDS = 256;
const VERSION = "2.2.5";

/** Native V2 CLI omits these events; do not collect primary step usage twice. */
export const COMPACTION_ACCOUNTING_PLUGIN = `import { Plugin } from "@opencode/plugin";
import { Rpc } from "@opencode/plugin/rpc";
import fs from "node:fs";
const Boundary = Rpc.define({ id: "paperclip-compaction-accounting", methods: {}, events: {
  boundary: { schema: { type: "object", properties: { captureId: { type: "string" }, phase: { type: "string" } }, required: ["captureId", "phase"], additionalProperties: false } }
} });
export default Plugin.define({ id: "paperclip.compaction-accounting", async setup(ctx) {
  const file = process.env.PAPERCLIP_OPENCODE_COMPACTION_FILE;
  const captureId = process.env.PAPERCLIP_OPENCODE_COMPACTION_ID;
  if (!file || !captureId) return;
  // Never publish the readable path until the stream has drained and the
  // receipt descriptor has successfully closed. A killed writer leaves only
  // a private .pending file, not a plausible zero-compaction receipt.
  const pendingFile = file + ".pending";
  let fd = fs.openSync(pendingFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  const closeCapture = () => {
    const owned = fd;
    // Revoke every writer before calling close, including when close reports
    // an uncertain outcome. Never retry a close using a possibly recycled fd.
    fd = undefined;
    if (owned !== undefined) fs.closeSync(owned);
  };
  let size = 0, count = 0;
  const write = value => {
    if (fd === undefined) throw Error("opencode_compaction_capture_closed");
    const line = JSON.stringify({ ...value, captureId, version: 1 }) + "\\n";
    size += Buffer.byteLength(line); count++;
    if (size > ${MAX_BYTES} || count > ${MAX_RECORDS}) throw Error("opencode_compaction_capture_limit");
    fs.writeSync(fd, line); fs.fsyncSync(fd);
  };
  if (ctx.app.version !== "${VERSION}") {
    try { write({ type: "unsupported" }); } finally { closeCapture(); }
    return;
  }
  let failed = false, closing = false, active = 0, waiter;
  const completed = new Set();
  const controller = new AbortController();
  // Native and RPC envelopes share this subscription. A received own boundary
  // proves subscription activation, then ordered consumption through that
  // boundary. Do not replace this with a timeout/sleep or abort-as-drain.
  let registration;
  try { registration = await ctx.rpc.register(Boundary, {}); }
  catch (error) { closeCapture(); throw error; }
  let stream;
  try { stream = ctx.event.subscribe({ signal: controller.signal }); }
  catch (error) { closeCapture(); throw error; }
  const pending = (async () => {
    for await (const event of stream) {
      if (event.type === "rpc.paperclip-compaction-accounting.boundary") {
        if (event.data.captureId === captureId && event.data.phase === waiter?.phase) waiter.resolve();
        continue;
      }
      if (event.type !== "session.compaction.ended" && event.type !== "session.compaction.failed") continue;
      const data = event.data;
      if (event.type === "session.compaction.failed") { failed = true; write({ type: "failed", sessionId: data.sessionID }); continue; }
      write({ type: "completed", eventId: event.id, sequence: event.durable?.seq,
        aggregateId: event.durable?.aggregateID, sessionId: data.sessionID,
        model: data.model, cost: data.cost, tokens: data.tokens });
      if (!completed.has(event.id)) { completed.add(event.id); active--; }
    }
    if (!controller.signal.aborted) throw Error("opencode_compaction_stream_ended");
  })().catch(() => {
    // Even an abort-time exception is uncertainty, never successful draining.
    failed = true; waiter?.reject(Error("opencode_compaction_stream_failed"));
    try { write({ type: "failed" }); } catch {}
  });
  const bounded = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("opencode_compaction_boundary_timeout")), 5000);
    })]); } finally { clearTimeout(timer); }
  };
  const boundary = async phase => {
    const received = new Promise((resolve, reject) => { waiter = { phase, resolve, reject }; });
    try {
      await bounded(Promise.all([received, registration.events.emit("boundary", { captureId, phase })]));
      if (failed) throw Error("opencode_compaction_capture_failed");
    } finally { waiter = undefined; }
  };
  try {
    await ctx.session.hook("compaction", event => {
      if (failed || closing) { failed = true; throw Error("opencode_compaction_capture_failed"); }
      write({ type: "started", sessionId: event.sessionID });
      active++;
    });
    await boundary("ready");
    write({ type: "ready", runtime: ctx.app.version });
  } catch (error) {
    closing = true; controller.abort();
    try { await bounded(pending); } finally { closeCapture(); }
    throw error;
  }
  return async () => {
    closing = true;
    try {
      await boundary("drain");
      if (active !== 0) throw Error("opencode_compaction_capture_unsettled");
      controller.abort(); await bounded(pending);
      if (failed || active !== 0) throw Error("opencode_compaction_capture_failed");
      write({ type: "finalized", runtime: ctx.app.version, records: count });
      closeCapture();
      // link is exclusive (unlike rename, it cannot overwrite an unknown
      // destination). Reader refuses the temporary two-link publication window.
      fs.linkSync(pendingFile, file); fs.unlinkSync(pendingFile);
    } catch (error) {
      controller.abort(); await bounded(pending).catch(() => {});
      try { closeCapture(); } catch {}
      throw error;
    }
  };
} });
`;

export async function installCompactionAccounting(configDir: string) {
  const plugins = path.join(configDir, "plugins");
  await preparePluginDirectory(configDir, plugins);
  await fs.writeFile(path.join(plugins, "paperclip-v2-compaction-accounting.js"), COMPACTION_ACCOUNTING_PLUGIN,
    { flag: "wx", mode: 0o600 });
}

/** Runs in the existing execution target, after its CLI stopped; no service/API. */
export const READ_COMPACTION_CAPTURE = `const fs = require("node:fs");
const fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
try {
  const s = fs.fstatSync(fd);
  if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.size > ${MAX_BYTES}) throw Error("unsafe_capture");
  const bytes = Buffer.alloc(${MAX_BYTES} + 1);
  let size = 0;
  while (size < bytes.length) {
    const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
    if (!count) break;
    size += count;
  }
  if (size > ${MAX_BYTES}) throw Error("capture_too_large");
  process.stdout.write(bytes.subarray(0, size));
} finally { fs.closeSync(fd); }`;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim();
}
function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function compactionAccountingRecords(raw: string, scope: { captureId: string; sessionId: string | null; model: string }) {
  const records: string[] = [];
  let complete = true;
  const reject = () => { complete = false; };
  const starts = new Map<string, number>();
  const seen = new Map<string, string>();
  const sequences = new Set<number>();
  const selected = scope.model.split("#")[0];
  try {
    if (!identity(scope.captureId) || !identity(scope.sessionId) || Buffer.byteLength(raw) > MAX_BYTES || !raw.endsWith("\n")) throw Error();
    const lines = raw.trim().split("\n");
    if (lines.length < 1 || lines.length > MAX_RECORDS) throw Error();
    const ready = object(JSON.parse(lines[0]!));
    if (ready.version !== 1 || ready.captureId !== scope.captureId || ready.type !== "ready" || ready.runtime !== VERSION) throw Error();
    const final = object(JSON.parse(lines.at(-1)!));
    if (lines.length < 2 || final.version !== 1 || final.captureId !== scope.captureId ||
        final.type !== "finalized" || final.runtime !== VERSION || final.records !== lines.length - 1) reject();
    for (const line of lines.slice(1, final.type === "finalized" ? -1 : undefined)) {
      const item = object(JSON.parse(line));
      if (item.version !== 1 || item.captureId !== scope.captureId || item.sessionId !== scope.sessionId) { reject(); continue; }
      if (item.type === "started") { starts.set(scope.sessionId, (starts.get(scope.sessionId) ?? 0) + 1); continue; }
      if (item.type !== "completed" || !identity(item.eventId) || item.aggregateId !== scope.sessionId || !counter(item.sequence) || item.sequence === 0) { reject(); continue; }
      const model = object(item.model), tokens = object(item.tokens), cache = object(tokens.cache);
      const values = [tokens.input, tokens.output, tokens.reasoning === undefined ? 0 : tokens.reasoning,
        cache.read === undefined ? 0 : cache.read, cache.write === undefined ? 0 : cache.write];
      if (`${model.providerID}/${model.id}` !== selected || !values.every(counter) ||
          typeof item.cost !== "number" || !Number.isFinite(item.cost) || item.cost < 0) { reject(); continue; }
      if (!Number.isSafeInteger(Number(values[0]) + Number(values[4])) ||
          !Number.isSafeInteger(Number(values[1]) + Number(values[2]))) { reject(); continue; }
      const digest = JSON.stringify([item.sessionId, item.sequence, model, item.cost, tokens]);
      if (seen.has(item.eventId)) { if (seen.get(item.eventId) !== digest) reject(); continue; }
      seen.set(item.eventId, digest);
      if (sequences.has(item.sequence)) { reject(); continue; }
      sequences.add(item.sequence);
      const remaining = starts.get(scope.sessionId) ?? 0;
      if (remaining === 0) { reject(); continue; }
      starts.set(scope.sessionId, remaining - 1);
      records.push(JSON.stringify({ type: "step_finish", sessionID: scope.sessionId,
        part: { id: `compaction:${item.eventId}`, cost: item.cost,
          tokens: { input: values[0], output: values[1], reasoning: values[2], cache: { read: values[3], write: values[4] } },
          reason: "compaction", paperclipAuxiliaryUsage: { version: 1, eventId: item.eventId, sequence: item.sequence } } }));
    }
    if ([...starts.values()].some(count => count !== 0)) reject();
  } catch { reject(); }
  // The existing parser and ledger already preserve missing cost/usage. Do not
  // invent zeros or let a successful CLI exit certify an incomplete capture.
  if (!complete) records.push(JSON.stringify({ type: "step_finish", part: {} }), JSON.stringify({
    type: "error", error: "opencode_compaction_accounting_incomplete",
  }));
  return { complete, jsonl: records.map(line => line + "\n").join("") };
}
