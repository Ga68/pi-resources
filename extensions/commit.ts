import {
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");

type CommitResult =
	| {
			status: "committed";
			subject: string;
			repo: string;
			pushed?: boolean;
			rationalePath?: string;
			summary?: string;
	  }
	| {
			status: "needs_clarification";
			reason?: string;
			questions: string[];
	  }
	| {
			status: "failed";
			reason: string;
	  };

function makeCommitResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => COMMIT_AGENT_SYSTEM_PROMPT,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

async function configuredPackagePaths(): Promise<string[]> {
	try {
		const settings = JSON.parse(await readFile(join(AGENT_DIR, "settings.json"), "utf8")) as { packages?: unknown[] };
		return (settings.packages ?? [])
			.map((pkg) => {
				if (typeof pkg === "string") return pkg;
				if (pkg && typeof pkg === "object" && typeof (pkg as { source?: unknown }).source === "string") {
					return (pkg as { source: string }).source;
				}
				return undefined;
			})
			.filter((source): source is string => Boolean(source))
			.filter((source) => !source.startsWith("npm:") && !source.startsWith("git:"))
			.map((source) => resolve(AGENT_DIR, source));
	} catch {
		return [];
	}
}

function parseJsonResult(output: string): CommitResult {
	const trimmed = output.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
	const candidate = fenced ?? trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
	try {
		const parsed = JSON.parse(candidate) as CommitResult;
		if (parsed && typeof parsed === "object" && "status" in parsed) return parsed;
	} catch {
		// Fall through.
	}
	return { status: "failed", reason: trimmed || "Commit agent returned no result" };
}

function progressFromTool(toolName: string, args: Record<string, unknown>): string | undefined {
	if (toolName === "bash") {
		const command = String(args.command ?? "");
		if (/git\s+status/.test(command)) return "inspecting working tree";
		if (/git\s+diff/.test(command)) return "reviewing changes";
		if (/git\s+add/.test(command)) return "staging selected changes";
		if (/git\s+commit/.test(command)) return "creating commit";
		if (/git\s+push/.test(command)) return "pushing commit";
		if (/git\s+rev-parse|git\s+branch|git\s+remote/.test(command)) return "checking repository";
		return undefined;
	}
	if (toolName === "read") return "reading context";
	if (toolName === "write") return "writing rationale";
	if (toolName === "edit") return "updating rationale";
	return undefined;
}

function assistantText(message: any): string {
	return (message?.content ?? [])
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

const COMMIT_AGENT_SYSTEM_PROMPT = `You are an isolated commit agent for pi.

You are running in a side session so your tool calls and reasoning do not pollute the user's main conversation. You have the active conversation history loaded behind you, as if you are taking the next turn.

Your job when prompted is to create a clean, intentional git commit for the work from that conversation.

Behavior:
- Infer the intended repository and commit scope from the conversation and working trees.
- Inspect repositories with git as needed.
- If multiple repositories/scopes are plausible and you cannot safely infer the right one, return needs_clarification before committing.
- If suspicious secrets/credentials appear, return needs_clarification before committing.
- Stage only intended changes. Do not blindly commit unrelated dirty work.
- Write an LLM-authored rationale file under .agents/commits/ when useful; for meaningful implementation/workflow changes, default to creating one.
- If a rationale file is created, the commit body must end with exactly: For more details, see .agents/commits/<filename>.md.
- Use a concise imperative commit subject.
- Push only if the user's /commit instructions explicitly request push.
- Before each major phase, emit a short line like PROGRESS: inspecting working tree, PROGRESS: writing rationale, PROGRESS: committing.
- When done, return ONLY one JSON object and no extra text.

JSON result schemas:
{"status":"committed","subject":"Subject","repo":"/absolute/repo/path","pushed":false,"rationalePath":".agents/commits/file.md","summary":"brief scope summary"}
{"status":"needs_clarification","reason":"why","questions":["question"]}
{"status":"failed","reason":"why"}`;

async function runCommitAgent(
	ctx: ExtensionCommandContext,
	instructions: string,
	clarification: string | undefined,
	onProgress: (phase: string) => void,
): Promise<CommitResult> {
	if (!ctx.model) return { status: "failed", reason: "No model selected" };

	onProgress("starting commit agent");
	const sessionManager = SessionManager.inMemory(ctx.cwd);
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message") {
			sessionManager.appendMessage(entry.message as any);
		}
	}

	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		model: ctx.model,
		thinkingLevel: "medium" as any,
		modelRegistry: ctx.modelRegistry,
		resourceLoader: makeCommitResourceLoader(),
		sessionManager,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
	});

	const outputParts: string[] = [];
	const unsubscribe = session.subscribe((event: any) => {
		if (event.type === "agent_start") onProgress("thinking about commit scope");
		else if (event.type === "tool_execution_start") {
			const progress = progressFromTool(event.toolName, event.args ?? {});
			if (progress) onProgress(progress);
		} else if (event.type === "message_update") {
			const text = assistantText(event.message);
			for (const match of text.matchAll(/PROGRESS:\s*([^\n]+)/g)) onProgress(match[1]!);
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = assistantText(event.message);
			if (text) outputParts.push(text);
		}
	});

	const packagePaths = await configuredPackagePaths();
	const prompt = `Run the commit workflow now.

User /commit instructions:
${instructions.trim() || "(none; infer intended scope from the conversation)"}

${clarification ? `User clarification:\n${clarification}\n` : ""}

Current parent cwd:
${ctx.cwd}

Configured local pi package/resource paths that may also contain relevant work:
${packagePaths.length > 0 ? packagePaths.map((p) => `- ${p}`).join("\n") : "(none)"}

Remember: do the git/rationale/commit work here in this side session, ask for clarification via JSON if needed, and return only the final JSON result.`;

	try {
		await session.prompt(prompt, { source: "extension" });
	} finally {
		unsubscribe();
	}

	return parseJsonResult(outputParts.join("\n\n"));
}

export default function (pi: ExtensionAPI) {
	let running = false;

	function setProgress(ctx: ExtensionCommandContext, text: string) {
		const line = `commit: ${text}`;
		ctx.ui.setStatus("commit", ctx.ui.theme.fg("dim", line));
		ctx.ui.setWidget("commit-progress", [ctx.ui.theme.fg("accent", "▸ ") + ctx.ui.theme.fg("dim", line)], {
			placement: "belowEditor",
		});
	}

	function clearProgress(ctx: ExtensionCommandContext) {
		ctx.ui.setStatus("commit", undefined);
		ctx.ui.setWidget("commit-progress", undefined);
	}

	async function runCommitFlow(instructions: string, ctx: ExtensionCommandContext) {
		try {
			ctx.ui.notify("Running commit agent...", "info");
			let clarification: string | undefined;
			let result = await runCommitAgent(ctx, instructions, clarification, (phase) => setProgress(ctx, phase));

			while (result.status === "needs_clarification") {
				ctx.ui.setWidget(
					"commit-progress",
					[
						ctx.ui.theme.fg("warning", "Commit clarification needed"),
						...(result.reason ? [ctx.ui.theme.fg("dim", result.reason)] : []),
						...result.questions.map((q) => `${ctx.ui.theme.fg("accent", "?")} ${q}`),
					],
					{ placement: "belowEditor" },
				);
				const answer = await ctx.ui.input("Answer commit clarification", "Type your answer and press Enter");
				if (!answer?.trim()) {
					clearProgress(ctx);
					ctx.ui.notify("Commit cancelled", "warning");
					return;
				}
				clarification = clarification ? `${clarification}\n\n${answer}` : answer;
				result = await runCommitAgent(ctx, instructions, clarification, (phase) => setProgress(ctx, phase));
			}

			clearProgress(ctx);
			if (result.status === "failed") {
				ctx.ui.notify(`Commit failed: ${result.reason}`, "error");
				return;
			}

			const message = `Committed \"${result.subject}\"${result.pushed ? " and pushed" : ""}.`;
			ctx.ui.notify(
				`Committed \"${result.subject}\" in ${result.repo}${result.pushed ? " and pushed" : ""}.${
					result.rationalePath ? ` Rationale: ${result.rationalePath}.` : ""
				}`,
				"info",
			);
			pi.sendMessage({
				customType: "commit",
				content: message,
				display: true,
				details: result,
			});
		} catch (error) {
			clearProgress(ctx);
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			running = false;
		}
	}

	pi.registerCommand("commit", {
		description: "Run an isolated commit agent with optional free-text instructions",
		handler: async (args, ctx) => {
			if (running) {
				ctx.ui.notify("Commit agent is already running", "warning");
				return;
			}
			running = true;
			await runCommitFlow(args.trim(), ctx);
		},
	});
}
