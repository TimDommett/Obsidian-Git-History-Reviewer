import { App, ItemView, Modal, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type GitHistoryReviewerPlugin from "./main";
import { GitError, PullRequestRef } from "./git";
import { DiffFile, parseDiff, renderDiff } from "./diff";

export const VIEW_TYPE_PR_REVIEW = "git-history-pr-review-view";

function shortDate(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/**
 * A second tab that reviews and merges incoming GitHub pull requests using only
 * the local `git` binary: PR head commits are fetched from the GitHub
 * pull-request head refs, the unmerged ones are listed, each PR's diff is shown
 * with the shared diff
 * renderer, and "Merge & push" merges the PR into the current branch and pushes
 * — which closes the PR on GitHub.
 */
export class PrReviewView extends ItemView {
	private prs: PullRequestRef[] = [];
	private selected: number | null = null;
	private base: string | null = null;
	private remote: string | null = null;
	private diffCache = new Map<number, DiffFile[]>();
	private rowByNumber = new Map<number, HTMLElement>();

	private listEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private baseEl!: HTMLElement;
	private busy = false;

	constructor(leaf: WorkspaceLeaf, private plugin: GitHistoryReviewerPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_PR_REVIEW;
	}

	getDisplayText(): string {
		return "Incoming pull requests";
	}

	getIcon(): string {
		return "git-pull-request";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("ghr-root");
		this.buildToolbar();
		this.buildBody();
		await this.reload();
	}

	// ---------------------------------------------------------------- UI build

	private buildToolbar(): void {
		const bar = this.contentEl.createDiv({ cls: "ghr-toolbar" });

		const title = bar.createDiv({ cls: "ghr-title" });
		const icon = title.createSpan({ cls: "ghr-title-icon" });
		setIcon(icon, "git-pull-request");
		title.createSpan({ text: "Incoming pull requests" });

		const refresh = bar.createEl("button", {
			cls: "ghr-icon-btn",
			attr: { "aria-label": "Fetch & refresh pull requests" },
		});
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => void this.reload());

		this.baseEl = bar.createDiv({ cls: "ghr-count" });
	}

	private buildBody(): void {
		const body = this.contentEl.createDiv({ cls: "ghr-body" });

		const listWrap = body.createDiv({ cls: "ghr-list-wrap" });
		this.listEl = listWrap.createDiv({ cls: "ghr-list" });

		// "split" = fixed metadata head + an inner scroll area for the diff, so
		// each file's header stays pinned at the top until you scroll past its
		// file (it never tucks behind the head).
		this.detailEl = body.createDiv({ cls: "ghr-detail ghr-detail-split" });
		this.renderDetailMessage("Select a pull request to review its changes.");
	}

	// ------------------------------------------------------------- data loading

	async reload(): Promise<void> {
		const git = this.plugin.git;
		this.diffCache.clear();
		this.selected = null;
		this.renderDetailMessage("Select a pull request to review its changes.");

		if (!git.basePath) {
			this.renderListMessage(
				"This vault has no filesystem access. Pull-request review only works on a desktop vault."
			);
			return;
		}
		if (!(await git.isRepo())) {
			this.renderListMessage(
				"No git repository found at the vault root."
			);
			return;
		}

		this.remote = await git.firstRemote();
		this.base = await git.currentBranch();
		this.baseEl.empty();
		if (this.base) {
			this.baseEl.createSpan({ text: "merging into " });
			this.baseEl.createSpan({
				cls: "ghr-count-approved",
				text: this.base,
			});
		}

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

		const head = this.detailEl.createDiv({ cls: "ghr-detail-head" });
		const topRow = head.createDiv({ cls: "ghr-detail-top" });

		const mergeBtn = topRow.createEl("button", {
			cls: "ghr-merge-btn mod-cta",
			text: `Merge & push`,
		});
		mergeBtn.addEventListener("click", () => void this.confirmMerge(pr));

		topRow.createSpan({
			cls: "ghr-reviewed-at",
			text: this.base ? `into ${this.base}` : "",
		});

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
		diffWrap.empty();
		renderDiff(diffWrap, files);
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

	private confirmMerge(pr: PullRequestRef): void {
		if (this.busy) return;
		new MergeConfirmModal(this.app, pr, this.base ?? "?", () =>
			void this.doMerge(pr)
		).open();
	}

	private async doMerge(pr: PullRequestRef): Promise<void> {
		const git = this.plugin.git;
		if (this.busy || !this.remote || !this.base) return;
		this.busy = true;
		try {
			if (!(await git.isWorkingTreeClean())) {
				new Notice(
					"Working tree isn't clean — commit or stash your changes before merging a PR."
				);
				return;
			}

			try {
				await git.mergePull(pr.number, pr.head);
			} catch (err) {
				await git.abortMerge();
				const message =
					err instanceof GitError ? err.message : String(err);
				new Notice(
					`Merge failed (conflicts?) and was aborted.\n${message}`
				);
				return;
			}

			try {
				await git.push(this.remote, this.base);
			} catch (err) {
				const message =
					err instanceof GitError ? err.message : String(err);
				new Notice(
					`Merged PR #${pr.number} locally, but the push failed: ${message}\nPush manually to close it on GitHub.`
				);
				await this.reload();
				return;
			}

			new Notice(
				`Merged PR #${pr.number} into ${this.base} and pushed — it will close on GitHub.`
			);
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
		private onConfirm: () => void
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
				`This merges the PR into "${this.base}" with a merge commit and ` +
				`pushes — which closes the PR on GitHub. Your working tree must ` +
				`be clean; on conflicts the merge is aborted and nothing is pushed.`,
		});

		const buttons = contentEl.createDiv({ cls: "ghr-date-buttons" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener(
			"click",
			() => this.close()
		);
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
	}
}
