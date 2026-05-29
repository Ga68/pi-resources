import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");

type SideAgentResult =
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
			questions: string[];
			reason?: string;
	  }
	| {
			status: "failed";
			reason: string;
	  };

async function configuredPackagePaths(): Promise<string[]> {
	try {
		const settingsPath = join(AGENT_DIR, "settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { packages?: unknown[] };
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

function parseJsonResult(output: string): SideAgentResult {
	const trimmed = output.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
	const candidate = fenced ?? trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
	try {
		const parsed = JSON.parse(candidate) as SideAgentResult;
		if (parsed && typeof parsed === "object" && "status" in parsed) return parsed;
	} catch {
		// Fall through.
	}
	return { status: "failed", reason: trimmed || "Commit side agent returned no output" };
}

function branchJson(ctx: ExtensionCommandContext): string {
	return JSON.stringify(ctx.sessionManager.getBranch(), null, 2);
}

function compactProgress(text: string): string {
	const line = text.trim().split("\n").filter(Boolean).at(-1) ?? "working";
	return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function humanBashProgress(command: string): string | undefined {
	if (/git\s+status/.test(command)) return "inspecting working tree";
	if (/git\s+diff/.test(command)) return "reviewing changes";
	if (/git\s+add/.test(command)) return "staging selected changes";
	if (/git\s+commit/.test(command)) return "creating commit";
	if (/git\s+push/.test(command)) return "pushing commit";
	if (/git\s+rev-parse/.test(command)) return "locating repository";
	if (/git\s+branch|git\s+remote/.test(command)) return "checking repository metadata";
	if (/mkdir|cat\s+>|tee\s+|printf/.test(command)) return "writing rationale";
	return undefined;
}

function progressFromTool(name: string, args: Record<string, unknown>): string | undefined {
	if (name === "bash") return humanBashProgress(String(args.command ?? ""));
	if (name === "read") return "reading relevant context";
	if (name === "write") return "writing rationale";
	if (name === "edit") return "updating rationale";
	return undefined;
}

async function runPiProcess(
	cwd: string,
	args: string[],
	onProgress: (text: string) => void,
): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		const child = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let rawOutput = "";
		let finalAssistantText = "";
		let lineBuffer = "";

		const handleJsonLine = (line: string) => {
			if (!line.trim()) return;
			rawOutput += `${line}\n`;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				onProgress(compactProgress(line));
				return;
			}

			if (event.type === "agent_start") onProgress("thinking about commit scope");
			else if (event.type === "tool_execution_start") {
				const progress = progressFromTool(event.toolName, event.args ?? {});
				if (progress) onProgress(progress);
			} else if (event.type === "message_update") {
				const delta = event.assistantMessageEvent?.delta;
				if (typeof delta === "string") {
					for (const match of delta.matchAll(/PROGRESS:\s*([^\n]+)/g)) onProgress(match[1]!);
				}
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				finalAssistantText = (event.message.content ?? [])
					.filter((part: any) => part?.type === "text" && typeof part.text === "string")
					.map((part: any) => part.text)
					.join("\n")
					.trim();
			}
		};

		child.stdout.on("data", (chunk: Buffer) => {
			lineBuffer += chunk.toString();
			let newlineIndex: number;
			while ((newlineIndex = lineBuffer.indexOf("\n")) !== -1) {
				const line = lineBuffer.slice(0, newlineIndex);
				lineBuffer = lineBuffer.slice(newlineIndex + 1);
				handleJsonLine(line);
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			rawOutput += text;
			onProgress(compactProgress(text));
		});
		child.on("error", (error) => resolve({ code: 1, output: error.message }));
		child.on("close", (code) => {
			if (lineBuffer.trim()) handleJsonLine(lineBuffer);
			resolve({ code, output: finalAssistantText || rawOutput.trim() });
		});
	});
}

async function runSideAgent(
	_ctxPi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	instructions: string,
	onProgress: (text: string) => void,
	clarification?: string,
): Promise<SideAgentResult> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-commit-agent-"));
	const promptPath = join(tempDir, "prompt.md");
	const branchPath = join(tempDir, "branch.json");
	const packagePaths = await configuredPackagePaths();
	await writeFile(branchPath, branchJson(ctx), "utf8");

	const prompt = `You are a side-channel commit agent running in an isolated pi process.

Your job is to create a clean, intentional git commit for the work represented by the active conversation branch below.

You have full tool access in this side process. Use bash/read/write/edit as needed. Your tool calls and reasoning are isolated from the parent conversation, so inspect freely, but be safe.

User instructions for /commit:
${instructions.trim() || "(none; infer the intended commit from the conversation and dirty working trees)"}

${clarification ? `Clarification from user:\n${clarification}\n` : ""}

Parent pi cwd:
${ctx.cwd}

Configured local pi package/resource paths that may also contain relevant work:
${packagePaths.length > 0 ? packagePaths.map((p) => `- ${p}`).join("\n") : "(none)"}

Required workflow:
Before each major phase, emit a short line beginning with PROGRESS:, for example:
PROGRESS: inspecting repositories
PROGRESS: reading conversation branch
PROGRESS: checking diffs
PROGRESS: writing rationale
PROGRESS: staging changes
PROGRESS: committing
PROGRESS: pushing

1. Infer the repository and commit scope from the full conversation branch and the working trees you inspect.
2. If the repository/scope is ambiguous or risky, stop and return a JSON needs_clarification result. Do not guess across unrelated repos.
3. Inspect git status and diffs internally. Do not push unless the user instructions explicitly request push.
4. Never commit secrets or credentials. If suspicious content appears, return needs_clarification with clear questions.
5. Stage only intended changes. Do not blindly commit unrelated dirty work.
6. Create a high-quality LLM-authored rationale file under .agents/commits/ when useful. For meaningful implementation/workflow changes, default to creating one.
7. If a rationale file is created, make the commit body end with exactly: For more details, see .agents/commits/<filename>.md.
8. Commit with a concise imperative subject.
9. Optionally push only if explicitly requested.
10. After progress lines and work are complete, return one final JSON object, with no markdown fence.

JSON result schemas:

Committed:
{
  "status": "committed",
  "subject": "Commit subject",
  "repo": "/absolute/repo/path",
  "pushed": false,
  "rationalePath": ".agents/commits/file.md",
  "summary": "One brief sentence describing what was committed."
}

Needs clarification:
{
  "status": "needs_clarification",
  "reason": "Why clarification is needed",
  "questions": ["Question 1", "Question 2"]
}

Failed:
{
  "status": "failed",
  "reason": "Short failure explanation"
}

Full active conversation branch is available as a JSON file here:
${branchPath}

Use that file as the source of intent and context. It may be large: do not load the whole file into context unless necessary. Prefer reading/searching targeted chunks, especially recent user messages and tool calls/results mentioning file paths, writes, edits, git commands, or commit intent.
`;

	try {
		await writeFile(promptPath, prompt, "utf8");
		const result = await runPiProcess(
			ctx.cwd,
			["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--mode", "json", `@${promptPath}`],
			onProgress,
		);
		if (result.code !== 0) return { status: "failed", reason: result.output || "Commit side agent failed" };
		return parseJsonResult(result.output);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

export default function (pi: ExtensionAPI) {
	let running = false;

	async function runCommitFlow(instructions: string, ctx: ExtensionCommandContext) {
		try {
			ctx.ui.notify("Running commit agent...", "info");
			let clarification: string | undefined;
			const clearProgress = () => {
				ctx.ui.setStatus("commit", undefined);
				ctx.ui.setWidget("commit-progress", undefined);
			};
			const setProgress = (text: string) => {
				const line = `commit: ${text}`;
				ctx.ui.setStatus("commit", ctx.ui.theme.fg("dim", line));
				ctx.ui.setWidget(
					"commit-progress",
					[ctx.ui.theme.fg("accent", "▸ ") + ctx.ui.theme.fg("dim", line)],
					{ placement: "belowEditor" },
				);
			};
			setProgress("starting side agent");
			let result = await runSideAgent(pi, ctx, instructions, setProgress);

			while (result.status === "needs_clarification") {
				ctx.ui.setStatus("commit", ctx.ui.theme.fg("dim", "commit: waiting for clarification"));
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
					clearProgress();
					ctx.ui.notify("Commit cancelled", "warning");
					return;
				}
				clarification = clarification ? `${clarification}\n\n${answer}` : answer;
				ctx.ui.notify("Restarting commit agent with clarification...", "info");
				setProgress("restarting with clarification");
				result = await runSideAgent(pi, ctx, instructions, setProgress, clarification);
			}

			clearProgress();
			if (result.status === "committed") {
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
					details: {
						subject: result.subject,
						repo: result.repo,
						pushed: result.pushed,
						rationalePath: result.rationalePath,
					},
				}, { deliverAs: "nextTurn" });
				return;
			}

			ctx.ui.notify(`Commit failed: ${result.reason}`, "error");
		} catch (error) {
			ctx.ui.setStatus("commit", undefined);
			ctx.ui.setWidget("commit-progress", undefined);
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			running = false;
		}
	}

	pi.registerCommand("commit", {
		description: "Run a side-channel commit agent with optional free-text instructions",
		handler: async (args, ctx) => {
			if (running) {
				ctx.ui.notify("Commit agent is already running", "warning");
				return;
			}
			running = true;
			void runCommitFlow(args.trim(), ctx);
			return;
		},
	});
}
