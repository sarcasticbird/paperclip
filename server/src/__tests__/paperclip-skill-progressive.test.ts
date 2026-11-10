import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const load = (name: string) => readFile(new URL(`../../../skills/paperclip/${name}`, import.meta.url), "utf8");
function section(body: string, heading: string) {
  const start = body.indexOf(`## ${heading}\n`);
  if (start < 0) throw new Error(`Missing section: ${heading}`);
  const next = body.indexOf("\n## ", start + heading.length + 4);
  return body.slice(start, next < 0 ? undefined : next).trim();
}

describe("bounded Paperclip skill entrypoint", () => {
  it("preserves the complete previous procedures with sibling reference paths intact", async () => {
    const original = (await load("WORKFLOWS.md")).replace("# Paperclip Workflow Reference", "# Paperclip Skill");
    // Pin the pre-split contract: shortening the entrypoint must not delete a
    // policy/example from the full reference. Intentional future policy changes
    // must update this baseline deliberately, not silently drop moved text.
    expect(createHash("sha256").update(original).digest("hex"))
      .toBe("f79532ee8a8df97dd7e239cff0046b3fc00311c8497a0b7dbdd0303f3aee7808");
    expect(original).toContain("references/api-reference.md");
    expect(original).toContain("scripts/paperclip-upload-artifact.sh");
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
