import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home?: string): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => ({
			dispose: footerData.onBranchChange(() => tui.requestRender()),
			invalidate() {},
			render(width: number): string[] {
				let location = formatCwdForFooter(
					ctx.sessionManager.getCwd(),
					process.env.HOME || process.env.USERPROFILE,
				);

				const branch = footerData.getGitBranch();
				if (branch) location = `${location} (${branch})`;

				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) location = `${location} • ${sessionName}`;

				const usage = ctx.getContextUsage();
				const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const contextPercentValue = usage?.percent ?? 0;
				const contextPercent = usage?.percent !== null && usage?.percent !== undefined ? usage.percent.toFixed(1) : "?";
				const contextDisplay =
					contextPercent === "?"
						? `?/${formatTokens(contextWindow)}`
						: `${contextPercent}%/${formatTokens(contextWindow)}`;

				let context = contextDisplay;
				if (contextPercentValue > 90) {
					context = theme.fg("error", contextDisplay);
				} else if (contextPercentValue > 70) {
					context = theme.fg("warning", contextDisplay);
				} else {
					context = theme.fg("dim", contextDisplay);
				}

				const modelName = ctx.model?.id || "no-model";
				let rightWithoutProvider = modelName;
				if (ctx.model?.reasoning) {
					const thinkingLevel = pi.getThinkingLevel() || "off";
					rightWithoutProvider =
						thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
				}

				const contextWidth = visibleWidth(context);
				let rightText = rightWithoutProvider;
				if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
					const withProvider = `(${ctx.model.provider}) ${rightWithoutProvider}`;
					if (visibleWidth(location) + 2 + contextWidth + 2 + visibleWidth(withProvider) <= width) {
						rightText = withProvider;
					}
				}

				const right = theme.fg("dim", rightText);
				const rightWidth = visibleWidth(right);
				if (rightWidth > width) {
					return [truncateToWidth(right, width, "")];
				}

				const rightStart = width - rightWidth;
				let contextStart = Math.floor((width - contextWidth) / 2);
				// If the centered context would collide with the right side, shift it left.
				contextStart = Math.min(contextStart, rightStart - contextWidth - 1);
				contextStart = Math.max(0, contextStart);

				const leftAvailable = Math.max(0, contextStart - 1);
				const left = truncateToWidth(theme.fg("dim", location), leftAvailable, theme.fg("dim", "..."));
				const leftWidth = visibleWidth(left);

				const spaceBeforeContext = " ".repeat(Math.max(0, contextStart - leftWidth));
				const afterContextWidth = leftWidth + visibleWidth(spaceBeforeContext) + contextWidth;
				const spaceBeforeRight = " ".repeat(Math.max(1, rightStart - afterContextWidth));

				return [truncateToWidth(left + spaceBeforeContext + context + spaceBeforeRight + right, width, "")];
			},
		}));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setFooter(undefined);
	});
}
