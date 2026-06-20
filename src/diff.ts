import { setIcon } from "obsidian";

export type DiffLineType = "add" | "del" | "context" | "meta";

export interface DiffLine {
	type: DiffLineType;
	oldNum: number | null;
	newNum: number | null;
	text: string;
	/** Leading change indicator(s), e.g. "+", "-", " ", "++". */
	sign: string;
}

export interface DiffHunk {
	header: string;
	lines: DiffLine[];
	combined: boolean;
}

export type FileStatus =
	| "added"
	| "deleted"
	| "modified"
	| "renamed"
	| "copied"
	| "binary";

export interface DiffFile {
	oldPath: string;
	newPath: string;
	status: FileStatus;
	hunks: DiffHunk[];
	isBinary: boolean;
	additions: number;
	deletions: number;
}

function stripPrefix(path: string): string {
	if (path === "/dev/null") return path;
	return path.replace(/^[ab]\//, "");
}

function unquote(path: string): string {
	// git quotes paths with special characters in double quotes.
	if (path.startsWith('"') && path.endsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(path);
			return typeof parsed === "string" ? parsed : path.slice(1, -1);
		} catch {
			return path.slice(1, -1);
		}
	}
	return path;
}

/**
 * Parses unified (and combined, for merges) diff text into structured files.
 * Written to be forgiving: anything it doesn't recognise becomes a meta line
 * rather than throwing.
 */
export function parseDiff(text: string): DiffFile[] {
	const files: DiffFile[] = [];
	const lines = text.split("\n");

	let file: DiffFile | null = null;
	let hunk: DiffHunk | null = null;
	let oldNum = 0;
	let newNum = 0;
	let prefixCols = 1;

	const pushFile = () => {
		if (file) files.push(file);
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (line.startsWith("diff --git") || line.startsWith("diff --cc") || line.startsWith("diff --combined")) {
			pushFile();
			hunk = null;
			file = {
				oldPath: "",
				newPath: "",
				status: "modified",
				hunks: [],
				isBinary: false,
				additions: 0,
				deletions: 0,
			};
			// Best-effort path parse from the header; refined by --- / +++ lines.
			const m = line.match(/ a\/(.+?) b\/(.+)$/);
			if (m) {
				file.oldPath = unquote(m[1]);
				file.newPath = unquote(m[2]);
			} else {
				const cc = line.match(/^diff --(?:cc|combined) (.+)$/);
				if (cc) {
					file.oldPath = file.newPath = unquote(cc[1]);
				}
			}
			continue;
		}

		if (!file) {
			// Text before the first "diff --git" header (e.g. blank lines).
			continue;
		}

		// File-level metadata lines.
		if (line.startsWith("new file mode")) {
			file.status = "added";
			continue;
		}
		if (line.startsWith("deleted file mode")) {
			file.status = "deleted";
			continue;
		}
		if (line.startsWith("rename from") || line.startsWith("rename to")) {
			file.status = "renamed";
			continue;
		}
		if (line.startsWith("copy from") || line.startsWith("copy to")) {
			file.status = "copied";
			continue;
		}
		if (
			line.startsWith("Binary files") ||
			line.startsWith("GIT binary patch")
		) {
			file.isBinary = true;
			file.status = file.status === "modified" ? "binary" : file.status;
			continue;
		}
		if (line.startsWith("--- ")) {
			const p = line.slice(4).trim();
			file.oldPath = unquote(stripPrefix(p));
			continue;
		}
		if (line.startsWith("+++ ")) {
			const p = line.slice(4).trim();
			file.newPath = unquote(stripPrefix(p));
			continue;
		}
		if (
			line.startsWith("index ") ||
			line.startsWith("old mode") ||
			line.startsWith("new mode") ||
			line.startsWith("similarity index") ||
			line.startsWith("dissimilarity index")
		) {
			continue;
		}

		// Hunk header, e.g. "@@ -1,4 +1,6 @@ context" or combined "@@@ ... @@@".
		const atMatch = line.match(/^(@+)/);
		if (atMatch) {
			const atCount = atMatch[1].length;
			prefixCols = Math.max(1, atCount - 1);
			const combined = atCount > 2;

			// The last "+start" range is the new-file range; first "-start" the old.
			const ranges = [...line.matchAll(/[-+](\d+)(?:,\d+)?/g)];
			const minus = ranges.filter((r) => r[0][0] === "-");
			const plus = ranges.filter((r) => r[0][0] === "+");
			oldNum = minus.length ? parseInt(minus[0][1], 10) : 0;
			newNum = plus.length ? parseInt(plus[plus.length - 1][1], 10) : 0;

			hunk = { header: line, lines: [], combined };
			file.hunks.push(hunk);
			continue;
		}

		if (!hunk) {
			// Unrecognised line outside a hunk – ignore.
			continue;
		}

		// A zero-length line only ever appears as the trailing artifact of
		// splitting the patch on "\n"; real diff content lines always carry a
		// prefix character (space / + / -), so an empty line is never content.
		if (line.length === 0) {
			continue;
		}

		// "\ No newline at end of file"
		if (line.startsWith("\\")) {
			hunk.lines.push({
				type: "meta",
				oldNum: null,
				newNum: null,
				text: line.slice(2),
				sign: "",
			});
			continue;
		}

		const sign = line.slice(0, prefixCols);
		const content = line.slice(prefixCols);
		const isAdd = sign.includes("+");
		const isDel = sign.includes("-");

		if (isAdd && !isDel) {
			hunk.lines.push({
				type: "add",
				oldNum: null,
				newNum: newNum++,
				text: content,
				sign,
			});
			file.additions++;
		} else if (isDel && !isAdd) {
			hunk.lines.push({
				type: "del",
				oldNum: oldNum++,
				newNum: null,
				text: content,
				sign,
			});
			file.deletions++;
		} else {
			// Context (or, rarely in combined diffs, mixed) line.
			hunk.lines.push({
				type: "context",
				oldNum: oldNum++,
				newNum: newNum++,
				text: content,
				sign,
			});
		}
	}

	pushFile();
	return files;
}

const STATUS_LABEL: Record<FileStatus, string> = {
	added: "added",
	deleted: "deleted",
	modified: "modified",
	renamed: "renamed",
	copied: "copied",
	binary: "binary",
};

/** Lines beyond which a file's body is collapsed by default. */
const LARGE_FILE_LINES = 600;

export interface FileReviewHooks {
	/** Whether this file currently counts as reviewed. */
	isReviewed: (file: DiffFile) => boolean;
	/** Called when the user ticks/unticks a file's review circle. */
	onToggle: (file: DiffFile, reviewed: boolean) => void;
}

export interface RenderDiffOptions {
	/** Called the first time a file body is rendered (for perf accounting). */
	onRenderFile?: (file: DiffFile) => void;
	/** When provided, each file header gets a circular "reviewed" checkbox. */
	fileReview?: FileReviewHooks;
	/**
	 * When true, files that are already reviewed are hidden from the diff, so
	 * ticking a file's circle drops it from view and the next unreviewed file
	 * rises into its place.
	 */
	hideReviewed?: boolean;
}

/** Stable identity for a file within a commit (matches the displayed name). */
export function fileReviewKey(file: DiffFile): string {
	return file.newPath || file.oldPath;
}

/** Paints a circular file-review checkbox (and its file card) for `reviewed`. */
export function paintFileCheck(check: HTMLElement, reviewed: boolean): void {
	check.toggleClass("is-checked", reviewed);
	check.setAttr("aria-checked", String(reviewed));
	check.empty();
	if (reviewed) setIcon(check, "check");
	const fileEl = check.closest<HTMLElement>(".ghr-file");
	fileEl?.toggleClass("ghr-file-reviewed", reviewed);
}

/**
 * Renders parsed diff files into `container` using Obsidian DOM helpers.
 * Large files render their bodies lazily on first expand.
 */
export function renderDiff(
	container: HTMLElement,
	files: DiffFile[],
	options: RenderDiffOptions = {}
): void {
	container.empty();

	if (files.length === 0) {
		container.createDiv({
			cls: "ghr-empty",
			text: "No file changes in this commit.",
		});
		return;
	}

	let hiddenAtRender = 0;
	for (const file of files) {
		const fileEl = container.createDiv({ cls: "ghr-file" });

		const header = fileEl.createDiv({ cls: "ghr-file-header" });

		const caret = header.createSpan({ cls: "ghr-caret" });
		setIcon(caret, "chevron-down");

		const status = header.createSpan({
			cls: `ghr-status ghr-status-${file.status}`,
			text: STATUS_LABEL[file.status],
		});
		status.setAttr("aria-label", `File ${STATUS_LABEL[file.status]}`);

		const nameEl = header.createSpan({ cls: "ghr-file-name" });
		if (file.status === "renamed" || file.status === "copied") {
			nameEl.setText(`${file.oldPath} → ${file.newPath}`);
		} else {
			nameEl.setText(file.newPath || file.oldPath);
		}

		const stat = header.createSpan({ cls: "ghr-file-stat" });
		if (file.additions > 0) {
			stat.createSpan({
				cls: "ghr-stat-add",
				text: `+${file.additions}`,
			});
		}
		if (file.deletions > 0) {
			stat.createSpan({
				cls: "ghr-stat-del",
				text: `−${file.deletions}`,
			});
		}

		const body = fileEl.createDiv({ cls: "ghr-file-body" });

		// Establish a body renderer (a no-op for files with nothing to expand)
		// and the initial collapsed state, then wire collapse + the review
		// circle uniformly for every file kind.
		let renderBody: () => void = () => {};

		if (file.isBinary && file.hunks.length === 0) {
			body.createDiv({
				cls: "ghr-binary",
				text: "Binary file — no text diff available.",
			});
		} else if (file.hunks.length === 0) {
			body.createDiv({
				cls: "ghr-binary",
				text:
					file.status === "renamed" || file.status === "copied"
						? "Renamed/copied with no content changes."
						: "No content changes.",
			});
		} else {
			const totalLines = file.hunks.reduce(
				(n, h) => n + h.lines.length,
				0
			);
			let rendered = false;
			renderBody = () => {
				if (rendered) return;
				rendered = true;
				renderFileBody(body, file);
			};

			if (totalLines > LARGE_FILE_LINES) {
				setCollapsed(fileEl, caret, true);
				body.createDiv({
					cls: "ghr-large-hint",
					text: `Large change (${totalLines} lines). Click the header to expand.`,
				});
			} else {
				renderBody();
			}
		}

		wireCollapse(header, caret, fileEl, renderBody);

		// The review circle sits at the far right of the header. Ticking a file
		// collapses it; with "hide reviewed" on it's hidden instead, so the next
		// unreviewed file rises into its place.
		if (options.fileReview) {
			if (options.hideReviewed && options.fileReview.isReviewed(file)) {
				fileEl.addClass("ghr-file-hidden");
				hiddenAtRender++;
			}
			wireFileCheck(header, file, options.fileReview, (reviewed) => {
				if (reviewed && options.hideReviewed) {
					fileEl.addClass("ghr-file-hidden");
				} else {
					setCollapsed(fileEl, caret, reviewed, renderBody);
				}
			});
		}
	}

	// If "hide reviewed" hid every file, say so rather than showing a blank pane.
	if (options.hideReviewed && hiddenAtRender === files.length) {
		container.createDiv({
			cls: "ghr-all-hidden",
			text: `All ${files.length} file${
				files.length === 1 ? "" : "s"
			} reviewed and hidden — turn off "Hide reviewed" to see them.`,
		});
	}
}

function wireFileCheck(
	header: HTMLElement,
	file: DiffFile,
	hooks: FileReviewHooks,
	onAfterToggle?: (reviewed: boolean) => void
): void {
	const key = fileReviewKey(file);
	const check = header.createSpan({
		cls: "ghr-file-check",
		attr: {
			role: "checkbox",
			tabindex: "0",
			"aria-label": `Mark ${key} reviewed`,
		},
	});
	check.dataset.ghrKey = key;
	paintFileCheck(check, hooks.isReviewed(file));

	const toggle = (e: Event) => {
		// Never let a review click also collapse/expand via the header handler.
		e.preventDefault();
		e.stopPropagation();
		const next = !check.hasClass("is-checked");
		paintFileCheck(check, next);
		hooks.onToggle(file, next);
		onAfterToggle?.(next);
	};
	check.addEventListener("click", toggle);
	check.addEventListener("keydown", (e: KeyboardEvent) => {
		// Ignore auto-repeat so a held key activates once, like a native control.
		if (e.repeat) return;
		if (e.key === "Enter" || e.key === " ") toggle(e);
	});
}

/** Sets a file's collapsed state and keeps the caret icon in sync. */
function setCollapsed(
	fileEl: HTMLElement,
	caret: HTMLElement,
	collapsed: boolean,
	onExpand?: () => void
): void {
	if (collapsed) {
		fileEl.addClass("ghr-collapsed");
		setIcon(caret, "chevron-right");
	} else {
		fileEl.removeClass("ghr-collapsed");
		setIcon(caret, "chevron-down");
		onExpand?.();
	}
}

function wireCollapse(
	header: HTMLElement,
	caret: HTMLElement,
	fileEl: HTMLElement,
	onExpand?: () => void
): void {
	header.addEventListener("click", () => {
		setCollapsed(
			fileEl,
			caret,
			!fileEl.hasClass("ghr-collapsed"),
			onExpand
		);
	});
}

function renderFileBody(body: HTMLElement, file: DiffFile): void {
	body.empty();
	const table = body.createDiv({ cls: "ghr-diff-table" });

	for (const hunk of file.hunks) {
		const hunkRow = table.createDiv({ cls: "ghr-line ghr-hunk" });
		hunkRow.createDiv({ cls: "ghr-gutter ghr-gutter-old" });
		hunkRow.createDiv({ cls: "ghr-gutter ghr-gutter-new" });
		hunkRow.createDiv({ cls: "ghr-code", text: hunk.header });

		for (const dl of hunk.lines) {
			const row = table.createDiv({
				cls: `ghr-line ghr-line-${dl.type}`,
			});
			row.createDiv({
				cls: "ghr-gutter ghr-gutter-old",
				text: dl.oldNum != null ? String(dl.oldNum) : "",
			});
			row.createDiv({
				cls: "ghr-gutter ghr-gutter-new",
				text: dl.newNum != null ? String(dl.newNum) : "",
			});
			const code = row.createDiv({ cls: "ghr-code" });
			const signChar =
				dl.type === "add" ? "+" : dl.type === "del" ? "-" : " ";
			code.createSpan({ cls: "ghr-sign", text: signChar });
			// Empty string still needs a node so the row keeps its height.
			code.createSpan({ cls: "ghr-text", text: dl.text });
		}
	}
}
