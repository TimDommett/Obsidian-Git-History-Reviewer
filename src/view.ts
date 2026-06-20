import { App, ItemView, Modal, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type GitHistoryReviewerPlugin from "./main";
import { CommitMeta, GitError } from "./git";
import {
	DiffFile,
	FileReviewHooks,
	fileReviewKey,
	paintFileCheck,
	parseDiff,
	renderDiff,
} from "./diff";

export const VIEW_TYPE_GIT_HISTORY = "git-history-reviewer-view";

export type HistoryFilter = "all" | "approved" | "unapproved";

const RENDER_CHUNK = 80;

function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";
	const seconds = Math.round((Date.now() - then) / 1000);
	const abs = Math.abs(seconds);
	const units: [number, string][] = [
		[60, "second"],
		[60, "minute"],
		[24, "hour"],
		[30, "day"],
		[12, "month"],
		[Number.POSITIVE_INFINITY, "year"],
	];
	let value = abs;
	let unit = "second";
	let divisor = 1;
	for (const [step, name] of units) {
		if (value < step) {
			unit = name;
			break;
		}
		value = value / step;
		divisor *= step;
		unit = name;
	}
	const rounded = Math.floor(abs / divisor) || (abs < 60 ? abs : 1);
	const label = rounded === 1 ? unit : `${unit}s`;
	return seconds >= 0
		? `${rounded} ${label} ago`
		: `in ${rounded} ${label}`;
}

function absoluteTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString();
}

export class GitHistoryView extends ItemView {
	private commits: CommitMeta[] = [];
	private filtered: CommitMeta[] = [];
	private renderedCount = 0;
	private selectedHash: string | null = null;
	private filter: HistoryFilter;
	private query = "";
	private diffCache = new Map<string, DiffFile[]>();
	private firstParentCache = new Map<string, DiffFile[]>();
	private rowByHash = new Map<string, HTMLElement>();
	private observer: IntersectionObserver | null = null;

	/** Files currently shown for the selected commit (drives per-file progress). */
	private activeFiles: DiffFile[] = [];
	/**
	 * Every file key that belongs to the selected commit, regardless of which
	 * view is shown. For a merge this is the union of the combined and
	 * first-parent diffs, so downgrading an approval never loses files that
	 * aren't in the currently-visible set.
	 */
	private allReviewKeys: string[] = [];

	// Element references.
	private listWrapEl!: HTMLElement;
	private listEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private sentinelEl!: HTMLElement;
	private countEl!: HTMLElement;
	private ignorePillEl!: HTMLElement;
	private searchInputEl!: HTMLInputElement;
	private filterSelectEl!: HTMLSelectElement;
	// Detail-pane controls that need live updates as review state changes.
	private approveCheckEl: HTMLInputElement | null = null;
	private approveStatusEl: HTMLElement | null = null;
	private progressEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: GitHistoryReviewerPlugin) {
		super(leaf);
		this.filter = plugin.settings.defaultFilter;
	}

	getViewType(): string {
		return VIEW_TYPE_GIT_HISTORY;
	}

	getDisplayText(): string {
		return "Git History Reviewer";
	}

	getIcon(): string {
		return "history";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("ghr-root");
		this.buildToolbar();
		this.buildBody();
		await this.reload();
	}

	async onClose(): Promise<void> {
		this.observer?.disconnect();
		this.observer = null;
	}

	// ---------------------------------------------------------------- UI build

	private buildToolbar(): void {
		const bar = this.contentEl.createDiv({ cls: "ghr-toolbar" });

		const title = bar.createDiv({ cls: "ghr-title" });
		const icon = title.createSpan({ cls: "ghr-title-icon" });
		setIcon(icon, "history");
		title.createSpan({ text: "Git History Reviewer" });

		const controls = bar.createDiv({ cls: "ghr-controls" });

		this.searchInputEl = controls.createEl("input", {
			cls: "ghr-search",
			attr: { type: "search", placeholder: "Search message / hash / author…" },
		});
		this.searchInputEl.addEventListener("input", () => {
			this.query = this.searchInputEl.value.trim().toLowerCase();
			this.applyFilter();
		});

		this.filterSelectEl = controls.createEl("select", {
			cls: "ghr-filter",
		});
		const options: [HistoryFilter, string][] = [
			["all", "All commits"],
			["unapproved", "Needs review"],
			["approved", "Approved"],
		];
		for (const [value, label] of options) {
			const opt = this.filterSelectEl.createEl("option", {
				text: label,
				value,
			});
			if (value === this.filter) opt.selected = true;
		}
		this.filterSelectEl.addEventListener("change", () => {
			this.filter = this.filterSelectEl.value as HistoryFilter;
			this.applyFilter();
		});

		const approveBefore = controls.createEl("button", {
			cls: "ghr-icon-btn",
			attr: { "aria-label": "Approve all commits up to a date…" },
		});
		setIcon(approveBefore, "calendar-check");
		approveBefore.addEventListener("click", () =>
			this.openApproveBeforeDate()
		);

		const refresh = controls.createEl("button", {
			cls: "ghr-icon-btn",
			attr: { "aria-label": "Reload history" },
		});
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => void this.reload());

		this.ignorePillEl = bar.createDiv({ cls: "ghr-pill" });
		this.ignorePillEl.addEventListener("click", () => void this.onPillClick());

		this.countEl = bar.createDiv({ cls: "ghr-count" });
	}

	private buildBody(): void {
		const body = this.contentEl.createDiv({ cls: "ghr-body" });

		const listWrap = body.createDiv({ cls: "ghr-list-wrap" });
		this.listWrapEl = listWrap;
		this.listEl = listWrap.createDiv({ cls: "ghr-list" });
		this.sentinelEl = listWrap.createDiv({ cls: "ghr-sentinel" });

		this.detailEl = body.createDiv({ cls: "ghr-detail" });
		this.renderDetailPlaceholder("Select a commit to review its changes.");

		this.observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) this.renderNextChunk();
				}
			},
			{ root: listWrap, rootMargin: "200px" }
		);
		this.observer.observe(this.sentinelEl);
	}

	// ------------------------------------------------------------- data loading

	async reload(): Promise<void> {
		const prevHash = this.selectedHash;
		this.diffCache.clear();
		this.firstParentCache.clear();
		this.listEl.empty();
		this.rowByHash.clear();
		this.commits = [];
		this.filtered = [];
		this.renderedCount = 0;

		// Drop stale detail-pane state and its live element refs; the pane is
		// rebuilt below only if the previously-selected commit survives.
		this.selectedHash = null;
		this.activeFiles = [];
		this.allReviewKeys = [];
		this.approveCheckEl = null;
		this.progressEl = null;
		this.approveStatusEl = null;
		this.renderDetailPlaceholder("Select a commit to review its changes.");

		const git = this.plugin.git;
		if (!git.basePath) {
			this.renderListMessage(
				"This vault has no filesystem access. Git History Reviewer only works on desktop with a local vault."
			);
			this.updateCounts();
			return;
		}

		const isRepo = await git.isRepo();
		if (!isRepo) {
			this.renderListMessage(
				"No git repository found at the vault root. Initialise git (or set up the Obsidian Git plugin) and reload."
			);
			this.updateCounts();
			await this.refreshIgnorePill();
			return;
		}

		this.renderListMessage("Loading commits…");
		try {
			this.commits = await git.getCommits(this.plugin.settings.maxCommits);
		} catch (err) {
			const message =
				err instanceof GitError ? err.message : String(err);
			this.renderListMessage(`Failed to read history:\n${message}`);
			this.updateCounts();
			return;
		}

		this.applyFilter();

		// Re-open the previously-selected commit if it still exists, rebuilding
		// the detail pane from fresh data (its diff cache was cleared above).
		if (prevHash && this.commits.some((c) => c.hash === prevHash)) {
			await this.select(prevHash);
		}

		await this.refreshIgnorePill();
	}

	private renderListMessage(text: string): void {
		this.listEl.empty();
		this.rowByHash.clear();
		this.listEl.createDiv({ cls: "ghr-list-message", text });
	}

	// ---------------------------------------------------------------- filtering

	private matchesFilter(c: CommitMeta): boolean {
		const approved = this.plugin.isApproved(c.hash);
		if (this.filter === "approved" && !approved) return false;
		if (this.filter === "unapproved" && approved) return false;
		if (this.query) {
			const haystack =
				`${c.subject}\n${c.body}\n${c.hash}\n${c.author}\n${c.email}`.toLowerCase();
			if (!haystack.includes(this.query)) return false;
		}
		return true;
	}

	private applyFilter(): void {
		this.filtered = this.commits.filter((c) => this.matchesFilter(c));
		this.listEl.empty();
		this.rowByHash.clear();
		this.renderedCount = 0;

		if (this.commits.length === 0) {
			this.renderListMessage("No commits in this repository yet.");
		} else if (this.filtered.length === 0) {
			this.renderListMessage("No commits match the current filter.");
		} else {
			this.renderNextChunk();
		}
		this.updateCounts();
	}

	private renderNextChunk(): void {
		if (this.renderedCount >= this.filtered.length) return;
		const end = Math.min(
			this.renderedCount + RENDER_CHUNK,
			this.filtered.length
		);
		for (let i = this.renderedCount; i < end; i++) {
			this.renderRow(this.filtered[i]);
		}
		this.renderedCount = end;

		// If the rendered rows don't yet fill the scroll area, keep going.
		// Otherwise the IntersectionObserver never re-fires on a tall pane.
		if (
			this.renderedCount < this.filtered.length &&
			this.listWrapEl.scrollHeight <= this.listWrapEl.clientHeight
		) {
			this.renderNextChunk();
		}
	}

	private renderRow(c: CommitMeta): void {
		const row = this.listEl.createDiv({ cls: "ghr-row" });
		row.dataset.hash = c.hash;
		this.rowByHash.set(c.hash, row);

		const approved = this.plugin.isApproved(c.hash);
		if (approved) row.addClass("ghr-approved");
		if (c.hash === this.selectedHash) row.addClass("ghr-selected");

		const check = row.createEl("input", {
			cls: "ghr-row-check",
			attr: { type: "checkbox", "aria-label": "Mark reviewed & approved" },
		});
		check.checked = approved;
		check.addEventListener("click", (e) => e.stopPropagation());
		check.addEventListener("change", () => {
			// Approving from the list advances the detail pane to the next commit.
			void this.toggleApprove(c, check.checked, true);
		});

		const main = row.createDiv({ cls: "ghr-row-main" });
		const subjectLine = main.createDiv({ cls: "ghr-row-subject" });
		if (c.isMerge) {
			const badge = subjectLine.createSpan({
				cls: "ghr-merge-badge",
				text: "merge",
			});
			badge.setAttr("aria-label", `Merge of ${c.parents.length} parents`);
		}
		subjectLine.createSpan({
			cls: "ghr-row-subject-text",
			text: c.subject || "(no commit message)",
		});

		const metaLine = main.createDiv({ cls: "ghr-row-meta" });
		metaLine.createSpan({ cls: "ghr-row-hash", text: c.shortHash });
		metaLine.createSpan({ cls: "ghr-row-author", text: c.author });
		const time = metaLine.createSpan({
			cls: "ghr-row-date",
			text: relativeTime(c.dateISO),
		});
		time.setAttr("aria-label", absoluteTime(c.dateISO));

		row.addEventListener("click", () => void this.select(c.hash));
	}

	// ----------------------------------------------------------------- detail

	private async select(hash: string, scrollIntoView = false): Promise<void> {
		if (this.selectedHash) {
			this.rowByHash.get(this.selectedHash)?.removeClass("ghr-selected");
		}
		this.selectedHash = hash;

		// The target row may be past the first lazily-rendered chunk; render up
		// to it so the highlight and scroll actually land on a real element.
		if (!this.rowByHash.has(hash)) {
			const idx = this.filtered.findIndex((c) => c.hash === hash);
			while (
				idx !== -1 &&
				this.renderedCount <= idx &&
				this.renderedCount < this.filtered.length
			) {
				this.renderNextChunk();
			}
		}

		const row = this.rowByHash.get(hash);
		row?.addClass("ghr-selected");
		if (scrollIntoView) row?.scrollIntoView({ block: "nearest" });

		const commit = this.commits.find((c) => c.hash === hash);
		if (!commit) return;
		await this.renderDetail(commit);
	}

	private renderDetailPlaceholder(text: string): void {
		this.detailEl.empty();
		this.detailEl.createDiv({ cls: "ghr-detail-placeholder", text });
	}

	private async renderDetail(commit: CommitMeta): Promise<void> {
		this.detailEl.empty();
		// Reset per-commit state; the diff load below repopulates it.
		this.activeFiles = [];
		this.allReviewKeys = [];

		const head = this.detailEl.createDiv({ cls: "ghr-detail-head" });

		const topRow = head.createDiv({ cls: "ghr-detail-top" });
		const approveWrap = topRow.createEl("label", {
			cls: "ghr-approve",
		});
		const approveCheck = approveWrap.createEl("input", {
			attr: { type: "checkbox" },
		});
		approveCheck.checked = this.plugin.isApproved(commit.hash);
		approveCheck.addEventListener("change", () => {
			void this.toggleApprove(commit, approveCheck.checked);
		});
		approveWrap.createSpan({ text: "Reviewed & approved" });
		this.approveCheckEl = approveCheck;

		// Live per-file review progress (e.g. "2 / 5 files reviewed").
		this.progressEl = topRow.createSpan({
			cls: "ghr-progress",
			attr: { role: "status", "aria-live": "polite" },
		});

		// Holder for the "approved … ago" stamp, kept in sync as state changes.
		this.approveStatusEl = topRow.createSpan({ cls: "ghr-reviewed-at" });
		this.syncApproveStatus(commit);

		head.createDiv({
			cls: "ghr-detail-subject",
			text: commit.subject || "(no commit message)",
		});

		if (commit.body) {
			head.createEl("pre", {
				cls: "ghr-detail-body",
				text: commit.body,
			});
		}

		const metaGrid = head.createDiv({ cls: "ghr-detail-meta" });
		const hashRow = metaGrid.createDiv({ cls: "ghr-meta-row" });
		hashRow.createSpan({ cls: "ghr-meta-key", text: "commit" });
		const hashVal = hashRow.createSpan({
			cls: "ghr-meta-val ghr-mono ghr-copyable",
			text: commit.hash,
		});
		hashVal.setAttr("aria-label", "Click to copy");
		hashVal.addEventListener("click", () => {
			void navigator.clipboard.writeText(commit.hash);
			new Notice("Commit hash copied");
		});

		const authorRow = metaGrid.createDiv({ cls: "ghr-meta-row" });
		authorRow.createSpan({ cls: "ghr-meta-key", text: "author" });
		authorRow.createSpan({
			cls: "ghr-meta-val",
			text: `${commit.author} <${commit.email}>`,
		});

		const dateRow = metaGrid.createDiv({ cls: "ghr-meta-row" });
		dateRow.createSpan({ cls: "ghr-meta-key", text: "date" });
		dateRow.createSpan({
			cls: "ghr-meta-val",
			text: `${absoluteTime(commit.dateISO)} (${relativeTime(commit.dateISO)})`,
		});

		if (commit.parents.length) {
			const parentRow = metaGrid.createDiv({ cls: "ghr-meta-row" });
			parentRow.createSpan({ cls: "ghr-meta-key", text: "parents" });
			parentRow.createSpan({
				cls: "ghr-meta-val ghr-mono",
				text: commit.parents.map((p) => p.slice(0, 8)).join(", "),
			});
		}

		const diffWrap = this.detailEl.createDiv({ cls: "ghr-diff-wrap" });
		await this.renderDiffSection(diffWrap, commit);
	}

	private async renderDiffSection(
		diffWrap: HTMLElement,
		commit: CommitMeta
	): Promise<void> {
		diffWrap.empty();
		diffWrap.createDiv({ cls: "ghr-loading", text: "Loading diff…" });

		let files: DiffFile[];
		try {
			files = await this.getDiff(commit.hash);
		} catch (err) {
			if (this.selectedHash !== commit.hash) return;
			const message = err instanceof GitError ? err.message : String(err);
			diffWrap.empty();
			diffWrap.createDiv({
				cls: "ghr-error",
				text: `Could not load diff:\n${message}`,
			});
			return;
		}
		// Guard against the selection changing while we awaited.
		if (this.selectedHash !== commit.hash) return;
		diffWrap.empty();

		const hooks = this.fileReviewHooks(commit);
		const diffTarget = diffWrap.createDiv();

		if (!commit.isMerge) {
			this.activeFiles = files;
			this.allReviewKeys = files.map(fileReviewKey);
			renderDiff(diffTarget, files, { fileReview: hooks });
			this.updateProgress(commit);
			return;
		}

		// Merge commit. Its combined diff only contains conflict resolutions
		// (nothing for a clean merge), which is rarely what you want to review,
		// so we default to the full set of changes the merge introduced
		// relative to its first parent — auto-expanded.
		let fpFiles: DiffFile[] | null = null;
		try {
			fpFiles = await this.getFirstParentDiff(commit);
		} catch {
			fpFiles = null; // fall back to the combined diff below
		}
		if (this.selectedHash !== commit.hash) return;

		// The review universe is the union of both views, so downgrading an
		// approval never loses files that aren't in the currently-shown set.
		this.allReviewKeys = Array.from(
			new Set([...files, ...(fpFiles ?? [])].map(fileReviewKey))
		);

		// An empty (but successful) first-parent diff is treated as "no full
		// view available" — same as a load failure — so we don't auto-expand
		// into an empty pane with a dead toggle.
		const hasFull = fpFiles != null && fpFiles.length > 0;

		const bar = diffWrap.createDiv({ cls: "ghr-merge-actions" });
		diffWrap.insertBefore(bar, diffTarget);
		const note = bar.createSpan({ cls: "ghr-merge-note" });
		const btn = bar.createEl("button", { cls: "ghr-merge-btn" });

		let showingFull = hasFull;

		const renderView = () => {
			diffTarget.empty();
			if (showingFull && hasFull && fpFiles) {
				this.activeFiles = fpFiles;
				note.setText(
					"Showing every change this merge introduced (vs its first parent)."
				);
				btn.setText("Show merge's own changes");
				renderDiff(diffTarget, fpFiles, { fileReview: hooks });
			} else {
				this.activeFiles = files;
				note.setText(
					files.length === 0
						? "Clean merge — it has no conflict-resolution changes of its own."
						: "Showing this merge's own changes (conflict resolutions)."
				);
				btn.setText(
					hasFull
						? "View full changes vs first parent"
						: "Full changes unavailable"
				);
				if (files.length > 0) {
					renderDiff(diffTarget, files, { fileReview: hooks });
				} else {
					diffTarget.createDiv({
						cls: "ghr-empty",
						text: "No changes in this merge's combined diff.",
					});
				}
			}
			this.updateProgress(commit);
		};

		if (!hasFull) btn.disabled = true;
		btn.addEventListener("click", () => {
			if (!hasFull) return;
			showingFull = !showingFull;
			renderView();
		});
		renderView();
	}

	// ---------------------------------------------------------- per-file review

	private fileReviewHooks(commit: CommitMeta): FileReviewHooks {
		return {
			isReviewed: (file) =>
				this.plugin.isFileReviewed(commit.hash, fileReviewKey(file)),
			onToggle: (file, reviewed) =>
				void this.onFileToggle(commit, file, reviewed),
		};
	}

	private async onFileToggle(
		commit: CommitMeta,
		file: DiffFile,
		reviewed: boolean
	): Promise<void> {
		const key = fileReviewKey(file);
		const wasApproved = this.plugin.isApproved(commit.hash);

		if (!reviewed && wasApproved) {
			// Un-ticking one file on an approved commit downgrades it to a
			// partial review: every other file stays reviewed, approval drops.
			// Use the full per-commit key universe (not just the visible view)
			// so a merge's other-view files aren't silently lost.
			const allKeys =
				this.allReviewKeys.length > 0
					? this.allReviewKeys
					: this.activeFiles.map(fileReviewKey);
			await this.plugin.downgradeApprovalExcept(commit.hash, allKeys, key);
		} else {
			await this.plugin.setFileReviewed(commit.hash, key, reviewed);

			// Once every file is individually ticked, optionally approve the
			// whole commit (on by default).
			if (
				reviewed &&
				this.plugin.settings.autoApproveAllFiles &&
				!this.plugin.isApproved(commit.hash) &&
				this.allReviewKeys.length > 0 &&
				this.plugin.reviewedFileCount(
					commit.hash,
					this.allReviewKeys
				) === this.allReviewKeys.length
			) {
				await this.plugin.setApproved(commit.hash, true);
			}
		}

		const approvalChanged =
			this.plugin.isApproved(commit.hash) !== wasApproved;

		// If completing every file just auto-approved the open commit, advance
		// to the next one — the same courtesy as approving from the list.
		// Capture the neighbour before afterReviewStateChange re-filters the list.
		const autoApproved =
			approvalChanged && this.plugin.isApproved(commit.hash);
		const nextHash =
			autoApproved && this.selectedHash === commit.hash
				? this.neighbourHash(commit.hash)
				: null;

		this.afterReviewStateChange(commit, approvalChanged);

		if (nextHash) await this.select(nextHash, true);
	}

	/** Repaints every file circle in the detail pane from current state. */
	private syncFileChecks(commit: CommitMeta): void {
		const checks =
			this.detailEl.querySelectorAll<HTMLElement>(".ghr-file-check");
		checks.forEach((check) => {
			const key = check.dataset.ghrKey ?? "";
			paintFileCheck(
				check,
				this.plugin.isFileReviewed(commit.hash, key)
			);
		});
	}

	private updateProgress(commit: CommitMeta): void {
		if (!this.progressEl) return;
		const keys = this.activeFiles.map(fileReviewKey);
		const total = keys.length;
		this.progressEl.empty();
		this.progressEl.removeClass("ghr-progress-ready", "ghr-progress-done");
		if (total === 0) return;

		const done = this.plugin.reviewedFileCount(commit.hash, keys);
		this.progressEl.createSpan({
			text: `${done} / ${total} files reviewed`,
		});

		if (done === total) {
			if (this.plugin.isApproved(commit.hash)) {
				this.progressEl.addClass("ghr-progress-done");
			} else {
				this.progressEl.addClass("ghr-progress-ready");
				this.progressEl.createSpan({
					cls: "ghr-progress-hint",
					text: " — ready to approve",
				});
			}
		}
	}

	/** Rebuilds the "approved … ago" stamp from current state. */
	private syncApproveStatus(commit: CommitMeta): void {
		if (!this.approveStatusEl) return;
		this.approveStatusEl.empty();
		const review = this.plugin.getReview(commit.hash);
		if (review?.approved && review.reviewedAt) {
			this.approveStatusEl.setText(
				`approved ${relativeTime(review.reviewedAt)}`
			);
			this.approveStatusEl.setAttr(
				"aria-label",
				absoluteTime(review.reviewedAt)
			);
		} else {
			this.approveStatusEl.removeAttribute("aria-label");
		}
	}

	/** Reflects the latest review state across the detail pane and list row. */
	private afterReviewStateChange(
		commit: CommitMeta,
		approvalChanged: boolean
	): void {
		this.syncFileChecks(commit);
		this.updateProgress(commit);
		this.syncApproveStatus(commit);
		if (this.approveCheckEl) {
			this.approveCheckEl.checked = this.plugin.isApproved(commit.hash);
		}
		if (approvalChanged && this.filter !== "all") {
			this.applyFilter();
		} else {
			this.updateRow(commit.hash);
			this.updateCounts();
		}
	}

	private updateRow(hash: string): void {
		const row = this.rowByHash.get(hash);
		if (!row) return;
		const approved = this.plugin.isApproved(hash);
		row.toggleClass("ghr-approved", approved);
		const check = row.querySelector<HTMLInputElement>(".ghr-row-check");
		if (check) check.checked = approved;
	}

	// --------------------------------------------------- approve up to a date

	private openApproveBeforeDate(): void {
		if (this.commits.length === 0) {
			new Notice("No commits loaded yet.");
			return;
		}
		new ApproveBeforeDateModal(
			this.app,
			this.commits,
			async (hashes) => {
				try {
					const n = await this.plugin.approveMany(hashes);
					new Notice(
						n === 0
							? "Those commits were already approved."
							: `Approved ${n} commit${n === 1 ? "" : "s"}.`
					);
					this.applyFilter();
					const selected = this.selectedHash
						? this.commits.find(
								(c) => c.hash === this.selectedHash
						  )
						: undefined;
					if (selected) {
						if (this.approveCheckEl) {
							this.approveCheckEl.checked =
								this.plugin.isApproved(selected.hash);
						}
						this.syncFileChecks(selected);
						this.syncApproveStatus(selected);
						this.updateProgress(selected);
					}
					for (const v of this.plugin.getViews()) {
						if (v !== this) v.refreshApprovals();
					}
				} catch (err) {
					new Notice(
						"Failed to save approvals — see console for details."
					);
					console.error(
						"Git History Reviewer: bulk approve failed",
						err
					);
				}
			}
		).open();
	}

	private async getDiff(hash: string): Promise<DiffFile[]> {
		const cached = this.diffCache.get(hash);
		if (cached) return cached;
		const raw = await this.plugin.git.getCommitDiff(hash);
		const files = parseDiff(raw);
		this.diffCache.set(hash, files);
		return files;
	}

	private async getFirstParentDiff(commit: CommitMeta): Promise<DiffFile[]> {
		const cached = this.firstParentCache.get(commit.hash);
		if (cached) return cached;
		const parent = commit.parents[0];
		const raw = await this.plugin.git.getDiffAgainstParent(
			parent,
			commit.hash
		);
		const files = parseDiff(raw);
		this.firstParentCache.set(commit.hash, files);
		return files;
	}

	// -------------------------------------------------------------- approvals

	private async toggleApprove(
		commit: CommitMeta,
		approved: boolean,
		advanceAfter = false
	): Promise<void> {
		// Only advance when approving the commit that's currently open on the
		// right. Capture the neighbour before the list is re-filtered.
		const advance =
			advanceAfter && approved && this.selectedHash === commit.hash;
		const nextHash = advance ? this.neighbourHash(commit.hash) : null;

		await this.plugin.setApproved(commit.hash, approved);

		this.updateRow(commit.hash);

		// Keep the open detail pane consistent (unless we're about to move off it).
		if (this.selectedHash === commit.hash && !advance) {
			if (this.approveCheckEl) this.approveCheckEl.checked = approved;
			this.syncFileChecks(commit);
			this.updateProgress(commit);
			this.syncApproveStatus(commit);
		}

		// If the active filter would hide/show this commit, rebuild the list
		// but keep the current selection highlighted.
		if (this.filter !== "all") {
			this.applyFilter();
		} else {
			this.updateCounts();
		}

		if (advance && nextHash) {
			await this.select(nextHash, true);
		}
	}

	/**
	 * The commit to jump to after the current one is approved from the list:
	 * the next one in the visible order, or the previous if it was last.
	 */
	private neighbourHash(hash: string): string | null {
		const idx = this.filtered.findIndex((c) => c.hash === hash);
		if (idx === -1) return null;
		const next = this.filtered[idx + 1] ?? this.filtered[idx - 1];
		return next ? next.hash : null;
	}

	// ------------------------------------------------------------------ counts

	private updateCounts(): void {
		const total = this.commits.length;
		const approved = this.commits.filter((c) =>
			this.plugin.isApproved(c.hash)
		).length;
		const shown = this.filtered.length;
		this.countEl.empty();
		this.countEl.createSpan({
			cls: "ghr-count-approved",
			text: `${approved} approved`,
		});
		this.countEl.createSpan({
			text: ` · ${total - approved} to review · ${shown} shown`,
		});
	}

	// -------------------------------------------------------- gitignore pill

	async refreshIgnorePill(): Promise<void> {
		const git = this.plugin.git;
		if (!git.basePath || !(await git.isRepo())) {
			this.ignorePillEl.removeClass("ghr-pill-warn", "ghr-pill-ok");
			this.ignorePillEl.empty();
			return;
		}
		const rel = this.plugin.dataFileRepoPath();
		const ignored = await git.isIgnored(rel);
		const tracked = ignored ? false : await git.isTracked(rel);
		this.ignorePillEl.empty();
		const icon = this.ignorePillEl.createSpan({ cls: "ghr-pill-icon" });
		if (ignored) {
			this.ignorePillEl.addClass("ghr-pill-ok");
			this.ignorePillEl.removeClass("ghr-pill-warn");
			setIcon(icon, "shield-check");
			this.ignorePillEl.createSpan({ text: "Review data is local-only" });
			this.ignorePillEl.setAttr(
				"aria-label",
				"Your review state is git-ignored, so approving commits will never create new commits."
			);
		} else {
			this.ignorePillEl.addClass("ghr-pill-warn");
			this.ignorePillEl.removeClass("ghr-pill-ok");
			setIcon(icon, "alert-triangle");
			this.ignorePillEl.createSpan({
				text: tracked
					? "Review data is TRACKED — click to fix"
					: "Review data not ignored — click to fix",
			});
			this.ignorePillEl.setAttr(
				"aria-label",
				"Click to add the review-state file to .gitignore (and untrack it) so approvals never create commits."
			);
		}
	}

	private async onPillClick(): Promise<void> {
		const git = this.plugin.git;
		if (!git.basePath || !(await git.isRepo())) return;
		const rel = this.plugin.dataFileRepoPath();
		if (await git.isIgnored(rel)) return;
		try {
			await this.plugin.protectReviewData();
			new Notice("Review data is now git-ignored and local-only.");
		} catch (err) {
			new Notice(`Could not update .gitignore: ${String(err)}`);
		}
		await this.refreshIgnorePill();
	}

	// ----------------------------------------------------------- external API

	/** Re-reads review state from disk and repaints rows/counts. */
	public refreshApprovals(): void {
		for (const [hash, row] of this.rowByHash) {
			const approved = this.plugin.isApproved(hash);
			row.toggleClass("ghr-approved", approved);
			const check = row.querySelector<HTMLInputElement>(".ghr-row-check");
			if (check) check.checked = approved;
		}
		// Keep an open detail pane in step with the refreshed state.
		if (this.selectedHash) {
			const commit = this.commits.find(
				(c) => c.hash === this.selectedHash
			);
			if (commit) {
				if (this.approveCheckEl) {
					this.approveCheckEl.checked = this.plugin.isApproved(
						commit.hash
					);
				}
				this.syncFileChecks(commit);
				this.syncApproveStatus(commit);
				this.updateProgress(commit);
			}
		}
		this.updateCounts();
	}
}

/** Modal that bulk-approves every commit dated on or before a chosen date. */
class ApproveBeforeDateModal extends Modal {
	constructor(
		app: App,
		private commits: CommitMeta[],
		private onConfirm: (hashes: string[]) => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Approve commits up to a date");
		contentEl.addClass("ghr-date-modal");

		contentEl.createEl("p", {
			cls: "ghr-date-intro",
			text:
				"Mark every commit dated on or before the chosen date as reviewed & approved. Commits that are already approved are left untouched.",
		});

		const controls = contentEl.createDiv({ cls: "ghr-date-controls" });
		controls.createEl("label", {
			text: "On or before",
			attr: { for: "ghr-date-input" },
		});
		const input = controls.createEl("input", {
			attr: { type: "date", id: "ghr-date-input" },
		});
		input.value = this.defaultDate();

		const count = contentEl.createDiv({ cls: "ghr-date-count" });

		const buttons = contentEl.createDiv({ cls: "ghr-date-buttons" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		const confirm = buttons.createEl("button", {
			cls: "mod-cta",
			text: "Approve",
		});

		const eligible = (): string[] => {
			const cutoff = this.cutoffMs(input.value);
			if (cutoff == null) return [];
			return this.commits
				.filter((c) => {
					const t = new Date(c.dateISO).getTime();
					return !Number.isNaN(t) && t <= cutoff;
				})
				.map((c) => c.hash);
		};

		const refresh = () => {
			const n = eligible().length;
			count.setText(
				input.value
					? `${n} commit${n === 1 ? "" : "s"} dated on or before ${input.value}.`
					: "Pick a date."
			);
			confirm.disabled = n === 0;
		};

		input.addEventListener("input", refresh);
		refresh();

		cancel.addEventListener("click", () => this.close());
		confirm.addEventListener("click", () => {
			const hashes = eligible();
			this.close();
			void this.onConfirm(hashes);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** Default to the newest commit's date so "approve everything" is one click. */
	private defaultDate(): string {
		const newest = this.commits[0];
		const d = newest ? new Date(newest.dateISO) : new Date();
		const valid = Number.isNaN(d.getTime()) ? new Date() : d;
		const y = valid.getFullYear();
		const m = String(valid.getMonth() + 1).padStart(2, "0");
		const day = String(valid.getDate()).padStart(2, "0");
		return `${y}-${m}-${day}`;
	}

	/** Inclusive end-of-day (local) for the selected date, in epoch ms. */
	private cutoffMs(value: string): number | null {
		if (!value) return null;
		const t = new Date(`${value}T23:59:59.999`).getTime();
		return Number.isNaN(t) ? null : t;
	}
}
