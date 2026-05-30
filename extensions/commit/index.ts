import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CustomEditor,
	SessionManager,
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const COMMIT_CONFIRMATION_TYPE = "commit-confirmation";
const COMMIT_STATUS_KEY = "commit";
const COMMIT_WIDGET_KEY = "commit";

interface FinishCommitDetails {
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

interface CommitConfirmationDetails extends FinishCommitDetails, CommitStats {
	confirmation: string;
	childSessionFile?: string;
}

interface QueuedParentMessage {
	text: string;
	timestamp: number;
}

type RpcJson = Record<string, any>;
type RpcListener = (event: RpcJson) => void;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function expandTilde(inputPath: string): string {
	return inputPath.startsWith("~/") ? path.join(os.homedir(), inputPath.slice(2)) : inputPath;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type PushIntent = "explicit" | "ambiguous" | "none";

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

function modelArgFromContext(ctx: ExtensionCommandContext, pi: ExtensionAPI): string | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	const base = `${model.provider}/${model.id}`;
	const thinking = pi.getThinkingLevel?.();
	return thinking && thinking !== "off" ? `${base}:${thinking}` : base;
}

function materializeSessionFile(sessionManager: SessionManager): string {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Session manager is not persisted.");
	const header = sessionManager.getHeader();
	if (!header) throw new Error("Session manager has no header.");
	const lines = [header, ...sessionManager.getEntries()].map((entry) => JSON.stringify(entry));
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.writeFileSync(sessionFile, `${lines.join("\n")}\n`);
	return sessionFile;
}

function createForkedCommitSession(ctx: ExtensionCommandContext): string {
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	const leafId = ctx.sessionManager.getLeafId();
	if (parentSessionFile && leafId) {
		const source = SessionManager.open(parentSessionFile, ctx.sessionManager.getSessionDir());
		const sessionFile = source.createBranchedSession(leafId);
		if (sessionFile) return fs.existsSync(sessionFile) ? sessionFile : materializeSessionFile(source);
	}

	// Fallback for ephemeral/non-persisted sessions. Normal interactive Pi sessions
	// should take the forked path above.
	const tempSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-commit-session-"));
	const fallback = SessionManager.create(ctx.cwd, tempSessionDir, parentSessionFile ? { parentSession: parentSessionFile } : undefined);
	const branch = ctx.sessionManager.getBranch();
	const context = buildSessionContext(branch as any);
	for (const message of context.messages) {
		try {
			fallback.appendMessage(message as any);
		} catch {
			// Skip message types that cannot be appended directly in fallback mode.
		}
	}
	return materializeSessionFile(fallback);
}

function buildCommitPrompt(args: string, pushAllowed: boolean, pushIntent: PushIntent): string {
	const instructions = args.trim() || "(none)";
	return `You are running the isolated /commit workflow for the parent Pi session.

Parent /commit instructions:
${instructions}

Push policy:
- pushAllowed = ${pushAllowed ? "true" : "false"}
- parsedPushIntent = ${pushIntent}
- If pushAllowed is true, push after the commit succeeds.
- If pushAllowed is false and parsedPushIntent is ambiguous, ask for explicit authorization with authorize_commit_push before any git push.
- If pushAllowed is false and parsedPushIntent is none, do not push unless a later steering message clearly asks for push; then use authorize_commit_push before any git push.
- Never infer push from context.

Responsibilities:
1. Infer what work should be committed from the parent conversation and the repository state.
2. Inspect git state as needed. Identify the repository, scope, intended files, and rationale.
3. Do not commit unrelated dirty work. Do not commit secrets, credentials, or accidental local artifacts.
4. Stage only the intended files and create the commit.
5. Usually create a rationale file in <repo>/.agents/commits/[isodt]-slug.md and commit it with the changes. Skip it only for changes so small and obvious that the commit message is enough.
6. If a rationale file is created, make the commit body end with: For more details, see .agents/commits/<filename>.md.
7. Ask clarification with ask_commit_user only when scope, repo, or safety is too ambiguous to proceed safely. Use authorize_commit_push specifically for ambiguous or later push authorization.
8. When complete, call finish_commit exactly once with repoPath, commitHash, subject, pushed, and rationalePath if applicable.

Rationale guidance:
- Preserve relevant conclusions, user intent, tradeoffs, rejected alternatives, risks, and follow-up context that future maintainers could not recover from the diff or commit message.
- Do not include hidden chain-of-thought. Write useful decision context, not a generic template.

Commit message guidance:
- Use a concise imperative subject.
- Include a body when it helps explain rationale, scope, or safety.
- If a rationale file exists, the body must end with the exact details sentence above.

Begin now.`;
}

class RpcChild {
	private proc: ChildProcessWithoutNullStreams | undefined;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<string, { resolve: (value: RpcJson) => void; reject: (error: Error) => void }>();
	private listeners = new Set<RpcListener>();
	private exitWaiters = new Set<(error: Error) => void>();
	stderr = "";

	constructor(
		private readonly cwd: string,
		private readonly args: string[],
		private readonly env: Record<string, string | undefined>,
	) {}

	start(): void {
		const invocation = getPiInvocation(this.args);
		this.proc = spawn(invocation.command, invocation.args, {
			cwd: this.cwd,
			env: { ...process.env, ...this.env },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		this.proc.stdout.on("data", (chunk) => this.handleStdout(chunk.toString()));
		this.proc.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
		this.proc.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
		this.proc.on("close", (code, signal) => {
			const error = new Error(`Commit child exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}${this.stderr.trim() ? `\n${this.stderr.trim()}` : ""}`);
			this.rejectAll(error);
		});
	}

	onEvent(listener: RpcListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async send(command: RpcJson): Promise<RpcJson> {
		if (!this.proc?.stdin.writable) throw new Error("Commit child is not running.");
		const id = `commit-${this.nextId++}`;
		const payload = { ...command, id };
		const promise = new Promise<RpcJson>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
		this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
		return promise;
	}

	sendExtensionUiResponse(response: RpcJson): void {
		if (!this.proc?.stdin.writable) return;
		this.proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", ...response })}\n`);
	}

	prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<RpcJson> {
		return this.send({ type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) });
	}

	getMessages(): Promise<RpcJson> {
		return this.send({ type: "get_messages" });
	}

	abort(): Promise<RpcJson> {
		return this.send({ type: "abort" });
	}

	waitForAgentEnd(timeoutMs = 20 * 60_000): Promise<RpcJson> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				unsubscribe();
				reject(new Error("Timed out waiting for commit child to finish."));
			}, timeoutMs);
			const onExit = (error: Error) => {
				clearTimeout(timeout);
				unsubscribe();
				reject(error);
			};
			this.exitWaiters.add(onExit);
			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_end") {
					clearTimeout(timeout);
					this.exitWaiters.delete(onExit);
					unsubscribe();
					resolve(event);
				}
			});
		});
	}

	stop(): void {
		try {
			this.proc?.kill("SIGTERM");
		} catch {
			// ignore
		}
	}

	private handleStdout(data: string): void {
		this.buffer += data;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const rawLine of lines) {
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (!line.trim()) continue;
			let event: RpcJson;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (event.type === "response" && event.id && this.pending.has(event.id)) {
				const pending = this.pending.get(event.id)!;
				this.pending.delete(event.id);
				if (event.success === false) pending.reject(new Error(event.error || "RPC command failed"));
				else pending.resolve(event);
				continue;
			}
			for (const listener of this.listeners) listener(event);
		}
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		for (const waiter of this.exitWaiters) waiter(error);
		this.exitWaiters.clear();
	}
}

function extractFinishDetails(messages: any[]): FinishCommitDetails | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "toolResult" && message.toolName === "finish_commit" && message.details) {
			return message.details as FinishCommitDetails;
		}
	}
	return undefined;
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

async function verifyCommit(pi: ExtensionAPI, ctx: ExtensionCommandContext, details: FinishCommitDetails | undefined, fallback: { repo?: string; beforeHead?: string }): Promise<FinishCommitDetails> {
	let repoPath = details?.repoPath ? path.resolve(ctx.cwd, expandTilde(details.repoPath)) : fallback.repo;
	if (!repoPath) throw new Error("Commit agent did not report a repository, and the current directory is not in a git repository.");
	repoPath = await gitStdout(pi, repoPath, ["rev-parse", "--show-toplevel"]);

	let commitHash = details?.commitHash;
	if (!commitHash) {
		const head = await resolveHead(pi, repoPath);
		if (head && head !== fallback.beforeHead) commitHash = head;
	}
	if (!commitHash) throw new Error("Commit agent did not report a commit hash and no new HEAD commit was detected.");

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

async function getCommitStats(pi: ExtensionAPI, commit: FinishCommitDetails): Promise<CommitStats> {
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

function formatConfirmation(commit: FinishCommitDetails, stats: CommitStats): string {
	return `Committed "${commit.subject}"${commit.pushed ? " and pushed" : ""} (+${stats.added} -${stats.removed}).`;
}

function phaseForTool(event: RpcJson): string | undefined {
	if (event.type !== "tool_execution_start") return undefined;
	const tool = event.toolName;
	const args = event.args ?? {};
	if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls") return "inspecting files";
	if (tool === "write" || tool === "edit") {
		const p = String(args.path ?? args.file_path ?? "");
		return p.includes(".agents/commits") ? "writing rationale" : "updating files";
	}
	if (tool === "ask_commit_user") return "waiting for clarification";
	if (tool === "authorize_commit_push") return "waiting for push authorization";
	if (tool === "finish_commit") return "finalizing";
	if (tool === "bash") {
		const command = String(args.command ?? "");
		if (/git\s+status\b/i.test(command)) return "inspecting git state";
		if (/git\s+(?:diff|show|log)\b/i.test(command)) return "reviewing diff";
		if (/git\s+add\b/i.test(command)) return "staging files";
		if (/git\s+commit\b/i.test(command)) return "committing";
		if (/(^|[;&|()\n]\s*)(?:env\s+(?:\S+=\S+\s+)*)?(?:command\s+)?(?:git|(?:\.{1,2}|\/)[^\s;&|()]*\/git)(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)|--namespace(?:=\S+|\s+\S+)|--exec-path(?:=\S+|\s+\S+)|--no-pager|--no-optional-locks|--literal-pathspecs|-p))*\s+push\b/i.test(command)) return "pushing";
		return "running git checks";
	}
	return undefined;
}

class CommitRoutingEditor extends CustomEditor {
	constructor(
		tui: any,
		theme: any,
		private readonly kb: KeybindingsManager,
		private readonly routes: {
			onSteer: (text: string) => void;
			onQueueParent: (text: string) => void;
			onAbort: () => void;
		},
	) {
		super(tui, theme, kb);
	}

	handleInput(data: string): void {
		if (this.kb.matches(data, "app.interrupt" as any)) {
			this.routes.onAbort();
			return;
		}
		if (this.kb.matches(data, "app.message.followUp" as any)) {
			const text = this.getText().trim();
			if (text) {
				this.setText("");
				this.routes.onQueueParent(text);
			}
			return;
		}
		if (this.kb.matches(data, "tui.input.submit" as any)) {
			const text = this.getText().trim();
			if (text) {
				this.setText("");
				this.routes.onSteer(text);
			}
			return;
		}
		super.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		const label = " /commit: Enter steers · Alt+Enter queues main ";
		const last = lines.length - 1;
		if (width > label.length + 4 && visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}
}

class CommitRun {
	private child: RpcChild | undefined;
	private queuedParentMessages: QueuedParentMessage[] = [];
	private pendingSteeringMessages: string[] = [];
	private acceptingSteering = true;
	private phase = "starting";
	private completed = false;
	private previousEditorFactory: ReturnType<ExtensionCommandContext["ui"]["getEditorComponent"]> | undefined;
	private childSessionFile: string | undefined;
	private fallbackRepo: string | undefined;
	private fallbackBeforeHead: string | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionCommandContext,
		private readonly args: string,
		private readonly childRuntimePath: string,
		private readonly pushAllowed: boolean,
		private readonly pushIntent: PushIntent,
		private readonly onDone: () => void,
	) {}

	start(): void {
		void this.run().catch((error) => {
			this.fail(error instanceof Error ? error.message : String(error));
		});
	}

	routeSteering(text: string): void {
		if (this.completed) return;
		if (!this.acceptingSteering) {
			this.queueParent(text);
			return;
		}
		if (!this.child) {
			this.pendingSteeringMessages.push(text);
			this.setPhase("queued steering");
			return;
		}
		this.sendSteering(text);
	}

	queueParent(text: string): void {
		this.queuedParentMessages.push({ text, timestamp: Date.now() });
		this.updateWidget();
		this.ctx.ui.notify(`Queued for main conversation after /commit (${this.queuedParentMessages.length}).`, "info");
	}

	async abort(replayQueued = true, recordMessage = true): Promise<void> {
		if (this.completed) return;
		this.completed = true;
		this.restoreEditor();
		this.clearUi();
		try {
			await this.child?.abort();
		} catch {
			// ignore; we'll stop below
		}
		this.child?.stop();
		if (recordMessage) {
			this.pi.sendMessage({
				customType: COMMIT_CONFIRMATION_TYPE,
				content: "Commit aborted.",
				display: true,
				details: { aborted: true, childSessionFile: this.childSessionFile },
			});
		}
		if (replayQueued) await this.replayQueuedParentMessages();
		this.onDone();
	}

	private async run(): Promise<void> {
		this.previousEditorFactory = this.ctx.ui.getEditorComponent();
		this.installRoutingEditor();
		this.setPhase("starting");
		this.fallbackRepo = await resolveRepo(this.pi, this.ctx.cwd);
		this.fallbackBeforeHead = await resolveHead(this.pi, this.fallbackRepo);
		this.childSessionFile = createForkedCommitSession(this.ctx);

		const modelArg = modelArgFromContext(this.ctx, this.pi);
		const childArgs = [
			"--mode", "rpc",
			"--session", this.childSessionFile,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--extension", this.childRuntimePath,
			"--tools", "read,bash,edit,write,grep,find,ls,ask_commit_user,authorize_commit_push,finish_commit",
		];
		if (modelArg) childArgs.push("--model", modelArg);

		this.child = new RpcChild(this.ctx.cwd, childArgs, {
			PI_COMMIT_CHILD: "1",
			PI_COMMIT_PUSH_ALLOWED: this.pushAllowed ? "1" : "0",
		});
		this.child.onEvent((event) => this.handleChildEvent(event));
		this.child.start();

		this.setPhase("inspecting git state");
		const done = this.child.waitForAgentEnd();
		await this.child.prompt(buildCommitPrompt(this.args, this.pushAllowed, this.pushIntent));
		for (const steering of this.pendingSteeringMessages.splice(0)) this.sendSteering(steering);
		await done;
		this.acceptingSteering = false;
		if (this.completed) return;

		this.setPhase("verifying commit");
		const response = await this.child.getMessages();
		const messages = response.data?.messages ?? [];
		const reported = extractFinishDetails(messages);
		const commit = await verifyCommit(this.pi, this.ctx, reported, { repo: this.fallbackRepo, beforeHead: this.fallbackBeforeHead });
		if (this.pushAllowed && !commit.pushed) {
			throw new Error("Push was explicitly requested, but the commit agent did not report a successful push.");
		}
		this.child?.stop();
		const stats = await getCommitStats(this.pi, commit);
		const confirmation = formatConfirmation(commit, stats);
		this.completed = true;
		this.restoreEditor();
		this.clearUi();
		this.pi.sendMessage<CommitConfirmationDetails>({
			customType: COMMIT_CONFIRMATION_TYPE,
			content: confirmation,
			display: true,
			details: { ...commit, ...stats, confirmation, childSessionFile: this.childSessionFile },
		});
		await this.replayQueuedParentMessages();
		this.onDone();
	}

	private sendSteering(text: string): void {
		this.setPhase("steering commit agent");
		void this.child?.prompt(`User steering for /commit:\n\n${text}`, "steer").catch((error) => {
			if (this.ctx.hasUI) this.ctx.ui.notify(`Failed to steer commit agent: ${error instanceof Error ? error.message : String(error)}`, "error");
		});
	}

	private installRoutingEditor(): void {
		if (!this.ctx.hasUI) return;
		this.ctx.ui.setEditorComponent((tui, theme, keybindings) => new CommitRoutingEditor(tui, theme, keybindings, {
			onSteer: (text) => this.routeSteering(text),
			onQueueParent: (text) => this.queueParent(text),
			onAbort: () => {
				void (async () => {
					const ok = await this.ctx.ui.confirm("Abort /commit?", "Stop the isolated commit agent? Staged changes made so far will not be automatically reverted.");
					if (ok) await this.abort();
				})();
			},
		}));
	}

	private restoreEditor(): void {
		if (!this.ctx.hasUI) return;
		this.ctx.ui.setEditorComponent(this.previousEditorFactory);
	}

	private setPhase(phase: string): void {
		this.phase = phase;
		if (this.ctx.hasUI) {
			this.ctx.ui.setStatus(COMMIT_STATUS_KEY, `commit: ${phase}`);
			this.updateWidget();
		}
	}

	private updateWidget(): void {
		if (!this.ctx.hasUI) return;
		const queued = this.queuedParentMessages.length;
		this.ctx.ui.setWidget(COMMIT_WIDGET_KEY, [
			`/commit: ${this.phase}`,
			`Enter steers commit agent · Alt+Enter queues main follow-up${queued ? ` · ${queued} queued` : ""}`,
		], { placement: "aboveEditor" });
	}

	private clearUi(): void {
		if (!this.ctx.hasUI) return;
		this.ctx.ui.setStatus(COMMIT_STATUS_KEY, undefined);
		this.ctx.ui.setWidget(COMMIT_WIDGET_KEY, undefined);
	}

	private handleChildEvent(event: RpcJson): void {
		if (event.type === "extension_ui_request") {
			void this.handleChildUi(event);
			return;
		}
		if (event.type === "extension_error" && this.ctx.hasUI) {
			this.ctx.ui.notify(`Commit child extension error: ${event.error}`, "warning");
		}
		const phase = phaseForTool(event);
		if (phase) this.setPhase(phase);
	}

	private async handleChildUi(request: RpcJson): Promise<void> {
		if (!this.child) return;
		try {
			switch (request.method) {
				case "notify": {
					if (this.ctx.hasUI) this.ctx.ui.notify(`[commit] ${request.message}`, request.notifyType);
					return;
				}
				case "setStatus": {
					if (request.statusText) this.setPhase(String(request.statusText));
					return;
				}
				case "setWidget":
				case "setTitle":
				case "set_editor_text":
					return;
				case "confirm": {
					const confirmed = this.ctx.hasUI ? await this.ctx.ui.confirm(request.title, request.message, { timeout: request.timeout }) : false;
					this.child.sendExtensionUiResponse({ id: request.id, confirmed });
					return;
				}
				case "select": {
					const value = this.ctx.hasUI ? await this.ctx.ui.select(request.title, request.options ?? [], { timeout: request.timeout }) : undefined;
					this.child.sendExtensionUiResponse(value ? { id: request.id, value } : { id: request.id, cancelled: true });
					return;
				}
				case "input": {
					this.setPhase("waiting for clarification");
					const value = this.ctx.hasUI ? await this.ctx.ui.input(request.title, request.placeholder, { timeout: request.timeout }) : undefined;
					this.child.sendExtensionUiResponse(value ? { id: request.id, value } : { id: request.id, cancelled: true });
					this.setPhase("continuing");
					return;
				}
				case "editor": {
					this.setPhase("waiting for clarification");
					const value = this.ctx.hasUI ? await this.ctx.ui.editor(request.title, request.prefill) : undefined;
					this.child.sendExtensionUiResponse(value ? { id: request.id, value } : { id: request.id, cancelled: true });
					this.setPhase("continuing");
					return;
				}
			}
		} catch (error) {
			this.child.sendExtensionUiResponse({ id: request.id, cancelled: true });
			if (this.ctx.hasUI) this.ctx.ui.notify(`Commit clarification failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	private async replayQueuedParentMessages(): Promise<void> {
		if (this.queuedParentMessages.length === 0) return;
		for (const queued of this.queuedParentMessages) {
			while (!this.ctx.isIdle()) await delay(250);
			this.pi.sendUserMessage(queued.text);
			await delay(250);
		}
	}

	private fail(message: string): void {
		if (this.completed) return;
		this.completed = true;
		this.restoreEditor();
		this.clearUi();
		this.child?.stop();
		this.pi.sendMessage({
			customType: COMMIT_CONFIRMATION_TYPE,
			content: `Commit failed: ${message}`,
			display: true,
			details: { error: message, childSessionFile: this.childSessionFile },
		});
		if (this.ctx.hasUI) this.ctx.ui.notify(`Commit failed: ${message}`, "error");
		void this.replayQueuedParentMessages().finally(() => this.onDone());
	}
}

export default function registerCommitExtension(pi: ExtensionAPI): void {
	if (process.env.PI_COMMIT_CHILD === "1") return;

	const childRuntimePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "child-runtime.ts");
	let activeRun: CommitRun | undefined;

	pi.registerMessageRenderer<CommitConfirmationDetails | { error?: string }>(COMMIT_CONFIRMATION_TYPE, (message, _options, theme) => {
		const text = typeof message.content === "string" ? message.content : "";
		const isError = Boolean((message.details as { error?: string } | undefined)?.error) || text.startsWith("Commit failed:");
		return new Text(`${isError ? theme.fg("error", "✗") : theme.fg("success", "✓")} ${text}`, 0, 0);
	});

	pi.registerCommand("commit", {
		description: "Run an isolated commit agent: /commit [instructions], /commit push",
		handler: async (args, ctx) => {
			if (activeRun) {
				ctx.ui.notify("A /commit run is already active. Use the editor to steer it, or press Esc to abort.", "warning");
				return;
			}
			const pushIntent = classifyPushIntent(args);
			const pushAllowed = pushIntent === "explicit";
			activeRun = new CommitRun(pi, ctx, args, childRuntimePath, pushAllowed, pushIntent, () => {
				activeRun = undefined;
			});
			activeRun.start();
			// The run is intentionally detached from the command handler so the editor can keep routing input.
		},
	});

	pi.on("session_shutdown", async () => {
		if (activeRun) await activeRun.abort(false, false);
		activeRun = undefined;
	});
}
