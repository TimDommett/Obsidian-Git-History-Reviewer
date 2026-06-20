import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type GitHistoryReviewerPlugin from "./main";
import { CommitMeta, GitError } from "./git";
import { DiffFile, parseDiff, renderDiff } from "./diff";

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

	// Element references.
	private listWrapEl!: HTMLElement;
	private listEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private sentinelEl!: HTMLElement;
	private countEl!: HTMLElement;
	private ignorePillEl!: HTMLElement;
	private searchInputEl!: HTMLInputElement;
	private filterSelectEl!: HTMLSelectElement;

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
		this.diffCache.clear();
		this.firstParentCache.clear();
		this.listEl.empty();
		this.rowByHash.clear();
		this.commits = [];
		this.filtered = [];
		this.renderedCount = 0;

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
		}) as HTMLInputElement;
		check.checked = approved;
		check.addEventListener("click", (e) => e.stopPropagation());
		check.addEventListener("change", () => {
			void this.toggleApprove(c, check.checked);
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

	private async select(hash: string): Promise<void> {
		if (this.selectedHash) {
			this.rowByHash.get(this.selectedHash)?.removeClass("ghr-selected");
		}
		this.selectedHash = hash;
		this.rowByHash.get(hash)?.addClass("ghr-selected");

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

		const head = this.detailEl.createDiv({ cls: "ghr-detail-head" });

		const topRow = head.createDiv({ cls: "ghr-detail-top" });
		const approveWrap = topRow.createEl("label", {
			cls: "ghr-approve",
		});
		const approveCheck = approveWrap.createEl("input", {
			attr: { type: "checkbox" },
		}) as HTMLInputElement;
		approveCheck.checked = this.plugin.isApproved(commit.hash);
		approveCheck.addEventListener("change", () => {
			void this.toggleApprove(commit, approveCheck.checked);
		});
		approveWrap.createSpan({ text: "Reviewed & approved" });

		const review = this.plugin.getReview(commit.hash);
		if (review?.approved && review.reviewedAt) {
			topRow.createSpan({
				cls: "ghr-reviewed-at",
				text: `approved ${relativeTime(review.reviewedAt)}`,
			}).setAttr("aria-label", absoluteTime(review.reviewedAt));
		}

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

		const diffTarget = diffWrap.createDiv();

		if (commit.isMerge) {
			this.renderMergeBar(diffWrap, diffTarget, commit, files);
		}

		if (!(commit.isMerge && files.length === 0)) {
			renderDiff(diffTarget, files);
		}
	}

	/**
	 * For merge commits, git's default combined diff only shows conflict
	 * resolutions (nothing for a clean merge). Offer a toggle to view the full
	 * set of changes the merge brought in relative to its first parent.
	 */
	private renderMergeBar(
		diffWrap: HTMLElement,
		diffTarget: HTMLElement,
		commit: CommitMeta,
		combinedFiles: DiffFile[]
	): void {
		const bar = diffWrap.createDiv({ cls: "ghr-merge-actions" });
		diffWrap.insertBefore(bar, diffTarget);

		bar.createSpan({
			cls: "ghr-merge-note",
			text:
				combinedFiles.length === 0
					? "Clean merge — it introduced no changes of its own. The merged content lives in the individual commits."
					: "Showing this merge's own changes (conflict resolutions).",
		});

		const btn = bar.createEl("button", {
			cls: "ghr-merge-btn",
			text: "View full changes vs first parent",
		});
		let showingFirstParent = false;

		btn.addEventListener("click", async () => {
			showingFirstParent = !showingFirstParent;
			if (!showingFirstParent) {
				btn.setText("View full changes vs first parent");
				diffTarget.empty();
				if (combinedFiles.length > 0) renderDiff(diffTarget, combinedFiles);
				return;
			}
			btn.setText("Show merge's own changes");
			diffTarget.empty();
			diffTarget.createDiv({ cls: "ghr-loading", text: "Loading…" });
			try {
				const fpFiles = await this.getFirstParentDiff(commit);
				if (this.selectedHash !== commit.hash) return;
				renderDiff(diffTarget, fpFiles);
			} catch (err) {
				if (this.selectedHash !== commit.hash) return;
				const message =
					err instanceof GitError ? err.message : String(err);
				diffTarget.empty();
				diffTarget.createDiv({
					cls: "ghr-error",
					text: `Could not load diff:\n${message}`,
				});
			}
		});
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
		approved: boolean
	): Promise<void> {
		await this.plugin.setApproved(commit.hash, approved);

		const row = this.rowByHash.get(commit.hash);
		if (row) {
			row.toggleClass("ghr-approved", approved);
			const check = row.querySelector<HTMLInputElement>(".ghr-row-check");
			if (check) check.checked = approved;
		}

		// If the active filter would hide/show this commit, rebuild the list
		// but keep the current selection highlighted.
		if (this.filter !== "all") {
			this.applyFilter();
		} else {
			this.updateCounts();
		}

		// Keep the detail checkbox in sync when toggled from the list.
		if (this.selectedHash === commit.hash) {
			const detailCheck =
				this.detailEl.querySelector<HTMLInputElement>(
					".ghr-approve input"
				);
			if (detailCheck) detailCheck.checked = approved;
		}
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
		this.updateCounts();
	}
}
