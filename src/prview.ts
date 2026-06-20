import { App, Modal, Notice } from "obsidian";
import type GitHistoryReviewerPlugin from "./main";
import { GitError, PullRequestRef } from "./git";
import {
	DiffFile,
	FileReviewHooks,
	fileReviewKey,
	parseDiff,
	renderDiff,
} from "./diff";

function shortDate(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/**
 * Embeddable "incoming pull requests" panel, shown as a mode within the Git
 * History Reviewer view. It works with the local `git` binary only (no API
 * token): PR head commits are fetched from the GitHub pull-request head refs,
 * the unmerged ones are listed, each PR's diff is shown with the shared diff
 * renderer, and "Merge & push" merges the PR into the current branch and pushes
 * — which closes the PR on GitHub.
 */
export class PrPanel {
	private prs: PullRequestRef[] = [];
	private selected: number | null = null;
	private base: string | null = null;
	private remote: string | null = null;
	private diffCache = new Map<number, DiffFile[]>();
	private rowByNumber = new Map<number, HTMLElement>();
	private listEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private progressEl: HTMLElement | null = null;
	private activeFiles: DiffFile[] = [];
	private busy = false;
	private mergeDialogOpen = false;

	constructor(
		private plugin: GitHistoryReviewerPlugin,
		private root: HTMLElement
	) {}

	/** Builds the panel's list + detail panes into its root element. */
	mount(): void {
		const listWrap = this.root.createDiv({ cls: "ghr-list-wrap" });
		this.listEl = listWrap.createDiv({ cls: "ghr-list" });
		this.detailEl = this.root.createDiv({
			cls: "ghr-detail ghr-detail-split",
		});
		this.renderDetailMessage(
			"Select a pull request to review its changes."
		);
	}

	// ------------------------------------------------------------- data loading

	async reload(): Promise<void> {
		const git = this.plugin.git;
		this.diffCache.clear();
		this.selected = null;
		this.renderDetailMessage(
			"Select a pull request to review its changes."
		);

		if (!git.basePath) {
			this.renderListMessage(
				"This vault has no filesystem access. Pull-request review only works on a desktop vault."
			);
			return;
		}
		if (!(await git.isRepo())) {
			this.renderListMessage("No git repository found at the vault root.");
			return;
		}

		this.remote = await git.firstRemote();
		this.base = await git.currentBranch();

		if (!this.remote) {
			this.renderListMessage("This repository has no remote configured.");
			return;
		}
		if (!this.base) {
			this.renderListMessage(
				"You're in a detached HEAD state — check out a branch to merge into."
			);
			return;
		}

		this.renderListMessage("Fetching pull requests…");
		try {
			await git.fetchPullRefs(this.remote);
			this.prs = await git.listOpenPulls(this.base, this.remote);
		} catch (err) {
			const message = err instanceof GitError ? err.message : String(err);
			this.renderListMessage(
				`Could not fetch pull requests. Is the remote on GitHub?\n\n${message}`
			);
			return;
		}

		this.renderList();
	}

	private renderListMessage(text: string): void {
		this.listEl.empty();
		this.rowByNumber.clear();
		this.listEl.createDiv({ cls: "ghr-list-message", text });
	}

	private renderDetailMessage(text: string): void {
		this.detailEl.empty();
		this.progressEl = null;
		this.activeFiles = [];
		this.detailEl.createDiv({ cls: "ghr-detail-placeholder", text });
	}

	private renderList(): void {
		this.listEl.empty();
		this.rowByNumber.clear();
		if (this.prs.length === 0) {
			this.renderListMessage("No open pull requests to review. 🎉");
			return;
		}
		for (const pr of this.prs) {
			const row = this.listEl.createDiv({ cls: "ghr-row" });
			this.rowByNumber.set(pr.number, row);
			if (pr.number === this.selected) row.addClass("ghr-selected");

			const main = row.createDiv({ cls: "ghr-row-main" });
			const subjectLine = main.createDiv({ cls: "ghr-row-subject" });
			subjectLine.createSpan({
				cls: "ghr-merge-badge",
				text: `#${pr.number}`,
			});
			subjectLine.createSpan({
				cls: "ghr-row-subject-text",
				text: pr.subject || "(no title)",
			});

			const meta = main.createDiv({ cls: "ghr-row-meta" });
			meta.createSpan({ cls: "ghr-row-hash", text: pr.shortHead });
			meta.createSpan({ cls: "ghr-row-author", text: pr.author });
			meta.createSpan({
				cls: "ghr-row-date",
				text: shortDate(pr.dateISO),
			});

			row.addEventListener("click", () => void this.select(pr.number));
		}
	}

	// ------------------------------------------------------------------ detail

	private async select(number: number): Promise<void> {
		if (this.selected != null) {
			this.rowByNumber.get(this.selected)?.removeClass("ghr-selected");
		}
		this.selected = number;
		this.rowByNumber.get(number)?.addClass("ghr-selected");

		const pr = this.prs.find((p) => p.number === number);
		if (!pr) return;
		await this.renderDetail(pr);
	}

	private async renderDetail(pr: PullRequestRef): Promise<void> {
		this.detailEl.empty();
		this.activeFiles = [];

		const head = this.detailEl.createDiv({ cls: "ghr-detail-head" });
		const topRow = head.createDiv({ cls: "ghr-detail-top" });

		const mergeBtn = topRow.createEl("button", {
			cls: "ghr-merge-btn mod-cta",
			text: "Merge & push",
		});
		mergeBtn.addEventListener("click", () => void this.confirmMerge(pr));

		topRow.createSpan({
			cls: "ghr-reviewed-at",
			text: this.base ? `into current branch ${this.base}` : "",
		});

		// Live "N / M files reviewed" — these ticks are local-only and never
		// approve or merge the PR.
		this.progressEl = topRow.createSpan({
			cls: "ghr-progress",
			attr: { role: "status", "aria-live": "polite" },
		});

		// "Hide reviewed" toggle (mirrors the commit view's setting). Its
		// handler is wired after the diff container exists, below.
		const hideWrap = topRow.createEl("label", { cls: "ghr-hide-toggle" });
		const hideCheck = hideWrap.createEl("input", {
			attr: { type: "checkbox" },
		});
		hideCheck.checked = this.plugin.settings.hideReviewedFiles;
		hideWrap.createSpan({ text: "Hide reviewed" });

		head.createDiv({
			cls: "ghr-detail-subject",
			text: `#${pr.number} — ${pr.subject || "(no title)"}`,
		});

		const metaGrid = head.createDiv({ cls: "ghr-detail-meta" });
		const authorRow = metaGrid.createDiv({ cls: "ghr-meta-row" });
		authorRow.createSpan({ cls: "ghr-meta-key", text: "author" });
		authorRow.createSpan({ cls: "ghr-meta-val", text: pr.author });
		const headRow = metaGrid.createDiv({ cls: "ghr-meta-row" });
		headRow.createSpan({ cls: "ghr-meta-key", text: "head" });
		headRow.createSpan({
			cls: "ghr-meta-val ghr-mono",
			text: pr.shortHead,
		});

		const scroll = this.detailEl.createDiv({ cls: "ghr-diff-scroll" });
		const diffWrap = scroll.createDiv({ cls: "ghr-diff-wrap" });

		hideCheck.addEventListener("change", () => {
			this.plugin.settings.hideReviewedFiles = hideCheck.checked;
			void this.plugin.saveSettings();
			void this.renderDiffInto(diffWrap, pr);
		});

		await this.renderDiffInto(diffWrap, pr);
	}

	private prKey(pr: PullRequestRef): string {
		// Namespaced so it never collides with a real commit hash, and tied to
		// the head so a force-push resets the check-offs.
		return `pr/${pr.head}`;
	}

	private fileHooks(pr: PullRequestRef): FileReviewHooks {
		const key = this.prKey(pr);
		return {
			isReviewed: (file) =>
				this.plugin.isFileReviewed(key, fileReviewKey(file)),
			onToggle: (file, reviewed) => {
				void this.plugin.setFileReviewed(
					key,
					fileReviewKey(file),
					reviewed
				);
				this.updateProgress(pr);
			},
		};
	}

	private updateProgress(pr: PullRequestRef): void {
		if (!this.progressEl) return;
		const key = this.prKey(pr);
		const keys = this.activeFiles.map(fileReviewKey);
		this.progressEl.empty();
		if (keys.length === 0) return;
		const done = keys.filter((k) =>
			this.plugin.isFileReviewed(key, k)
		).length;
		this.progressEl.setText(
			`${done} / ${keys.length} files reviewed`
		);
	}

	private async renderDiffInto(
		diffWrap: HTMLElement,
		pr: PullRequestRef
	): Promise<void> {
		diffWrap.empty();
		diffWrap.createDiv({ cls: "ghr-loading", text: "Loading diff…" });

		let files: DiffFile[];
		try {
			files = await this.getDiff(pr);
		} catch (err) {
			if (this.selected !== pr.number) return;
			const message = err instanceof GitError ? err.message : String(err);
			diffWrap.empty();
			diffWrap.createDiv({
				cls: "ghr-error",
				text: `Could not load diff:\n${message}`,
			});
			return;
		}
		if (this.selected !== pr.number) return;
		this.activeFiles = files;
		diffWrap.empty();
		renderDiff(diffWrap, files, {
			fileReview: this.fileHooks(pr),
			hideReviewed: this.plugin.settings.hideReviewedFiles,
		});
		this.updateProgress(pr);
	}

	private async getDiff(pr: PullRequestRef): Promise<DiffFile[]> {
		const cached = this.diffCache.get(pr.number);
		if (cached) return cached;
		const raw = await this.plugin.git.getPullDiff(
			this.base ?? "HEAD",
			pr.head
		);
		const files = parseDiff(raw);
		this.diffCache.set(pr.number, files);
		return files;
	}

	// ------------------------------------------------------------------- merge

	private async confirmMerge(pr: PullRequestRef): Promise<void> {
		if (this.busy || this.mergeDialogOpen) return;
		this.mergeDialogOpen = true;
		// Use the live current branch (not the value captured at list-load) so
		// the dialog names the branch the merge will actually land on.
		const base = await this.plugin.git.currentBranch();
		if (!base) {
			this.mergeDialogOpen = false;
			new Notice(
				"Detached HEAD — check out a branch to merge the PR into."
			);
			return;
		}
		new MergeConfirmModal(
			this.plugin.app,
			pr,
			base,
			() => void this.doMerge(pr, base),
			() => {
				this.mergeDialogOpen = false;
			}
		).open();
	}

	private async doMerge(
		pr: PullRequestRef,
		expectedBase: string
	): Promise<void> {
		const git = this.plugin.git;
		if (this.busy || !this.remote) return;
		this.busy = true;
		try {
			// `git merge` lands on whatever HEAD is right now, so re-verify the
			// branch hasn't moved since the dialog — and push that same branch.
			const base = await git.currentBranch();
			if (!base || base !== expectedBase) {
				new Notice(
					"Your checked-out branch changed since you confirmed — nothing was merged. Reload and try again."
				);
				return;
			}

			if (!(await git.isWorkingTreeClean())) {
				new Notice(
					"Working tree isn't clean — commit or stash your changes before merging a PR."
				);
				return;
			}

			try {
				await git.mergePull(pr.number, pr.head);
			} catch (err) {
				const aborted = await git.abortMerge();
				const message =
					err instanceof GitError ? err.message : String(err);
				new Notice(
					aborted
						? `Merge failed (conflicts?) and was aborted — your branch is unchanged.\n${message}`
						: `Merge failed and could NOT be auto-aborted — your repo may be mid-merge. Run \`git merge --abort\` manually.\n${message}`
				);
				return;
			}

			try {
				await git.push(this.remote, base);
			} catch (err) {
				const message =
					err instanceof GitError ? err.message : String(err);
				new Notice(
					`Merged PR #${pr.number} into ${base} locally, but the push failed: ${message}\nPush manually to close it on GitHub.`
				);
				await this.reload();
				return;
			}

			new Notice(
				`Merged PR #${pr.number} into ${base} and pushed — it will close on GitHub.`
			);
			// The PR's per-file ticks are done with; drop them and refresh the
			// commit history so the new merge commit appears.
			await this.plugin.removeReview(this.prKey(pr));
			for (const v of this.plugin.getViews()) void v.reload();
			await this.reload();
		} finally {
			this.busy = false;
		}
	}
}

/** Confirmation dialog shown before a (destructive) local merge + push. */
class MergeConfirmModal extends Modal {
	constructor(
		app: App,
		private pr: PullRequestRef,
		private base: string,
		private onConfirm: () => void,
		private onDismiss: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(`Merge pull request #${this.pr.number}`);

		contentEl.createEl("p", {
			text: `“${this.pr.subject || "(no title)"}” by ${this.pr.author}`,
		});
		contentEl.createEl("p", {
			cls: "ghr-date-intro",
			text:
				`This merges the PR into your CURRENT branch "${this.base}" with a ` +
				`merge commit and pushes it — which closes the PR on GitHub. Note ` +
				`that's not necessarily the branch the PR targets on GitHub, so ` +
				`make sure "${this.base}" is the branch you intend. Your working ` +
				`tree must be clean; on conflicts the merge is aborted and nothing ` +
				`is pushed.`,
		});

		const buttons = contentEl.createDiv({ cls: "ghr-date-buttons" });
		buttons
			.createEl("button", { text: "Cancel" })
			.addEventListener("click", () => this.close());
		const confirm = buttons.createEl("button", {
			cls: "mod-cta",
			text: "Merge & push",
		});
		confirm.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		this.onDismiss();
	}
}
