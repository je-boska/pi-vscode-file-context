import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const CONTEXT_DIR = path.join(os.tmpdir(), "pi-vscode-file-context");
const POLL_MS = 100;
const STALE_MS = 24 * 60 * 60 * 1000;
const MAX_INJECTED_SELECTION_CHARS = 64 * 1024;

type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type Selection = Range & { text?: string; isEmpty?: boolean };
type ActiveFile = {
	path: string;
	languageId?: string;
	isDirty?: boolean;
	cursor?: Position;
	selection?: Selection;
};
type OpenFile = {
	path: string;
	languageId?: string;
	isActive?: boolean;
	isDirty?: boolean;
};
type VSCodeContext = {
	version: 1;
	updatedAt: number;
	pid?: number;
	workspaceFolders: string[];
	isTrusted?: boolean;
	activeFile?: ActiveFile;
	openFiles?: OpenFile[];
};

let currentCtx: ExtensionContext | undefined;
let currentContext: VSCodeContext | undefined;
let currentFilePath: string | undefined;
let currentMtimeMs = 0;
let pollTimer: NodeJS.Timeout | undefined;
let lastStatus = "";

function isInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return (
		rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel))
	);
}

function isExcludedFile(filePath: string): boolean {
	return path.basename(filePath).startsWith(".env");
}

function sanitizeContext(ctx: VSCodeContext): VSCodeContext {
	return {
		...ctx,
		activeFile:
			ctx.activeFile && !isExcludedFile(ctx.activeFile.path)
				? ctx.activeFile
				: undefined,
		openFiles: ctx.openFiles?.filter((file) => !isExcludedFile(file.path)),
	};
}

function findBestContextFile(cwd: string): string | undefined {
	let entries: string[];
	try {
		entries = fs.readdirSync(CONTEXT_DIR);
	} catch {
		return undefined;
	}

	const candidates: Array<{ file: string; mtimeMs: number; score: number }> =
		[];
	const now = Date.now();

	for (const name of entries) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(CONTEXT_DIR, name);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
			if (!stat.isFile()) continue;
			if (now - stat.mtimeMs > STALE_MS) continue;
			const parsed = sanitizeContext(
				JSON.parse(fs.readFileSync(file, "utf8")) as VSCodeContext,
			);
			if (
				!parsed ||
				parsed.version !== 1 ||
				!Array.isArray(parsed.workspaceFolders)
			)
				continue;
			const score = parsed.workspaceFolders.some((folder) =>
				isInside(folder, cwd),
			)
				? 2
				: 1;
			candidates.push({ file, mtimeMs: stat.mtimeMs, score });
		} catch {
			// Ignore partial/stale/malformed files.
		}
	}

	candidates.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
	return candidates[0]?.file;
}

function readCurrentContext(cwd: string): VSCodeContext | undefined {
	const file = currentFilePath ?? findBestContextFile(cwd);
	if (!file) return undefined;

	try {
		const stat = fs.statSync(file);
		if (Date.now() - stat.mtimeMs > STALE_MS) return undefined;

		if (file === currentFilePath && stat.mtimeMs === currentMtimeMs) {
			return currentContext;
		}

		const parsed = sanitizeContext(
			JSON.parse(fs.readFileSync(file, "utf8")) as VSCodeContext,
		);
		if (!parsed || parsed.version !== 1) return undefined;

		currentFilePath = file;
		currentMtimeMs = stat.mtimeMs;
		currentContext = parsed;
		return parsed;
	} catch {
		currentFilePath = undefined;
		currentMtimeMs = 0;
		return undefined;
	}
}

function rel(filePath: string, cwd: string): string {
	const r = path.relative(cwd, filePath);
	return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : filePath;
}

function basename(filePath: string): string {
	return path.basename(filePath) || filePath;
}

function selectedLineCount(active: ActiveFile): number {
	const sel = active.selection;
	if (!sel || sel.isEmpty) return 0;
	return Math.max(1, sel.end.line - sel.start.line + 1);
}

function statusText(ctx: VSCodeContext | undefined): string {
	if (!ctx) return "VS Code offline";
	if (!ctx.activeFile) return "VS Code no file";
	const filename = basename(ctx.activeFile.path);
	const lines = selectedLineCount(ctx.activeFile);
	if (lines > 0)
		return `${filename} / ${lines} ${lines === 1 ? "line" : "lines"} selected`;
	return filename;
}

function brightBlue(text: string): string {
	return `\x1b[94m${text}\x1b[0m`;
}

function updateStatus(): void {
	if (!currentCtx) return;
	const ctx = readCurrentContext(currentCtx.cwd);
	const text = statusText(ctx);
	if (text === lastStatus) return;
	lastStatus = text;
	currentCtx.ui.setStatus("vscode", brightBlue(text));
}

function formatSelection(active: ActiveFile, cwd: string): string | undefined {
	const sel = active.selection;
	if (!sel || sel.isEmpty || !sel.text) return undefined;
	const text =
		sel.text.length > MAX_INJECTED_SELECTION_CHARS
			? `${sel.text.slice(0, MAX_INJECTED_SELECTION_CHARS)}\n\n[truncated at ${MAX_INJECTED_SELECTION_CHARS} chars]`
			: sel.text;
	const lang = active.languageId ?? "";
	const start = sel.start.line;
	const end = sel.end.line;
	const range = start === end ? `L${start}` : `L${start}:${end}`;
	return `VS Code selection in ${rel(active.path, cwd)} ${range}:\n\`\`\`${lang}\n${text}\n\`\`\``;
}

function formatLightContext(active: ActiveFile, cwd: string): string {
	const cursor = active.cursor
		? ` cursor L${active.cursor.line}:C${active.cursor.character}`
		: "";
	return `VS Code active file: ${rel(active.path, cwd)}${cursor}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		updateStatus();
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(updateStatus, POLL_MS);
	});

	pi.on("session_shutdown", async () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		if (currentCtx) currentCtx.ui.setStatus("vscode", "");
		currentCtx = undefined;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const vscode = readCurrentContext(ctx.cwd);
		const active = vscode?.activeFile;
		if (!active) return;

		const content =
			formatSelection(active, ctx.cwd) ?? formatLightContext(active, ctx.cwd);
		return {
			message: {
				customType: "vscode-context",
				content,
				display: false,
			},
		};
	});

	pi.registerTool({
		name: "get_vscode_context",
		label: "Get VS Code Context",
		description:
			"Get current VS Code active file, selection, and open files from the file-based companion.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const vscode = readCurrentContext(ctx.cwd);
			return {
				content: [
					{
						type: "text",
						text: vscode
							? JSON.stringify(vscode, null, 2)
							: "No VS Code context available.",
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "get_vscode_selection",
		label: "Get VS Code Selection",
		description: "Get selected text from the current VS Code editor, if any.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const active = readCurrentContext(ctx.cwd)?.activeFile;
			const selection = active ? formatSelection(active, ctx.cwd) : undefined;
			return {
				content: [
					{
						type: "text",
						text: selection ?? "No VS Code selection available.",
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "list_vscode_open_files",
		label: "List VS Code Open Files",
		description: "List files currently open in VS Code.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const vscode = readCurrentContext(ctx.cwd);
			const files =
				vscode?.openFiles?.map((f) => ({ ...f, path: rel(f.path, ctx.cwd) })) ??
				[];
			return {
				content: [
					{
						type: "text",
						text: files.length
							? JSON.stringify(files, null, 2)
							: "No VS Code open files available.",
					},
				],
				details: {},
			};
		},
	});
}
