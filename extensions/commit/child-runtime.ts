import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

let pushAllowed = process.env.PI_COMMIT_PUSH_ALLOWED === "1";
const COMMIT_CHILD = process.env.PI_COMMIT_CHILD === "1";

const COMMIT_BOUNDARY = `You are the isolated /commit child agent.

Your only job is to complete the commit workflow requested by the parent Pi session. The parent session owns normal conversation, orchestration, and follow-up work. Keep commit-related inspection, staging, rationale writing, committing, and optional pushing inside this child session.

Do not propose or run subagents. Do not expose hidden reasoning. If you need non-push user input to proceed safely, call ask_commit_user. If you need explicit push authorization, call authorize_commit_push. When the workflow is complete, call finish_commit exactly once with the actual repository path, commit hash, subject, and whether you pushed.`;

const PARENT_ONLY_CUSTOM_TYPES = new Set([
	"commit-confirmation",
	"commit-progress",
	"commit-status",
]);

function textFromUnknown(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function stripParentOnlyCommitMessages(messages: unknown[]): unknown[] {
	let changed = false;
	const filtered: unknown[] = [];
	for (const message of messages) {
		const msg = message as { role?: string; customType?: string; toolName?: string; content?: unknown };
		if (msg?.role === "custom" && msg.customType && PARENT_ONLY_CUSTOM_TYPES.has(msg.customType)) {
			changed = true;
			continue;
		}
		filtered.push(message);
	}
	return changed ? filtered : messages;
}

function commandLooksLikeGitPush(command: string): boolean {
	// Match git's subcommand position after common global options, without blocking
	// unrelated commands such as `git commit -m "mention push"`.
	return /(^|[;&|()\n]\s*)(?:env\s+(?:\S+=\S+\s+)*)?(?:command\s+)?(?:git|(?:\.{1,2}|\/)[^\s;&|()]*\/git)(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)|--namespace(?:=\S+|\s+\S+)|--exec-path(?:=\S+|\s+\S+)|--no-pager|--no-optional-locks|--literal-pathspecs|-p))*\s+push\b/i.test(command);
}

function isBashToolCall(event: ToolCallEvent): event is ToolCallEvent & { toolName: "bash"; input: { command?: string } } {
	return event.toolName === "bash";
}

export default function registerCommitChildRuntime(pi: ExtensionAPI): void {
	if (!COMMIT_CHILD) return;

	pi.on("context", (event) => {
		const messages = stripParentOnlyCommitMessages(event.messages);
		if (messages === event.messages) return undefined;
		return { messages };
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${COMMIT_BOUNDARY}\n\nPush policy for this run: ${pushAllowed ? "Push has been explicitly authorized for this commit workflow, so pushing after a successful commit is allowed." : "Push has not been explicitly authorized. Do not run git push unless authorize_commit_push succeeds in this workflow."}\n\n${event.systemPrompt}`,
	}));

	pi.on("tool_call", (event) => {
		if (!pushAllowed && isBashToolCall(event)) {
			const command = event.input.command ?? "";
			if (commandLooksLikeGitPush(command)) {
				return {
					block: true,
					reason: "Blocked by /commit push policy: push was not explicitly authorized for this workflow.",
				};
			}
		}
		return undefined;
	});

	pi.registerTool({
		name: "ask_commit_user",
		label: "Ask Commit User",
		description: "Ask the user a clarification question required to safely complete the commit workflow. Use rarely; most commits should not need clarification.",
		promptSnippet: "Ask the user for commit-scope clarification",
		promptGuidelines: ["Use ask_commit_user only when committing safely requires user clarification."],
		executionMode: "sequential",
		parameters: Type.Object({
			question: Type.String({ description: "Clear question for the user" }),
			context: Type.Optional(Type.String({ description: "Short context explaining why the question is needed" })),
			defaultAnswer: Type.Optional(Type.String({ description: "Optional suggested/default answer" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
			return new Text(`${theme.fg("toolTitle", theme.bold("ask_commit_user "))}${theme.fg("muted", textFromUnknown(args.question))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "";
			return new Text(theme.fg("accent", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "authorize_commit_push",
		label: "Authorize Commit Push",
		description: "Ask the user for explicit authorization to push in this /commit workflow when push intent is ambiguous or arrives later as steering.",
		promptSnippet: "Ask for explicit authorization before pushing",
		promptGuidelines: ["Call authorize_commit_push before git push unless push was already explicitly authorized by the parent /commit invocation."],
		executionMode: "sequential",
		parameters: Type.Object({
			reason: Type.String({ description: "Why pushing may be appropriate or requested" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (pushAllowed) {
				return {
					content: [{ type: "text", text: "Push is already authorized for this workflow." }],
					details: { authorized: true, alreadyAuthorized: true },
				};
			}
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "No interactive UI is available, so push is not authorized. Commit without pushing." }],
					details: { authorized: false },
				};
			}
			const confirmed = await ctx.ui.confirm("Authorize /commit push?", `${params.reason}\n\nPush after the commit succeeds?`);
			pushAllowed = confirmed;
			return confirmed
				? {
						content: [{ type: "text", text: "User explicitly authorized push for this /commit workflow." }],
						details: { authorized: true },
				  }
				: {
						content: [{ type: "text", text: "User did not authorize push. Commit without pushing." }],
						details: { authorized: false },
				  };
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("authorize_commit_push "))}${theme.fg("muted", textFromUnknown(args.reason))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "";
			return new Text(theme.fg("accent", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "finish_commit",
		label: "Finish Commit",
		description: "Report the completed /commit workflow. Call exactly once after the commit is complete, and after push if push was explicitly requested.",
		promptSnippet: "Finish the isolated commit workflow with structured commit metadata",
		promptGuidelines: ["Call finish_commit exactly once after creating the commit and completing any allowed push."],
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
			if (params.pushed && !pushAllowed) {
				throw new Error("finish_commit reported pushed=true, but push was not explicitly authorized for this /commit workflow.");
			}
			return {
				content: [{ type: "text", text: `Commit workflow complete: ${params.subject} (${params.commitHash})${params.pushed ? " and pushed" : ""}.` }],
				details: {
					repoPath: params.repoPath,
					commitHash: params.commitHash,
					subject: params.subject,
					pushed: params.pushed,
					rationalePath: params.rationalePath,
					notes: params.notes,
				},
				terminate: true,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("finish_commit")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "Commit workflow complete.";
			return new Text(theme.fg("success", `✓ ${text}`), 0, 0);
		},
	});
}
