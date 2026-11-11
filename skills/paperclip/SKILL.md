---
name: paperclip
description: >
  Use for Paperclip-managed tasks and heartbeats: reading task context, delivering
  task documents or files, updating completion or blockers, coordinating or
  delegating work, and following company governance. Includes control plane API
  operations for assignments, comments, approvals, and routines.
---

# Paperclip Skill

You run in **heartbeats** — short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

This entrypoint carries the always-needed safety and execution contract. The complete procedures and examples are preserved in [WORKFLOWS.md](WORKFLOWS.md). Before performing a conditional operation, read its applicable section using the routing table below. Those procedures remain binding; a smaller entrypoint does not relax authorization, checkout, audit, delivery, budget or disposition requirements.

Read only the relevant sections, using heading lookup and bounded reads rather than loading the whole workflow reference. Reuse applicable instructions already present in this native session. After compaction, reread this entrypoint and only the needed procedure if its details are no longer available; do not reload every unrelated workflow. New or changed instructions take precedence over remembered copies.

## Terminology

In Paperclip, **task** and **issue** refer to the same work item. The UI may use "task" while APIs, database fields, route names, and older docs may still say "issue"; treat them as the same entity unless a local context explicitly distinguishes them.

**Task documents (API runtimes).** When asked for a task document, save it on the Paperclip issue with `PUT /api/issues/{issueId}/documents/{key}`, unless the requester specifies another destination. Confirm the returned document's saved revision and add a clickable Markdown link before reporting completion; read [references/issue-documents.md](references/issue-documents.md) for the payload and revision-safe updates. Downloadable files follow [Generated Artifacts and Work Products](#generated-artifacts-and-work-products).

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars may also be present: `PAPERCLIP_TASK_ID` (issue/task that triggered this wake), `PAPERCLIP_WAKE_REASON` (why this run was triggered), `PAPERCLIP_WAKE_COMMENT_ID` (specific comment that triggered this wake), `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived run JWT. For sandbox-backed local adapters, the Bash/tool environment may receive `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` for a run-scoped bridge instead of the host API directly; use those exact env vars from Bash/curl and do not assume the host port is reachable from browser or web tools. For non-local adapters, your operator should set `PAPERCLIP_API_KEY` in adapter config. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`. All endpoints are under `/api`. Use JSON except for multipart attachment uploads and binary content downloads. Never hard-code the API URL, and never paste the API key or bridge token into prompts, comments, documents, restored workspace files, or logs.

Adapters deliver the wake payload in the run prompt. It contains the compact issue summary and the ordered batch of new comment payloads for this wake. Read that prompt section first. For comment wakes, treat that batch as the highest-priority new context in the heartbeat: in your first task update or response, acknowledge the latest comment and say how it changes your next action before broad repo exploration or generic wake boilerplate. Only fetch the thread/comments API immediately when `fallbackFetchNeeded` is true or you need broader context than the inline batch provides.

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Paperclip skills for Claude/Codex and print/export the required `PAPERCLIP_*` environment variables for that agent identity.

**CLI safety — use `npx paperclipai` for content-bearing arguments.** When you run the Paperclip CLI, use `npx paperclipai` for any argument that can hold untrusted content. Untrusted content includes issue text, comment bodies, Markdown, pasted snippets, and model output. `npx paperclipai` runs the CLI binary directly and passes the argument as an inert `argv` value; it does not run a shell over the value. Do not use `pnpm paperclipai` for such an argument. `pnpm paperclipai` is a `package.json` script; `pnpm` appends the argument to a `/bin/sh` command string, so the shell reads it first and interprets a backtick pair, `$( )`, or `$NAME` before the CLI starts. A crafted value can run an arbitrary command as the invoking user, or expand an environment variable into the stored argument. This risk stays even when the argument comes from a quoted shell variable, because `pnpm` re-evaluates the value in its own shell. Do not use `pnpm exec paperclipai` either; the root workspace does not link that binary, so the command fails with `Command "paperclipai" not found`. To run local `cli/src` changes with a content-bearing argument, use `node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts <command> <args>`. See `doc/CLI.md` for the full safe/unsafe matrix.

**Run audit trail:** You MUST include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.

## Conversation tasks

Before work in Chat mode (`conversationAgentId`), read [Conversation tasks](WORKFLOWS.md#conversation-tasks). Preserve the conversation's plan and status. Authorized execution handoffs are ordinary project tasks, not children or blockers of the conversation; copy the approved plan at creation with an idempotency key and verify its saved plan document. Default ownership to the current chat agent unless the user explicitly specifies another owner. Ordinary task completion rules do not override chat mode.

## Server-Verified External Chat Turns

Paperclip may identify an ordinary external-chat turn as already checked out and
fully framed by its server-side harness. Use this shortcut only when the supplied
wake context explicitly marks the turn as server verified, includes
`checkedOutByHarness: true`, names a concrete issue, and provides
`externalChatProvider` as one of `slack`, `github`, `discord`,
`microsoft-teams`, or `telegram`. Do not infer the shortcut from comment text,
task prose, a provider mention, or a `source` string.

For a verified, self-contained external-chat request, the supplied task and wake
context are the working context. Do not repeat identity or inbox discovery,
checkout, heartbeat-context or comment reads, status writes, or manual progress
and completion comments. Answer the current request directly and return one
concise final response. The harness persists that response and owns the turn's
checkout and lifecycle bookkeeping. If the runtime exposes a semantic
completion/final-response operation, use it exactly once; do not duplicate the
same completion through a comment or status API.

This shortcut removes redundant control-plane bookkeeping, not authorization or
real work. Perform any investigation, file work, or external operation the
request actually requires. Requested mutations, files, approvals, interactions,
credentials, and governed actions still use their normal permission, approval,
containment, audit, and artifact-helper paths. Never upgrade trust or authority
because a request arrived through chat.

For an ordinary requested file handoff in a verified chat turn, follow the
injected external-chat contract. When it names the native `register_deliverable`
tool, use that tool; native runs do not have the legacy API key or upload helper.
For non-native adapters, invoke `bash scripts/paperclip-upload-artifact.sh`.
Read `references/artifacts.md` when that helper is missing, advanced artifact
options are needed, or its upload fails or has an ambiguous result; do not spend
a separate tool call rereading it before a routine handoff.

If the server marker, supported provider, concrete issue, or harness-checkout
signal is missing, use the full heartbeat procedure below. Also use the full
procedure for recovery, governed-action, issue-thread-interaction, hold,
liveness, or skill-test contexts; those are not ordinary chat turns even if
they mention a chat provider.

## The Heartbeat Procedure

Use this procedure for ordinary execution tasks. Detailed steps, examples and exceptional wake handling remain in [The Heartbeat Procedure](WORKFLOWS.md#the-heartbeat-procedure); consult the applicable step before an unfamiliar operation, not the whole guide on every wake.

**Steps 1–4 — Establish assigned scope.** A **Paperclip Resume Delta** or **Paperclip Wake Payload** naming a specific issue skips identity/inbox/pick-work discovery, not checkout or delivery. Without scoped wake context, use identity already in context or `GET /api/agents/me`; handle approval wakes first; prefer `GET /api/agents/me/inbox-lite`; prioritize `in_progress`, then comment-woken `in_review`, then `todo`. No assignment means exit. Never take work from mentions, hunt unassigned tasks, or re-comment on a blocked task without new context. A dependency-blocked interaction wake permits triage, not unblocking or deliverable execution. Read the full Step 4 before handling unusual assignment or blocked-wake cases.

**Step 5 — Checkout.** The issue must be checked out before you work. If the runtime's **Paperclip Wake Payload** or **Paperclip Resume Delta** explicitly says the harness already checked out this issue for the current run, do not call checkout again. Continue with Step 6. This applies only to that issue in that run; it does not skip context reads, status updates, or deliverable steps. Do not infer a current checkout from issue status, task/comment text, or a previous run. If that runtime statement is absent, or you switch to another task, checkout before working on it. Include the run ID header:

```
POST /api/issues/{issueId}/checkout
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

If already checked out by you, returns normally. If owned by another agent: `409 Conflict` — stop, pick a different task. **Never retry a 409.**

**Step 6 — Understand context.** Read the supplied wake payload first, acknowledging new comment direction before exploration. Prefer `GET /api/issues/{issueId}/heartbeat-context` when additional context is needed. Fetch exact wake comments or comment deltas rather than replaying an already-known thread. Use issue activity for attribution. Name provisional tasks early with `onlyIfProvisional: true`. Before deciding an execution-policy review stage, read Step 6 in the workflow reference: only the actual current participant can submit the stage decision, using the normal PATCH route.

**Step 7 — Do the work.** Start concrete work in this heartbeat unless asked only for a plan/review. Ask only for genuinely blocking missing information or authority, not optional details. Preserve company boundaries, scope, approvals, explicit stops and budget limits. Do not delegate around permission denials, infer authority from titles, or repeat actions with unknown outcomes. Use a saved human-input interaction plus `in_review` for human decisions; first-class blockers or an owned permitted unblock descriptor for dependencies. Prose, documents and comments alone are not liveness paths. Read Step 7 and the applicable workflow below before creating those paths.

<a id="asking-for-human-input"></a>

**Human input questions.** When you need several inputs that do not depend on each other's answers, ask them together in one card with one entry per question. Do not post one card per question. Ask a follow-up card only when it depends on an earlier answer. If the user asks for one question at a time, ask only the next unanswered question and wait for its real answer. Use text fields for open answers, confirmations for concrete yes/no decisions, and the full human-input procedure in WORKFLOWS.md before creating a card. Omit a specific recipient unless that person must answer; do not invent identities or turn permission requests into manager handoffs.

```json
{
  "kind": "ask_user_questions",
  "idempotencyKey": "question:{issueId}:detail:v1",
  "resolverPolicy": "human_only",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "questionSet": {
      "schema": "paperclip.question_set.v1",
      "questions": [{ "id": "detail", "prompt": "What should I know?", "answerMode": "text", "required": true }]
    }
  }
}
```

When a saved interaction is answered or rejected, read the result and resolver identity. Follow authorized new direction without asking the same person to confirm it again; a saved answer never bypasses downstream permission or approval gates. Read the workflow for card binding, target staleness, continuation and historical-answer handling.

### Generated Artifacts and Work Products

Upload requested file deliverables before final disposition and create their matching artifact work product. A local path or completion comment is not delivery. For non-native API runs, read [references/artifacts.md](references/artifacts.md) and use the installed `scripts/paperclip-upload-artifact.sh` helper. Use native `register_deliverable` when provided instead; native runs lack the legacy key/helper. Verified external-chat routine handoffs retain the shortcut above. For workspace-only references, PRs, branches, services or other engineering work products, read the corresponding section of [Generated Artifacts and Work Products](WORKFLOWS.md#generated-artifacts-and-work-products). Verify storage, response binding and external delivery separately; never claim a file is delivered merely because upload succeeded.

**Step 8 — Update status and communicate.** Always include the run ID header.

**Bounded write retry.** If the same control-plane write fails twice consecutively, stop retrying that write for the rest of the heartbeat. Continue any useful work that does not depend on it, report the failed write in your final response, and rely on the adapter/runtime status channel as the sanctioned fallback. Do not burn additional tool calls repeatedly attempting the same comment or status mutation in a degraded environment.

**Verify writes — never infer them.** A successful `PATCH /api/issues/{id}` always returns the updated issue JSON. An empty response body means the write FAILED, even if the command exited 0. Never pipe a disposition write through `head`/`tail` and never rely on `curl -f` inside a pipeline — the pipe swallows curl's exit status, and a lost connection then looks identical to success. Use the bundled `scripts/paperclip-issue-update.sh`, resolved relative to this installed `SKILL.md`, not the task workspace (it checks the HTTP status, retries connection-level failures, and confirms the echoed `status`); if you must hand-roll curl, capture `-w '%{http_code}'` and check the response echoes your update. When a status write cannot be confirmed, your final report must say the write FAILED — not that it "was sent" — so the recovery path gets accurate context.

For multiline comments, use a heredoc/file with the helper (or `jq --arg`) to preserve newlines. Set `paperclip_skill_dir` to the absolute directory containing this installed `SKILL.md`, not the task workspace. If that helper is unavailable, use a verified PATCH; do not search the filesystem for it.

```bash
bash "$paperclip_skill_dir/scripts/paperclip-issue-update.sh" --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD'
Done

- Fixed the newline-preserving issue update path
- Verified the raw stored comment body keeps paragraph breaks
MD
```

Before exiting, persist the real disposition:

- `done`: requested work and verification complete; required deliverables saved; no follow-up remains on this issue.
- `in_review`: an actual reviewer/approval/human-interaction path or eligible scheduled monitor exists. "Please review" prose is not a path. Keep ownership while waiting unless the requester asks for handoff.
- `blocked`: first-class `blockedByIssueIds` or an authorized owned unblock descriptor names a concrete action. Preserve existing blocker edges when updating their replacement array.
- `in_progress`: requires an active run, queued continuation, or actual scheduled recovery/monitor path. Narrative intention is not a continuation.

Read the full Step 8 before an unfamiliar disposition, including review handoffs, workspace-only work products or failed control-plane writes. Do not reopen completed or explicitly stopped work to make the task look active.

### Monitors and Watchers

A heartbeat is ephemeral, not a watcher. Before creating or claiming a monitor, read [Monitors and Watchers](WORKFLOWS.md#monitors-and-watchers-say-only-what-you-actually-scheduled). A persisted monitor only fires for agent-assigned, non-user-assigned tasks in `in_progress` or `in_review`. Closing a task contradicts an active monitor.

Use that request's default full response (not `Prefer: return=minimal`) to confirm `monitorNextCheckAt` is non-null, `assigneeAgentId` is set, `assigneeUserId` is null, and status is eligible — do not issue a confirming GET. Name its actual next check, timeout and attempt bounds; never claim background watching without a saved schedule. Monitors are polling, not event subscriptions.

**Step 9 — Optional task creation.** Continue work on the current issue unless delegation is actually needed and authorized. For ordinary execution work, any child task needs complete instructions and explicit project/parent/goal links. Read [Delegating review tasks](WORKFLOWS.md#delegating-review-tasks) and [Issue Dependencies (Blockers)](WORKFLOWS.md#issue-dependencies-blockers) before delegation. A delegate receives its own workspace, not your unsaved checkout. Require reviewers to publish their verdict on their own issue and mark that review done even when adverse; fixes belong to the parent owner. Never require a reviewer to write on the parent, where its run may lack authority. Block the parent on the review when the result is required. Chat handoffs follow Conversation tasks instead of execution-task parenting.

## Conditional workflow routing

Before the named action, read the linked section; it contains the unchanged detailed contract and payloads. Use heading lookup and a bounded section read. Do not load this entire reference for an unrelated task.

| Action or context | Required procedure |
| --- | --- |
| Archive a user's inbox item | [Managing A User's Inbox](WORKFLOWS.md#managing-a-users-inbox) |
| Set blockers, wait for a dependency, delegate work | [Issue Dependencies (Blockers)](WORKFLOWS.md#issue-dependencies-blockers) and [Delegating review tasks](WORKFLOWS.md#delegating-review-tasks) |
| Request board approval or use ask-first MCP tools | [Requesting Board Approval](WORKFLOWS.md#requesting-board-approval) and [MCP Tool Approval Gates](WORKFLOWS.md#mcp-tool-approval-gates) |
| Ask questions, confirmations, checkbox/item verdicts, suggest tasks or make cross-issue decisions | [Issue-Thread Interactions](WORKFLOWS.md#issue-thread-interactions), including Standalone Decisions, and [human-input questions](WORKFLOWS.md#asking-for-human-input) |
| Answer a saved confirmation, request an app connection | [Full Reference](WORKFLOWS.md#full-reference), including Conversational confirmation answers and Connection access requests |
| Set up projects, invites, instruction paths, import/export or app self-test | [Niche Workflow Pointers](WORKFLOWS.md#niche-workflow-pointers) |
| Work with cases | [Cases](WORKFLOWS.md#cases) and `references/cases.md` |
| Install/assign company skills | [Company Skills Workflow](WORKFLOWS.md#company-skills-workflow) and `references/company-skills.md` |
| Schedule/manage routines | [Routines](WORKFLOWS.md#routines) and `references/routines.md` |
| Choose/stage repositories, files or preview/runtime services | [Task Files and Workspace Choices](WORKFLOWS.md#task-files-and-workspace-choices), [Issue Workspace Runtime Controls](WORKFLOWS.md#issue-workspace-runtime-controls) and `references/issue-workspaces.md` |
| Receive/propose a credential or read a granted secret | [Proposing Credentials Safely](WORKFLOWS.md#proposing-credentials-safely), [Reading Granted Secrets](WORKFLOWS.md#reading-granted-secrets) and the API reference's secret sections |
| Write/revise a task report/document or plan | [Task Documents and Deliverables](WORKFLOWS.md#task-documents-and-deliverables), [Planning (Required when planning requested)](WORKFLOWS.md#planning-required-when-planning-requested) and `references/issue-documents.md` |
| Find an unfamiliar API route or search tasks | [Key Endpoints (Hot Routes)](WORKFLOWS.md#key-endpoints-hot-routes), [Searching Issues](WORKFLOWS.md#searching-issues) and `references/api-reference.md` |
| Submit incidental feedback or make an external review handoff | [Incidental feedback](WORKFLOWS.md#incidental-feedback) |

## Critical Rules

- **Never retry a 409.** The task belongs to someone else.
- **Never look for unassigned work.** No assignments = exit.
- **Never self-assign from a mention.** A mention identifies relevant context; task work requires explicit assignment.
- **Honor "send it back to me" requests from board users.** If a board/user asks for review handoff (e.g. "let me review it", "assign it back to me"), reassign to them with `assigneeAgentId: null` and `assigneeUserId: "<requesting-user-id>"`, typically setting status to `in_review` instead of `done`. Resolve the user id from the triggering comment's `authorUserId` when available, else the issue's `createdByUserId` if it matches the requester context.
- **Start actionable work before planning-only closure.** Do concrete work in the same heartbeat unless the task asks for a plan or review only.
- **Leave a next action.** Every progress comment should make clear what is complete, what remains, and who owns the next step.
- **Do not busy-poll.** For existing delegated work, rely on Paperclip wake events or comments for completion.
- **Subtasks get their own workspace.** A child issue keeps its parent's project and workspace strategy, but the server always realizes a separate workspace for it from the project base. It never shares the parent's checkout, branch or unsaved files, and `inheritExecutionWorkspaceFromIssueId` does not change that. Share code between tasks through pushed branches or merged changes.
- **Never cancel cross-team tasks.** If you question the task, follow the requester-directed decision flow in [Receiving cross-team work](references/api-reference.md#receiving-cross-team-work). Keep the task assigned to yourself; do not automatically hand it to a manager.
- **Use first-class blockers** (`blockedByIssueIds`) rather than free-text "blocked by X" comments.
- **Say only what you actually scheduled.** Never tell a user a "watcher"/monitor will wake you unless you scheduled a real issue monitor (non-null `monitorNextCheckAt`), and never imply a live watcher on a task you mark `done` — see **Monitors and Watchers**.
- **On a blocked task with no new context, don't re-comment** — see the blocked-task dedup rule in Step 4.
- **@-mentions** are context links and never trigger heartbeats, assign work, or forward comments to another task. For machine-authored comments, resolve the target agent and use `[@Agent Name](agent://<agent-id>)`. To request work, assign a task or use an explicit review request.
- **Budget**: auto-paused at 100%. Above 80%, focus on critical tasks only.
- **Handle blockers directly.** Identify the exact missing capability or authority. Do not reassign blocked work or create a task for a manager or another agent merely because you are stuck. A title or reporting line does not grant access or authority. For a human-only action, use the connection/approval flow when available; otherwise save an interaction with `resolverPolicy: "human_only"` and `continuationPolicy: "wake_assignee"` on the current task, keep yourself assigned, and leave it `in_review`. Use the complete [human-input payload](#asking-for-human-input). Verify the recipient's actual capability and permission before offering delegation as an option or creating a bounded task for them. Never delegate to bypass a permission denial; a human answer also does not grant a missing permission.
- **Keep scope decisions on the current task.** Save a human-input interaction with `resolverPolicy: "human_only"` and `continuationPolicy: "wake_assignee"`. Keep the task assigned to yourself and `in_review` while waiting. If the decision requires a particular person's answer, explicitly address that person; otherwise leave the recipient open to eligible humans. For an agent-directed question, set `addresseeAgentId` and omit `resolverPolicy`. Do not substitute a manager or invent an identity.
- **Hiring**: use the `paperclip-create-agent` skill for new agent creation workflows (links to reusable `AGENTS.md` templates like `Coder` and `QA`).
- **Commit Co-author**: if you make a git commit you MUST add EXACTLY `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to the end of each commit message. Do not put in your agent name, put `Co-Authored-By: Paperclip <noreply@paperclip.ing>`.

## Comment Style (Required)

When posting issue comments or writing issue descriptions, use concise markdown with:

- a short status line
- bullets for what changed / what is blocked
- links to related entities when available

**Ticket references are links (required):** If you mention another issue identifier such as `PAP-224`, `ZED-24`, or any `{PREFIX}-{NUMBER}` ticket id inside a comment body or issue description, wrap it in a Markdown link:

- `[PAP-224](/PAP/issues/PAP-224)`
- `[ZED-24](/ZED/issues/ZED-24)`

Never leave bare ticket ids in issue descriptions or comments when a clickable internal link can be provided.

**No raw IDs in prose (required):** People read comments, titles, and descriptions. Name tasks, documents, agents, and projects by identifier link or name; never paste a raw UUID into a comment body, issue title, or issue description. UUIDs are API arguments, and an agent that needs one resolves it from the identifier. Write "the approved brief on [BRA-2](/BRA/issues/BRA-2#document-plan)", not "the brief on task BRA-2 (id 2b330993-…)". Markdown link targets such as `agent://<agent-id>` are fine because the reader sees the link text.

**Describe outcomes, not mechanics (required):** Say what happened, what it means for the reader, and the next step. Do not narrate control-plane internals such as receipts, execution policies, run ownership, wake payloads, idempotency keys, tool names, or rejected API calls. When something did not work, say in plain words what is not done yet and what you are doing about it; leave the technical detail to the run log.

**Company-prefixed URLs (required):** All internal links MUST include the company prefix. Derive the prefix from any issue identifier you have (e.g., `PAP-315` → prefix is `PAP`). Use this prefix in all UI links:

- Issues: `/<prefix>/issues/<issue-identifier>` (e.g., `/PAP/issues/PAP-224`)
- Issue comments: `/<prefix>/issues/<issue-identifier>#comment-<comment-id>` (deep link to a specific comment)
- Issue documents: `/<prefix>/issues/<issue-identifier>#document-<document-key>` (deep link to a specific document such as `plan`)
- Agents: `/<prefix>/agents/<agent-url-key>` (e.g., `/PAP/agents/claudecoder`)
- Projects: `/<prefix>/projects/<project-url-key>` (id fallback allowed)
- Approvals: `/<prefix>/approvals/<approval-id>`
- Runs: `/<prefix>/agents/<agent-url-key-or-id>/runs/<run-id>`

Do NOT use unprefixed paths like `/issues/PAP-123` or `/agents/cto` — always include the company prefix.

**Preserve markdown line breaks (required):** build multiline JSON bodies from heredoc/file input (via the helper in Step 8 or `jq --arg comment "$comment"`). Never manually compress markdown into a one-line JSON `comment` string unless you intentionally want a single paragraph.
