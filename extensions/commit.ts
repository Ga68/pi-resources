import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECRET_PATTERNS = [
	/api[_-]?key/i,
	/secret/i,
	/token/i,
	/password/i,
	/PRIVATE KEY/,
	/sk-[A-Za-z0-9_-]{10,}/,
];

const SECRET_FILE_PATTERNS = [
	/^\.env(?:\.|$)/,
	/\.pem$/,
	/\.key$/,
	/\.p12$/,
	/\.pfx$/,
	/^id_rsa$/,
	/^id_ed25519$/,
	/^secrets\./,
	/^credentials\./,
];

type Change = {
	status: string;
	path: string;
};

type CommitOptions = {
	push: boolean;
	messageOnly: boolean;
	rationale: boolean;
};

function parseOptions(instructions: string): CommitOptions {
	const text = instructions.toLowerCase();
	const noPush = /\b(no|do not|don't|dont|without)\s+push\b/.test(text);
	const push = !noPush && /\bpush\b/.test(text);
	const messageOnly = /\b(message only|write (a )?commit message|don't commit|do not commit)\b/.test(text);
	const noRationale = /\b(no|without)\s+rationale\b/.test(text);
	return { push, messageOnly, rationale: !noRationale };
}

function parseStatus(output: string): Change[] {
	const records = output.split("\0").filter(Boolean);
	const changes: Change[] = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i]!;
		const status = record.slice(0, 2);
		const path = record.slice(3);
		if (!path) continue;
		changes.push({ status, path });
		if (status[0] === "R" || status[0] === "C") i++; // porcelain -z includes original path next
	}
	return changes;
}

function hasSuspiciousFilename(path: string): boolean {
	const name = basename(path);
	return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function hasSecretPattern(text: string): boolean {
	return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function slugify(subject: string): string {
	return subject
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60) || "commit";
}

function timestamp(): string {
	const d = new Date();
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function inferSubject(changes: Change[], instructions: string): string {
	const text = instructions.trim();
	const quoted = text.match(/["“](.+?)["”]/)?.[1];
	if (quoted && quoted.length <= 72) return quoted;

	const paths = changes.map((c) => c.path);
	const addedExtensions = changes.filter((c) => c.status.includes("?") || c.status.includes("A")).map((c) => c.path);
	const extension = addedExtensions.find((p) => p.startsWith("extensions/") && p.endsWith(".ts"));
	if (extension) return `Add ${basename(extension, ".ts")} extension`;
	if (paths.every((p) => p.startsWith("extensions/"))) return "Update pi extensions";
	if (paths.every((p) => p.startsWith("skills/"))) return "Update pi skills";
	if (paths.includes("package.json") && paths.some((p) => p.startsWith("extensions/"))) return "Add pi extension resources";
	if (paths.includes("package.json")) return "Update pi package configuration";
	if (paths.length === 1) return `Update ${basename(paths[0]!)}`;
	return "Update project changes";
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]) {
	const result = await pi.exec("git", args, { cwd });
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	if (result.code !== 0) throw new Error(output || `git ${args.join(" ")} failed`);
	return output;
}

async function scanChanges(pi: ExtensionAPI, cwd: string, changes: Change[]): Promise<string[]> {
	const findings: string[] = [];
	for (const change of changes) {
		if (hasSuspiciousFilename(change.path)) findings.push(`suspicious filename: ${change.path}`);
	}

	const diff = await git(pi, cwd, ["diff", "--no-ext-diff"]);
	const cached = await git(pi, cwd, ["diff", "--cached", "--no-ext-diff"]);
	if (hasSecretPattern(diff) || hasSecretPattern(cached)) findings.push("suspicious secret-like text in tracked diff");

	for (const change of changes) {
		if (!change.status.includes("?")) continue;
		try {
			const content = await readFile(join(cwd, change.path), "utf8");
			if (hasSecretPattern(content)) findings.push(`suspicious secret-like text in untracked file: ${change.path}`);
		} catch {
			// Ignore binary/unreadable untracked files here; suspicious filenames are still caught above.
		}
	}
	return [...new Set(findings)];
}

async function writeRationale(cwd: string, subject: string, instructions: string, changes: Change[]): Promise<string> {
	const dir = join(cwd, ".agents", "commits");
	await mkdir(dir, { recursive: true });
	const filename = `${timestamp()}-${slugify(subject)}.md`;
	const relPath = `.agents/commits/${filename}`;
	const paths = changes.map((c) => `- ${c.status.trim() || "modified"} ${c.path}`).join("\n");
	const content = `# ${subject}\n\n## Summary\n\nCreated a focused git commit for the current working tree using the side-channel commit extension.\n\n## User instructions\n\n${instructions.trim() || "No extra instructions were provided; commit scope was inferred from the dirty working tree."}\n\n## Included changes\n\n${paths}\n\n## Decisions\n\n- Keep commit inspection, staging, and verification outside the main conversation context.\n- Stage only the currently detected working-tree changes for this commit.\n- Preserve this rationale file with the committed changes for future review.\n`;
	await writeFile(join(cwd, relPath), content, "utf8");
	return relPath;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Create a focused git commit with optional free-text instructions",
		handler: async (args, ctx) => {
			const instructions = args.trim();
			const options = parseOptions(instructions);

			try {
				await git(pi, ctx.cwd, ["rev-parse", "--is-inside-work-tree"]);
				const status = await git(pi, ctx.cwd, ["status", "--porcelain=v1", "-z"]);
				const changes = parseStatus(status);
				if (changes.length === 0) {
					ctx.ui.notify("Nothing to commit", "info");
					return;
				}

				const findings = await scanChanges(pi, ctx.cwd, changes);
				if (findings.length > 0) {
					const ok = await ctx.ui.confirm(
						"Potential secrets detected",
						`${findings.join("\n")}\n\nContinue with commit?`,
					);
					if (!ok) {
						ctx.ui.notify("Commit cancelled", "warning");
						return;
					}
				}

				const subject = inferSubject(changes, instructions);
				if (options.messageOnly) {
					ctx.ui.setEditorText(subject);
					ctx.ui.notify(`Suggested commit message: ${subject}`, "info");
					return;
				}

				let rationalePath: string | undefined;
				if (options.rationale) {
					rationalePath = await writeRationale(ctx.cwd, subject, instructions, changes);
				}

				const paths = [...changes.map((c) => c.path), ...(rationalePath ? [rationalePath] : [])];
				await git(pi, ctx.cwd, ["add", "--", ...paths]);

				const cachedStat = await git(pi, ctx.cwd, ["diff", "--cached", "--stat"]);
				if (!cachedStat.trim()) {
					ctx.ui.notify("Nothing staged for commit", "warning");
					return;
				}

				const body = rationalePath
					? `For more details, see ${rationalePath}.`
					: undefined;
				if (body) await git(pi, ctx.cwd, ["commit", "-m", subject, "-m", body]);
				else await git(pi, ctx.cwd, ["commit", "-m", subject]);

				let pushed = false;
				if (options.push) {
					await git(pi, ctx.cwd, ["push"]);
					pushed = true;
				}

				const final = `Committed \"${subject}\"${pushed ? " and pushed" : ""}.${
					rationalePath ? ` Rationale: ${rationalePath}.` : ""
				}`;
				ctx.ui.notify(final, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
