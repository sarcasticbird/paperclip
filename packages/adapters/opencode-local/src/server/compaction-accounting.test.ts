import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { COMPACTION_ACCOUNTING_PLUGIN, compactionAccountingRecords, READ_COMPACTION_CAPTURE } from "./compaction-accounting.js";
import { createOpenCodeJsonlParser } from "./parse.js";

const scope = { captureId: "attempt-1", sessionId: "ses_fixture", model: "openai/gpt-6.1-sol" };
const ready = { version: 1, captureId: scope.captureId, type: "ready", runtime: "2.2.5" };
const started = { version: 1, captureId: scope.captureId, type: "started", sessionId: scope.sessionId };
const completed = { ...started, type: "completed", eventId: "evt_fixture", sequence: 22,
  aggregateId: scope.sessionId, model: { providerID: "openai", id: "gpt-6.1-sol", variant: "default" },
  cost: 0.0414047, tokens: { input: 3, output: 925, reasoning: 0, cache: { read: 24962, write: 11861 } } };
const jsonl = (...rows: unknown[]) => rows.map(r => JSON.stringify(r) + "\n").join("");
const sealed = (...rows: unknown[]) => jsonl(...rows, { ...ready, type: "finalized", records: rows.length });

describe("pinned native compaction accounting", () => {
  it.each(["stalled", "publication", "close-error"])("never writes or closes a reused descriptor after %s failure", async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-compaction-descriptor-"));
    try {
      const file = path.join(root, "receipt");
      const plugin = COMPACTION_ACCOUNTING_PLUGIN.replace('import { Plugin } from "@opencode/plugin";',
        'const Plugin = { define: value => value };').replace('import { Rpc } from "@opencode/plugin/rpc";',
        'const Rpc = { define: value => value };');
      const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        const mode = process.argv[2], file = process.env.PAPERCLIP_OPENCODE_COMPACTION_FILE;
        const originalOpen = fs.openSync, originalClose = fs.closeSync;
        let captureFd, otherFd, closes = 0, take;
        const queue = [];
        const push = value => { if (take) { const resolve = take; take = undefined; resolve(value); } else queue.push(value); };
        const openOther = () => {
          otherFd = originalOpen(file + '.unrelated', fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
          assert.equal(otherFd, captureFd, 'fixture must actually reuse the capture descriptor');
          fs.writeSync(otherFd, 'unrelated sentinel');
        };
        fs.openSync = (name, ...args) => {
          const fd = originalOpen(name, ...args);
          if (name === file + '.pending') captureFd = fd;
          return fd;
        };
        fs.closeSync = fd => {
          if (fd === captureFd) {
            closes++;
            if (closes === 1) {
              originalClose(fd);
              if (mode === 'publication') queueMicrotask(openOther);
              if (mode === 'close-error') { openOther(); throw Error('ambiguous close'); }
              return;
            }
          }
          originalClose(fd);
        };
        if (mode === 'publication') fs.writeFileSync(file, 'preserve occupied destination', {mode:0o600});
        const plugin = (await import('data:text/javascript;base64,' + process.argv[1])).default;
        const cleanup = await plugin.setup({app:{version:'2.2.5'},session:{hook:async () => {}},
          rpc:{register:async () => ({events:{emit:async (_name,data) => push({type:'rpc.paperclip-compaction-accounting.boundary',data})}})},
          event:{async *subscribe({signal}) {
            signal.addEventListener('abort', () => { if (mode !== 'stalled') push(null); }, {once:true});
            while (true) {
              const event = queue.length ? queue.shift() : await new Promise(resolve => { take = resolve; });
              if (event === null) return;
              yield event;
            }
          }}});
        // Keep the original 5000ms bounds: the stalled consumer really outlives
        // both abort waits and can resume after cleanup relinquishes the fd.
        await assert.rejects(cleanup());
        if (mode === 'stalled') {
          openOther();
          push({type:'session.compaction.ended',id:'late-event',durable:{seq:22,aggregateID:'ses_fixture'},
            data:{sessionID:'ses_fixture',model:${JSON.stringify(completed.model)},cost:0.0414047,tokens:${JSON.stringify(completed.tokens)}}});
          await new Promise(resolve => setImmediate(resolve));
        }
        assert.equal(closes, 1, 'descriptor ownership must be relinquished exactly once');
        assert.equal(fs.readFileSync(file + '.unrelated','utf8'), 'unrelated sentinel', 'late consumer must not write through a recycled fd');
        fs.writeSync(otherFd, ' still open');
        if (mode === 'publication') assert.equal(fs.readFileSync(file,'utf8'), 'preserve occupied destination');
        else assert.equal(fs.existsSync(file),false,'uncertain shutdown cannot publish a receipt');
        originalClose(otherFd);
      `;
      execFileSync(process.execPath, ["--input-type=module", "-e", script, Buffer.from(plugin).toString("base64"), mode], {
        env: { ...process.env, PAPERCLIP_OPENCODE_COMPACTION_FILE: file, PAPERCLIP_OPENCODE_COMPACTION_ID: scope.captureId },
        timeout: 16000, stdio: ["ignore", "pipe", "pipe"],
      });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 20000);

  it.each(["completed", "clean", "queued-at-drain", "hook-failed", "stream-failed", "unsupported",
    "abort-failed", "close-failed", "skipped-cleanup", "unsettled", "wrong-boundary", "missing-drain", "late-start", "occupied"])("executes generated plugin capture and cleanup (%s)", async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-compaction-plugin-"));
    try {
      const file = path.join(root, "receipt");
      const plugin = COMPACTION_ACCOUNTING_PLUGIN.replace('import { Plugin } from "@opencode/plugin";',
        'const Plugin = { define: value => value };').replace('import { Rpc } from "@opencode/plugin/rpc";',
        'const Rpc = { define: value => value };');
      // Exercise the emitted JavaScript and real private-file lifecycle, not a
      // second implementation of its accounting behavior. SDK is mocked here;
      // exact-build guest compatibility is a separate qualification gate.
      const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        const plugin = (await import('data:text/javascript;base64,' + process.argv[1])).default;
        const mode = process.argv[2];
        let hook, take;
        const queue = [];
        const push = value => { if (take) { const resolve = take; take = undefined; resolve(value); } else queue.push(value); };
        const ended = {type:'session.compaction.ended', id:'evt_fixture', durable:{seq:22,aggregateID:'ses_fixture'},
          data: {sessionID:'ses_fixture', model:${JSON.stringify(completed.model)},cost:0.0414047,tokens:${JSON.stringify(completed.tokens)}}};
        const ctx = { app: { version: mode === 'unsupported' ? 'future-version' : '2.2.5' },
          rpc: { register: async () => ({ events: { emit: async (_name, data) => {
            if (data.phase === 'drain' && mode === 'queued-at-drain') push(ended);
            if (data.phase === 'drain' && mode === 'missing-drain') return;
            if (data.phase === 'drain' && mode === 'late-start') hook({sessionID:'ses_fixture'});
            if (mode === 'wrong-boundary') data = {...data,captureId:'other-attempt'};
            push({type:'rpc.paperclip-compaction-accounting.boundary',data});
          } } }) },
          session: { hook: async (_kind, fn) => { if (mode === 'hook-failed') throw Error('registration'); hook = fn; } },
          event: { async *subscribe({signal}) {
            signal.addEventListener('abort', () => push(null), {once:true});
            while (true) {
              const event = queue.length ? queue.shift() : await new Promise(resolve => { take = resolve; });
              if (event === null) { if (mode === 'abort-failed') throw Error('abort lost'); return; }
              yield event;
              if (mode === 'stream-failed') throw Error('stream lost');
            }
          } } };
        let cleanup;
        if (mode === 'occupied') fs.writeFileSync(process.env.PAPERCLIP_OPENCODE_COMPACTION_FILE, 'preserve unknown file', {mode:0o600});
        try { cleanup = await plugin.setup(ctx); } catch (e) {
          assert(['hook-failed','stream-failed','wrong-boundary'].includes(mode));
        }
        if (['completed','queued-at-drain','unsettled'].includes(mode)) {
          hook({sessionID: 'ses_fixture'});
          if (mode === 'completed') push(ended);
        }
        await new Promise(resolve => setImmediate(resolve));
        if (mode === 'close-failed') fs.closeSync = () => { throw Error('close lost'); };
        if (cleanup && mode !== 'skipped-cleanup') {
          try { await cleanup(); } catch (e) { assert(['abort-failed','close-failed','unsettled','missing-drain','late-start','occupied'].includes(mode)); }
        }
      `;
      execFileSync(process.execPath, ["--input-type=module", "-e", script, Buffer.from(plugin).toString("base64"), mode], {
        env: { ...process.env, PAPERCLIP_OPENCODE_COMPACTION_FILE: file, PAPERCLIP_OPENCODE_COMPACTION_ID: scope.captureId },
        timeout: 8000, stdio: ["ignore", "pipe", "pipe"],
      });
      const raw = await fs.readFile(file, "utf8").catch(() => "");
      const result = compactionAccountingRecords(raw, scope);
      expect(result.complete).toBe(["completed", "clean", "queued-at-drain"].includes(mode));
      if (mode === "occupied") expect(raw).toBe("preserve unknown file");
      if (["completed", "queued-at-drain"].includes(mode)) expect(createOpenCodeJsonlParser()(result.jsonl).costUsd).toBe(0.0414047);
      expect((await fs.stat(raw ? file : file + ".pending")).mode & 0o777).toBe(0o600);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 10000);

  it("reproduces the omitted charge and merges it with primary usage exactly once", () => {
    const capture = compactionAccountingRecords(sealed(ready, started, completed, completed), scope);
    expect(capture.complete).toBe(true);
    const parse = createOpenCodeJsonlParser();
    parse(jsonl({ type: "step_finish", sessionID: scope.sessionId, part: {
      cost: 0.121055, tokens: { input: 43304, output: 860, cache: { read: 42025, write: 0 } },
    } }));
    const result = parse(capture.jsonl);
    expect(result.costUsd).toBeCloseTo(0.1624597, 9);
    expect(result.usage).toEqual({ inputTokens: 55168, cachedInputTokens: 66987, outputTokens: 1785 });
    expect(result.usageComplete).toBe(true);
    expect(capture.jsonl).not.toContain("summary");
  });

  it("does not certify zero compactions from startup readiness", () => {
    expect(compactionAccountingRecords(jsonl(ready), scope).complete).toBe(false);
  });

  it("accepts a finalized, drained zero-compaction capture without inventing usage", () => {
    expect(compactionAccountingRecords(sealed(ready), scope)).toEqual({ complete: true, jsonl: "" });
  });

  it.each([
    "", "{}\n", jsonl({ ...ready, runtime: "2.2.6" }), jsonl({ ...ready, captureId: "prior-attempt" }),
    sealed(ready, started), sealed(ready, { type: "failed", captureId: scope.captureId, version: 1 }),
    sealed(ready, completed), sealed(ready, started, { ...completed, sessionId: "foreign" }),
    sealed(ready, started, { ...completed, aggregateId: "foreign" }),
    sealed(ready, started, { ...completed, sequence: 0 }),
    sealed(ready, started, { ...completed, cost: null }),
    sealed(ready, started, { ...completed, tokens: { input: 1 } }),
    sealed(ready, started, { ...completed, tokens: { ...completed.tokens, reasoning: null } }),
    sealed(ready, started, { ...completed, tokens: { input: Number.MAX_SAFE_INTEGER, output: 0, cache: { write: 1 } } }),
    sealed(ready, started, completed, { ...completed, cost: 1 }),
    sealed(ready, started, completed, started, { ...completed, eventId: "evt-other" }),
    sealed(ready, ...Array.from({ length: 256 }, () => started)),
    jsonl(ready, started, completed).trimEnd(),
    jsonl(ready, started, completed),
    jsonl(ready, { ...ready, type: "finalized", records: 2 }),
    jsonl(ready, { ...ready, type: "finalized", records: 1, runtime: "2.2.6" }),
    sealed(ready) + jsonl(started),
  ])("keeps missing, foreign, interrupted or malformed capture unpriced (%#)", raw => {
    const result = compactionAccountingRecords(raw, scope);
    expect(result.complete).toBe(false);
    const parse = createOpenCodeJsonlParser();
    parse(jsonl({ type: "step_finish", part: { cost: 1, tokens: { input: 1, output: 1 } } }));
    expect(parse(result.jsonl)).toMatchObject({ costUsd: null, usageComplete: false,
      errorMessage: "opencode_compaction_accounting_incomplete" });
  });

  it("binds model identity and bounds receipt transfer", () => {
    expect(compactionAccountingRecords(sealed(ready, started, completed), { ...scope, model: "other/model" }).complete).toBe(false);
    expect(compactionAccountingRecords(" ".repeat(256 * 1024 + 1) + "\n", scope).complete).toBe(false);
  });

  it("projects validated counters without copying provider content into accounting logs", () => {
    const result = compactionAccountingRecords(sealed(ready, started, { ...completed,
      tokens: { ...completed.tokens, privateText: "DO_NOT_RETAIN" } }), scope);
    expect(result.complete).toBe(true);
    expect(result.jsonl).not.toContain("DO_NOT_RETAIN");
    expect(compactionAccountingRecords(jsonl(ready), { ...scope, sessionId: null }).complete).toBe(false);
  });

  it("reads only a bounded private regular single-link receipt, never a linked target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-compaction-reader-"));
    try {
      const file = path.join(root, "receipt");
      await fs.writeFile(file, jsonl(ready), { mode: 0o600 });
      const read = (p: string) => execFileSync(process.execPath, ["-e", READ_COMPACTION_CAPTURE, p], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect(read(file)).toBe(jsonl(ready));
      await fs.symlink(file, path.join(root, "symlink"));
      expect(() => read(path.join(root, "symlink"))).toThrow();
      await fs.link(file, path.join(root, "hardlink"));
      expect(() => read(file)).toThrow();
      await fs.unlink(path.join(root, "hardlink"));
      await fs.chmod(file, 0o644);
      expect(() => read(file)).toThrow();
      await fs.chmod(file, 0o600);
      await fs.writeFile(file, "x".repeat(256 * 1024 + 1));
      expect(() => read(file)).toThrow();
      expect(() => read(root)).toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
