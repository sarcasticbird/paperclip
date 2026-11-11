import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const load = (name: string) => readFile(new URL(`../../../skills/paperclip/${name}`, import.meta.url), "utf8");
function section(body: string, heading: string) {
  const start = body.indexOf(`## ${heading}\n`);
  if (start < 0) throw new Error(`Missing section: ${heading}`);
  const next = body.indexOf("\n## ", start + heading.length + 4);
  return body.slice(start, next < 0 ? undefined : next).trim();
}

describe("bounded Paperclip skill entrypoint", () => {
  it("preserves the complete selectable deployed V8 release independently of current source", async () => {
    const releases = new URL("../../../skills-releases/paperclip/", import.meta.url);
    const registry = JSON.parse(await readFile(new URL("releases.json", releases), "utf8"));
    const release = registry.find((entry: { id: string }) => entry.id === "v8-bounded-context");
    expect(release.dir).toBe("v8-bounded-context");
    const snapshot = new URL(`${release.dir}/`, releases);
    const files = async (root: URL, prefix = ""): Promise<string[]> => {
      const result: string[] = [];
      for (const entry of await readdir(new URL(prefix, root), { withFileTypes: true })) {
        const name = `${prefix}${entry.name}`;
        if (entry.isDirectory()) result.push(...await files(root, `${name}/`));
        else { expect(entry.isFile()).toBe(true); result.push(name); }
      }
      return result.sort();
    };
    const names = await files(snapshot);
    const digest = createHash("sha256");
    for (const name of names) {
      digest.update(name).update("\0").update(await readFile(new URL(name, snapshot))).update("\0");
    }
    // Deployed pins keep their admitted bytes. Updating current skill guidance
    // must not rewrite the historical immutable package to make this test pass.
    expect(digest.digest("hex")).toBe("9c4c8b1ffdec0e5ca3748ff5e8fe0a08cbf604759bd08175c886ae14af7cba09");
    expect(names).toContain("WORKFLOWS.md");
    expect(names).toContain("scripts/paperclip-issue-update.sh");
  });

  it("preserves the complete previous procedures with sibling reference paths intact", async () => {
    const original = (await load("WORKFLOWS.md")).replace("# Paperclip Workflow Reference", "# Paperclip Skill");
    // Exact full upstream skill at fa3cd6f3, moved without deleting policy or
    // examples. Incorporates #20362's stay-on-current-task/access-denial guidance.
    expect(createHash("sha256").update(original).digest("hex"))
      .toBe("94c32785d68feeede0f2951ace9664295199da70aaecee03752403dc4aeb01ee");
    expect(original).toContain("references/api-reference.md");
    expect(original).toContain("scripts/paperclip-upload-artifact.sh");
    expect(original).toContain("Continue work on the current issue.");
    expect(original).toContain("If access is denied, report the missing permission on your current task.");
    expect(original).not.toContain("Courier pattern");
  });

  it("bounds repeated root loading without altering authentication or critical rules", async () => {
    const root = await load("SKILL.md"), full = await load("WORKFLOWS.md");
    expect(Buffer.byteLength(root)).toBeLessThan(30_000);
    expect(Buffer.byteLength(root)).toBeLessThan(Buffer.byteLength(full) * 0.4);
    expect(section(root, "Authentication")).toBe(section(full, "Authentication"));
    expect(section(root, "Critical Rules")).toBe(section(full, "Critical Rules"));
    expect(section(root, "Server-Verified External Chat Turns")).toBe(section(full, "Server-Verified External Chat Turns"));
  });

  it("routes every conditional top-level procedure before the corresponding operation", async () => {
    const root = await load("SKILL.md");
    for (const anchor of ["managing-a-users-inbox", "issue-dependencies-blockers", "requesting-board-approval",
      "issue-thread-interactions", "mcp-tool-approval-gates", "niche-workflow-pointers", "cases",
      "company-skills-workflow", "routines", "task-files-and-workspace-choices", "issue-workspace-runtime-controls",
      "proposing-credentials-safely", "reading-granted-secrets", "task-documents-and-deliverables",
      "planning-required-when-planning-requested", "key-endpoints-hot-routes", "searching-issues", "full-reference", "incidental-feedback"]) {
      expect(root).toContain(`WORKFLOWS.md#${anchor}`);
    }
    expect(root).toContain("Before the named action, read the linked section");
    expect(root).toContain("Those procedures remain binding");
    expect(root).toContain("New or changed instructions take precedence over remembered copies");
    expect(root).toContain("After compaction, reread this entrypoint");
    expect(root).toContain("do not reload every unrelated workflow");
  });
});
