import { createHash } from "node:crypto";

export interface PaperclipAssignmentScope {
  companyId: string;
  agentId: string;
  sessionId: string;
}

/** A successful native turn's projection, not an execution or write receipt. */
export interface PaperclipAssignmentReceipt extends PaperclipAssignmentScope {
  version: 1;
  issueId: string;
  assignmentHash: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim();
}

export function normalizePaperclipAssignmentReceipt(value: unknown): PaperclipAssignmentReceipt | null {
  const item = record(value);
  if (item.version !== 1 || !identity(item.companyId) || !identity(item.agentId) ||
      !identity(item.sessionId) || !identity(item.issueId) ||
      typeof item.assignmentHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.assignmentHash)) return null;
  return { version: 1, companyId: item.companyId, agentId: item.agentId,
    sessionId: item.sessionId, issueId: item.issueId, assignmentHash: item.assignmentHash };
}

export function createPaperclipAssignmentReceipt(
  context: Record<string, unknown> | null | undefined,
  scope: PaperclipAssignmentScope,
): PaperclipAssignmentReceipt | null {
  if (!context || context.conversationMode === true ||
      !identity(scope.companyId) || !identity(scope.agentId) || !identity(scope.sessionId)) return null;
  const issue = record(context.paperclipIssue);
  const wakeIssue = record(record(context.paperclipWake).issue);
  const issueId = issue.id ?? wakeIssue.id;
  if (!identity(issueId) || (wakeIssue.id && wakeIssue.id !== issueId)) return null;
  const full = context.paperclipTaskMarkdownAssignment;
  const unchanged = context.paperclipTaskMarkdownAssignmentUnchanged;
  // Only the server's new projection contract opts in. Old saved sessions and
  // old context shapes continue with their original native session and full brief.
  if (typeof full !== "string" || !full.trim() || typeof unchanged !== "string" || !unchanged.trim()) return null;
  const assignmentHash = "sha256:" + createHash("sha256")
    .update(JSON.stringify([full.trim(), unchanged.trim()])).digest("hex");
  return { version: 1, ...scope, issueId, assignmentHash };
}

export function paperclipAssignmentReceiptMatches(
  context: Record<string, unknown> | null | undefined,
  scope: PaperclipAssignmentScope,
  previous: unknown,
): boolean {
  const before = normalizePaperclipAssignmentReceipt(previous);
  const current = createPaperclipAssignmentReceipt(context, scope);
  return Boolean(before && current && before.companyId === current.companyId &&
    before.agentId === current.agentId && before.sessionId === current.sessionId &&
    before.issueId === current.issueId && before.assignmentHash === current.assignmentHash);
}
