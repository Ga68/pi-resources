import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CONFIRMATION_TYPE = "commit-tree-confirmation";
const STATUS_KEY = "commit-tree";
const WIDGET_KEY = "commit-tree";

type PushIntent = "explicit" | "ambiguous" | "none";

interface FinishCommitTreeDetails {
	repoPath: string;
	commitHash: string;
	subject: string;
	pushed: boolean;
	rationalePath?: string;
	notes?: string;
}

interface CommitStats {
	added: number;
	removed: number;
}

interface CommitTreeConfirmationDetails extends FinishCommitTreeDetails, CommitStats {
	confirmation: string;
	startLeaf: string;
	abandonedBranchLeaf?: string;
}

interface ActiveCommitTreeRun {
	startLeaf: string;
	pushIntent: PushIntent;
	pushAllowed: boolean;
	fallbackRepo?: string;
	fallbackBeforeHead?: string;
	finished?: FinishCommitTreeDetails;
	phase: string;
	agentEndPromise: Promise<void>;
	resolveAgentEnd: () => void;
}

let activeRun: ActiveCommitTreeRun | undefined;

function createAgentEndWaiter(timeoutMs = 30 * 60_000): { promise: Promise<void>; resolve: () => void } {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let resolveWaiter: () => void = () => {};
	const promise = new Promise<void>((resolve, reject) => {
		resolveWaiter = () => {
			if (timeout) clearTimeout(timeout);
			resolve();
		};
		timeout = setTimeout(() => reject(new Error("Timed out waiting for /commit-tree agent turn to finish.")), timeoutMs);
		timeout.unref?.();
	});
	return { promise, resolve: resolveWaiter };
}

function expandTilde(inputPath: string): string {
	return inputPath.startsWith("~/") ? path.join(os.homedir(), inputPath.slice(2)) : inputPath;
}

function textFromUnknown(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function classifyPushIntent(args: string): PushIntent {
	const text = args.trim().toLowerCase();
	if (!text) return "none";
	if (/\b(?:do not|don't|dont|no|skip|without)\s+(?:a\s+)?push(?:ing)?\b/.test(text)) return "none";
	if (/\bno-push\b/.test(text)) return "none";
	if (/\b(?:should\s+i|should\s+we|maybe|optionally)\s+push\b/.test(text)) return "ambiguous";
	if (/\bpush\s*\?/.test(text)) return "ambiguous";
	if (/^(?:please\s+)?push(?:\s+(?:it|changes?|the\s+commit))?(?:\s+please)?$/.test(text)) return "explicit";
	if (/\b(?:and|then|also)\s+push\b/.test(text)) return "explicit";
	if (/\bcommit\b[\s\S]{0,80}\band\s+push\b/.test(text)) return "explicit";
	if (/\bpush\s+(?:after|when|once)\b/.test(text)) return "explicit";
	if (/\bpush\s+(?:it|changes?|the\s+commit|to\s+\S+)/.test(text)) return "explicit";
	return /\bpush(?:ing)?\b/.test(text) ? "ambiguous" : "none";
}

function commandLooksLikeGitPush(command: string): boolean {
	return /(^|[;&|()\n]\s*)(?:env\s+(?:\S+=\S+\s+)*)?(?:command\s+)?(?:git|(?:\.{1,2}|\/)[^\s;&|()]*\/git)(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)|--namespace(?:=\S+|\s+\S+)|--exec-path(?:=\S+|\s+\S+)|--no-pager|--no-optional-locks|--literal-pathspecs|-p))*\s+push\b/i.test(command);
}

function isBashToolCall(event: ToolCallEvent): event is ToolCallEvent & { toolName: "bash"; input: { command?: string } } {
	return event.toolName === "bash";
}

function buildCommitTreePrompt(args: string, pushAllowed: boolean, pushIntent: PushIntent): string {
	const instructions = args.trim() || "(none)";
	return `You are running /commit-tree, an in-session commit workflow.

This is intentionally happening on a temporary conversation-tree branch. Your tool calls, inspection, rationale writing, and commit reasoning will remain on this branch. After you finish, the extension will navigate the user's active conversation back to the pre-commit tree node and append only a one-sentence confirmation there.

User /commit-tree instructions:
${instructions}

Push policy:
- pushAllowed = ${pushAllowed ? "true" : "false"}
- parsedPushIntent = ${pushIntent}
- If pushAllowed is true, push after the commit succeeds.
- If pushAllowed is false and parsedPushIntent is ambiguous, ask for explicit authorization with authorize_commit_tree_push before any git push.
- If pushAllowed is false and parsedPushIntent is none, do not push unless later steering clearly asks for push; then call authorize_commit_tree_push before any git push.
- Never infer push from context.

Responsibilities:
1. Infer what work should be committed from this conversation and repository state. The current Pi cwd may not be the target repo; use absolute paths and repository names from the conversation when needed.
2. Inspect git state as needed. Identify repo, scope, intended files, and rationale.
3. Do not commit unrelated dirty work. Do not commit secrets, credentials, or accidental local artifacts.
4. Stage only intended files and create the commit.
5. Usually create a rationale file in <repo>/.agents/commits/[isodt]-slug.md and commit it with the changes. Skip only for very small, obvious commits.
6. If a rationale file is created, make the commit body end with: For more details, see .agents/commits/<filename>.md.
7. Ask clarification with ask_commit_tree_user only when scope, repo, or safety is too ambiguous to proceed safely. Use authorize_commit_tree_push specifically for push authorization.
8. When complete, call finish_commit_tree exactly once with repoPath, commitHash, subject, pushed, and rationalePath if applicable.

Rationale guidance:
- Preserve relevant conclusions, user intent, tradeoffs, rejected alternatives, risks, and follow-up context that future maintainers could not recover from the diff or commit message.
- Do not include hidden chain-of-thought. Write useful decision context, not a generic template.

Commit message guidance:
- Use a concise imperative subject.
- Include a body when it helps explain rationale, scope, or safety.
- If a rationale file exists, the body must end with the exact details sentence above.

Begin now.`;
}

async function gitStdout(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
	const result = await pi.exec("git", args, { cwd });
	if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

async function resolveRepo(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	try {
		return await gitStdout(pi, cwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		return undefined;
	}
}

async function resolveHead(pi: ExtensionAPI, repo: string | undefined): Promise<string | undefined> {
	if (!repo) return undefined;
	try {
		return await gitStdout(pi, repo, ["rev-parse", "HEAD"]);
	} catch {
		return undefined;
	}
}

async function verifyCommit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	details: FinishCommitTreeDetails | undefined,
	fallback: { repo?: string; beforeHead?: string },
): Promise<FinishCommitTreeDetails> {
	let repoPath = details?.repoPath ? path.resolve(ctx.cwd, expandTilde(details.repoPath)) : fallback.repo;
	if (!repoPath) throw new Error("Commit-tree agent did not report a repository, and the current directory is not in a git repository.");
	repoPath = await gitStdout(pi, repoPath, ["rev-parse", "--show-toplevel"]);

	let commitHash = details?.commitHash;
	if (!commitHash) {
		const head = await resolveHead(pi, repoPath);
		if (head && head !== fallback.beforeHead) commitHash = head;
	}
	if (!commitHash) throw new Error("Commit-tree agent did not report a commit hash and no new HEAD commit was detected.");

	const fullHash = await gitStdout(pi, repoPath, ["rev-parse", `${commitHash}^{commit}`]);
	const subject = (await gitStdout(pi, repoPath, ["show", "-s", "--format=%s", fullHash])) || details?.subject || fullHash.slice(0, 12);
	return {
		repoPath,
		commitHash: fullHash,
		subject,
		pushed: details?.pushed === true,
		rationalePath: details?.rationalePath,
		notes: details?.notes,
	};
}

async function getCommitStats(pi: ExtensionAPI, commit: FinishCommitTreeDetails): Promise<CommitStats> {
	const output = await gitStdout(pi, commit.repoPath, ["show", "--numstat", "--format=", "--no-renames", commit.commitHash]);
	let added = 0;
	let removed = 0;
	for (const line of output.split("\n")) {
		const [a, r] = line.split("\t");
		if (!a || !r || a === "-" || r === "-") continue;
		const add = Number.parseInt(a, 10);
		const rem = Number.parseInt(r, 10);
		if (Number.isFinite(add)) added += add;
		if (Number.isFinite(rem)) removed += rem;
	}
	return { added, removed };
}

function formatConfirmation(commit: FinishCommitTreeDetails, stats: CommitStats): string {
	return `Committed "${commit.subject}"${commit.pushed ? " and pushed" : ""} (+${stats.added} -${stats.removed}).`;
}

function extractFinishDetailsFromBranch(entries: readonly unknown[]): FinishCommitTreeDetails | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; message?: unknown };
		const message = (entry?.type === "message" ? entry.message : entry) as { role?: string; toolName?: string; details?: unknown };
		if (message?.role === "toolResult" && message.toolName === "finish_commit_tree" && message.details) {
			return message.details as FinishCommitTreeDetails;
		}
	}
	return undefined;
}

function phaseForTool(toolName: string, args: Record<string, unknown> | undefined): string | undefined {
	if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") return "inspecting files";
	if (toolName === "write" || toolName === "edit") {
		const p = String(args?.path ?? args?.file_path ?? "");
		return p.includes(".agents/commits") ? "writing rationale" : "updating files";
	}
	if (toolName === "ask_commit_tree_user") return "waiting for clarification";
	if (toolName === "authorize_commit_tree_push") return "waiting for push authorization";
	if (toolName === "finish_commit_tree") return "finalizing";
	if (toolName === "bash") {
		const command = String(args?.command ?? "");
		if (/git\s+status\b/i.test(command)) return "inspecting git state";
		if (/git\s+(?:diff|show|log)\b/i.test(command)) return "reviewing diff";
		if (/git\s+add\b/i.test(command)) return "staging files";
		if (/git\s+commit\b/i.test(command)) return "committing";
		if (commandLooksLikeGitPush(command)) return "pushing";
		return "running checks";
	}
	return undefined;
}

function setRunPhase(ctx: { hasUI: boolean; ui: ExtensionCommandContext["ui"] }, phase: string): void {
	if (!activeRun) return;
	activeRun.phase = phase;
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, `commit-tree: ${phase}`);
	ctx.ui.setWidget(WIDGET_KEY, [
		`/commit-tree: ${phase}`,
		"Commit work is being recorded on an abandoned conversation-tree branch.",
	], { placement: "aboveEditor" });
}

function clearRunUi(ctx: { hasUI: boolean; ui: ExtensionCommandContext["ui"] }): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

async function rollbackToStart(ctx: ExtensionCommandContext, startLeaf: string): Promise<void> {
	if (ctx.sessionManager.getLeafId() === startLeaf) return;
	await ctx.navigateTree(startLeaf, { summarize: false });
}

export default function registerCommitTreeExtension(pi: ExtensionAPI): void {
	pi.on("agent_end", () => {
		activeRun?.resolveAgentEnd();
	});

	pi.registerMessageRenderer<CommitTreeConfirmationDetails | { error?: string }>(CONFIRMATION_TYPE, (message, _options, theme) => {
		const text = typeof message.content === "string" ? message.content : "";
		const isError = Boolean((message.details as { error?: string } | undefined)?.error) || text.startsWith("Commit-tree failed:");
		return new Text(`${isError ? theme.fg("error", "✗") : theme.fg("success", "✓")} ${text}`, 0, 0);
	});

	pi.on("tool_call", (event) => {
		if (!activeRun || activeRun.pushAllowed || !isBashToolCall(event)) return undefined;
		const command = event.input.command ?? "";
		if (!commandLooksLikeGitPush(command)) return undefined;
		return {
			block: true,
			reason: "Blocked by /commit-tree push policy: push was not explicitly authorized for this workflow.",
		};
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (!activeRun) return;
		const phase = phaseForTool(event.toolName, event.args);
		if (phase) setRunPhase(ctx, phase);
	});

	pi.registerTool({
		name: "ask_commit_tree_user",
		label: "Ask Commit Tree User",
		description: "Ask the user a clarification question required to safely complete the /commit-tree workflow.",
		promptSnippet: "Ask the user for commit-tree scope clarification",
		promptGuidelines: ["Use ask_commit_tree_user only when committing safely requires user clarification."],
		executionMode: "sequential",
		parameters: Type.Object({
			question: Type.String({ description: "Clear question for the user" }),
			context: Type.Optional(Type.String({ description: "Short context explaining why the question is needed" })),
			defaultAnswer: Type.Optional(Type.String({ description: "Optional suggested/default answer" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!activeRun) {
				return { content: [{ type: "text", text: "No active /commit-tree run. Stop and explain the issue." }], details: { answer: null } };
			}
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "No interactive UI is available. Decide conservatively; do not commit unsafe or ambiguous work." }],
					details: { question: params.question, answer: null },
				};
			}
			if (params.context?.trim()) ctx.ui.notify(params.context.trim(), "info");
			const answer = await ctx.ui.input(params.question, params.defaultAnswer);
			if (!answer?.trim()) {
				return {
					content: [{ type: "text", text: "The user did not provide an answer. Proceed conservatively or stop if unsafe." }],
					details: { question: params.question, answer: null },
				};
			}
			return {
				content: [{ type: "text", text: `User answered:\n${answer.trim()}` }],
				details: { question: params.question, answer: answer.trim() },
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("ask_commit_tree_user "))}${theme.fg("muted", textFromUnknown(args.question))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "";
			return new Text(theme.fg("accent", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "authorize_commit_tree_push",
		label: "Authorize Commit Tree Push",
		description: "Ask the user for explicit authorization to push in this /commit-tree workflow.",
		promptSnippet: "Ask for explicit authorization before pushing in commit-tree",
		promptGuidelines: ["Call authorize_commit_tree_push before git push unless push was already explicitly authorized by the /commit-tree invocation."],
		executionMode: "sequential",
		parameters: Type.Object({
			reason: Type.String({ description: "Why pushing may be appropriate or requested" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!activeRun) {
				return { content: [{ type: "text", text: "No active /commit-tree run, so push is not authorized." }], details: { authorized: false } };
			}
			if (activeRun.pushAllowed) {
				return {
					content: [{ type: "text", text: "Push is already authorized for this /commit-tree workflow." }],
					details: { authorized: true, alreadyAuthorized: true },
				};
			}
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "No interactive UI is available, so push is not authorized. Commit without pushing." }],
					details: { authorized: false },
				};
			}
			const confirmed = await ctx.ui.confirm("Authorize /commit-tree push?", `${params.reason}\n\nPush after the commit succeeds?`);
			activeRun.pushAllowed = confirmed;
			return confirmed
				? { content: [{ type: "text", text: "User explicitly authorized push for this /commit-tree workflow." }], details: { authorized: true } }
				: { content: [{ type: "text", text: "User did not authorize push. Commit without pushing." }], details: { authorized: false } };
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("authorize_commit_tree_push "))}${theme.fg("muted", textFromUnknown(args.reason))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "";
			return new Text(theme.fg("accent", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "finish_commit_tree",
		label: "Finish Commit Tree",
		description: "Report the completed /commit-tree workflow. Call exactly once after the commit is complete, and after push if push was explicitly authorized.",
		promptSnippet: "Finish the commit-tree workflow with structured commit metadata",
		promptGuidelines: ["Call finish_commit_tree exactly once after creating the commit and completing any authorized push."],
		executionMode: "sequential",
		parameters: Type.Object({
			repoPath: Type.String({ description: "Repository path where the commit was created" }),
			commitHash: Type.String({ description: "Full or short git commit hash that was created" }),
			subject: Type.String({ description: "Commit subject" }),
			pushed: Type.Boolean({ description: "Whether the commit was pushed" }),
			rationalePath: Type.Optional(Type.String({ description: "Committed rationale file path, if one was created" })),
			notes: Type.Optional(Type.String({ description: "Any concise notes, warnings, or follow-ups" })),
		}),
		async execute(_toolCallId, params) {
			if (!activeRun) throw new Error("No active /commit-tree run.");
			if (params.pushed && !activeRun.pushAllowed) {
				throw new Error("finish_commit_tree reported pushed=true, but push was not explicitly authorized for this /commit-tree workflow.");
			}
			activeRun.finished = {
				repoPath: params.repoPath,
				commitHash: params.commitHash,
				subject: params.subject,
				pushed: params.pushed,
				rationalePath: params.rationalePath,
				notes: params.notes,
			};
			return {
				content: [{ type: "text", text: `Commit-tree workflow complete: ${params.subject} (${params.commitHash})${params.pushed ? " and pushed" : ""}.` }],
				details: activeRun.finished,
				terminate: true,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("finish_commit_tree")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "Commit-tree workflow complete.";
			return new Text(theme.fg("success", `✓ ${text}`), 0, 0);
		},
	});

	pi.registerCommand("commit-tree", {
		description: "Run commit workflow on an abandoned conversation-tree branch",
		handler: async (args, ctx) => {
			if (activeRun) {
				ctx.ui.notify("A /commit-tree run is already active.", "warning");
				return;
			}

			const startLeaf = ctx.sessionManager.getLeafId();
			if (!startLeaf) {
				ctx.ui.notify("/commit-tree needs an existing conversation node to roll back to. Send one normal message first, or use /commit instead.", "error");
				return;
			}

			const pushIntent = classifyPushIntent(args);
			const agentEndWaiter = createAgentEndWaiter();
			activeRun = {
				startLeaf,
				pushIntent,
				pushAllowed: pushIntent === "explicit",
				phase: "starting",
				agentEndPromise: agentEndWaiter.promise,
				resolveAgentEnd: agentEndWaiter.resolve,
			};

			try {
				setRunPhase(ctx, "starting");
				activeRun.fallbackRepo = await resolveRepo(pi, ctx.cwd);
				activeRun.fallbackBeforeHead = await resolveHead(pi, activeRun.fallbackRepo);

				pi.sendUserMessage(buildCommitTreePrompt(args, activeRun.pushAllowed, pushIntent));
				await activeRun.agentEndPromise;

				setRunPhase(ctx, "verifying commit");
				const abandonedBranchLeaf = ctx.sessionManager.getLeafId() ?? undefined;
				const reported = activeRun.finished ?? extractFinishDetailsFromBranch(ctx.sessionManager.getBranch());
				const commit = await verifyCommit(pi, ctx, reported, {
					repo: activeRun.fallbackRepo,
					beforeHead: activeRun.fallbackBeforeHead,
				});
				if (pushIntent === "explicit" && !commit.pushed) {
					throw new Error("Push was explicitly requested, but the /commit-tree agent did not report a successful push.");
				}
				const stats = await getCommitStats(pi, commit);
				const confirmation = formatConfirmation(commit, stats);

				if (abandonedBranchLeaf && abandonedBranchLeaf !== startLeaf) {
					pi.setLabel(abandonedBranchLeaf, `commit: ${commit.subject}`);
				}

				setRunPhase(ctx, "rolling back conversation tree");
				await rollbackToStart(ctx, startLeaf);
				pi.sendMessage<CommitTreeConfirmationDetails>({
					customType: CONFIRMATION_TYPE,
					content: confirmation,
					display: true,
					details: { ...commit, ...stats, confirmation, startLeaf, abandonedBranchLeaf },
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const failedLeaf = ctx.sessionManager.getLeafId() ?? undefined;
				if (failedLeaf && failedLeaf !== startLeaf) {
					try {
						pi.setLabel(failedLeaf, "failed commit-tree run");
					} catch {
						// ignore label failure
					}
				}
				try {
					await rollbackToStart(ctx, startLeaf);
				} catch (rollbackError) {
					const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
					pi.sendMessage({
						customType: CONFIRMATION_TYPE,
						content: `Commit-tree failed and rollback failed: ${message} (${rollbackMessage})`,
						display: true,
						details: { error: message, rollbackError: rollbackMessage, startLeaf, failedLeaf },
					});
					return;
				}
				pi.sendMessage({
					customType: CONFIRMATION_TYPE,
					content: `Commit-tree failed: ${message}`,
					display: true,
					details: { error: message, startLeaf, failedLeaf },
				});
				if (ctx.hasUI) ctx.ui.notify(`Commit-tree failed: ${message}`, "error");
			} finally {
				clearRunUi(ctx);
				activeRun = undefined;
			}
		},
	});
}
