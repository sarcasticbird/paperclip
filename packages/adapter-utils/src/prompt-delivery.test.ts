import { describe, expect, it } from "vitest";
import { createPaperclipAssignmentReceipt, normalizePaperclipAssignmentReceipt, paperclipAssignmentReceiptMatches } from "./prompt-delivery.js";
import { selectPaperclipPromptSections } from "./server-utils.js";
import { createPromptContextFixture } from "./test-fixtures/prompt-context.js";

const scope = { companyId: "company-1", agentId: "agent-1", sessionId: "native-1" };
const plan = "gh-sweep read-only inspection scope; preserve independent QA.\n".repeat(500).trim();
function context() {
  const fixture = createPromptContextFixture();
  return { ...fixture, paperclipIssue: { id: "issue-1" },
    paperclipTaskMarkdownAssignment: `Full current brief\n${fixture.paperclipWake.issue.description}\nPlan revision r1\n${plan}`,
    paperclipTaskMarkdownAssignmentCompact: `Legacy compact brief\n${plan}`,
    paperclipTaskMarkdownAssignmentUnchanged: "Current policy and task identity\nPlan revision r1 (unchanged; read on demand)." };
}
function sections(ctx = context(), receipt?: unknown, resumedSession = true) {
  const previous = arguments.length < 2 ? createPaperclipAssignmentReceipt(ctx, scope) : receipt;
  return selectPaperclipPromptSections(ctx, {
    resumedSession, includeCommunicationGuidance: false,
    assignmentDelivery: { scope, receipt: previous },
  });
}

describe("session-bound assignment delivery", () => {
  it("keeps unchanged plans out of verified resume prompts while delivering current events", () => {
    const ctx = context(), before = structuredClone(ctx);
    const result = sections(ctx);
    expect(result.taskContextNote).toBe(ctx.paperclipTaskMarkdownAssignmentUnchanged);
    expect(result.taskContextNote + result.wakePrompt).not.toContain(plan);
    expect(result.wakePrompt).not.toContain(ctx.paperclipWake.issue.description);
    expect(result.wakePrompt).toContain("Change the final scope to the launch checklist.");
    expect(result.taskContextNote.length).toBeLessThan(300);
    expect(ctx).toEqual(before);
  });

  it.each([null, undefined, {}, { version: 99 }])("sends the full current brief for missing/legacy/malformed receipt %j", (receipt) => {
    expect(sections(context(), receipt).taskContextNote).toContain("Full current brief");
  });

  it.each(["companyId", "agentId", "sessionId", "issueId", "assignmentHash"])("does not reuse a receipt with a different %s", (key) => {
    const ctx = context(), receipt = createPaperclipAssignmentReceipt(ctx, scope)!;
    expect(sections(ctx, { ...receipt, [key]: "different" }).taskContextNote).toContain(plan);
  });

  it.each(["paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownAssignmentUnchanged"] as const)("redelivers the full brief when %s changes", (key) => {
    const ctx = context(), receipt = createPaperclipAssignmentReceipt(ctx, scope);
    ctx[key] += "\nChanged description, plan revision, or current policy.";
    expect(sections(ctx, receipt).taskContextNote).toContain(ctx.paperclipTaskMarkdownAssignment);
  });

  it("sends the full brief on a genuine fresh attempt even if a matching receipt is present", () => {
    expect(sections(context(), undefined, false).taskContextNote).toContain(plan);
  });

  it.each(["issue_assigned", "source_scoped_recovery_action"])("does not elide assignment or recovery context for %s", (reason) => {
    const ctx = context(); ctx.paperclipWake.reason = reason;
    expect(sections(ctx).taskContextNote).toContain(plan);
  });

  it("requires the server's opt-in projection and keeps conversation behavior out of this contract", () => {
    const ctx: Record<string, unknown> = context();
    delete ctx.paperclipTaskMarkdownAssignmentUnchanged;
    expect(createPaperclipAssignmentReceipt(ctx, scope)).toBeNull();
    expect(createPaperclipAssignmentReceipt({ ...context(), conversationMode: true }, scope)).toBeNull();
    expect(createPaperclipAssignmentReceipt({ ...context(), paperclipIssue: { id: "other" } }, scope)).toBeNull();
  });

  it("round-trips only a versioned bounded digest, not prompts or arbitrary session data", () => {
    const ctx = context(), receipt = createPaperclipAssignmentReceipt(ctx, scope)!;
    expect(normalizePaperclipAssignmentReceipt({ ...receipt, rawPrompt: plan })).toEqual(receipt);
    expect(JSON.stringify(receipt)).not.toContain(plan);
    expect(paperclipAssignmentReceiptMatches(ctx, scope, JSON.parse(JSON.stringify(receipt)))).toBe(true);
  });
});
