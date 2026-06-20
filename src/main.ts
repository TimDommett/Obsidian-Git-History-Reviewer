import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
} from "obsidian";
import { GitService } from "./git";
import {
	GitHistoryView,
	HistoryFilter,
	VIEW_TYPE_GIT_HISTORY,
} from "./view";

export interface ReviewRecord {
	approved: boolean;
	reviewedAt: string | null;
}

interface GitHistoryReviewerSettings {
	defaultFilter: HistoryFilter;
	maxCommits: number;
	gitPath: string;
	autoManageGitignore: boolean;
}

interface PluginData {
	settings: GitHistoryReviewerSettings;
	/** Review state keyed by full commit hash. Local-only — never committed. */
	reviews: Record<string, ReviewRecord>;
}

const DEFAULT_SETTINGS: GitHistoryReviewerSettings = {
	defaultFilter: "unapproved",
	maxCommits: 0,
	gitPath: "git",
	autoManageGitignore: true,
};

const GITIGNORE_BANNER =
	"# Git History Reviewer — keep approval state local so it never creates commits";

export default class GitHistoryReviewerPlugin extends Plugin {
	settings!: GitHistoryReviewerSettings;
	reviews: Record<string, ReviewRecord> = {};
	git!: GitService;
	private saveQueued = false;

	async onload(): Promise<void> {
		await this.loadPluginData();
		this.git = new GitService(this.app.vault, this.settings.gitPath);

		this.registerView(
			VIEW_TYPE_GIT_HISTORY,
			(leaf) => new GitHistoryView(leaf, this)
		);

		this.addRibbonIcon("history", "Git History Reviewer", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-git-history-reviewer",
			name: "Open Git History Reviewer",
			callback: () => void this.activateView(),
		});

		this.addSettingTab(new GitHistoryReviewerSettingTab(this.app, this));

		// Once the workspace is ready, make sure the review file is git-ignored.
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.autoManageGitignore) {
				void this.protectReviewData().catch(() => {
					/* surfaced in the view's status pill instead */
				});
			}
		});
	}

	// ------------------------------------------------------------ data storage

	private async loadPluginData(): Promise<void> {
		const raw = (await this.loadData()) as Partial<PluginData> | null;
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			raw?.settings ?? {}
		);
		this.reviews = raw?.reviews ?? {};
	}

	private async persist(): Promise<void> {
		const data: PluginData = {
			settings: this.settings,
			reviews: this.reviews,
		};
		await this.saveData(data);
	}

	async saveSettings(): Promise<void> {
		this.git.setGitPath(this.settings.gitPath);
		await this.persist();
	}

	/** Debounced save used for high-frequency approval toggles. */
	private queueSave(): void {
		if (this.saveQueued) return;
		this.saveQueued = true;
		window.setTimeout(() => {
			this.saveQueued = false;
			void this.persist();
		}, 250);
	}

	// ------------------------------------------------------------ review state

	isApproved(hash: string): boolean {
		return this.reviews[hash]?.approved === true;
	}

	getReview(hash: string): ReviewRecord | undefined {
		return this.reviews[hash];
	}

	async setApproved(hash: string, approved: boolean): Promise<void> {
		if (approved) {
			this.reviews[hash] = {
				approved: true,
				reviewedAt: new Date().toISOString(),
			};
		} else if (this.reviews[hash]) {
			delete this.reviews[hash];
		}
		this.queueSave();
	}

	// --------------------------------------------------------- gitignore guard

	/** Vault-relative path of this plugin's data.json (where reviews live). */
	dataFileRepoPath(): string {
		const dir =
			this.manifest.dir ??
			`${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		return `${dir}/data.json`;
	}

	/**
	 * Ensures the review-state file is git-ignored (adding it to the vault's
	 * root .gitignore when needed) and, if it is somehow already tracked,
	 * removes it from the index. This is what prevents the "review → commit →
	 * review again" loop.
	 */
	async protectReviewData(): Promise<void> {
		if (!this.git.basePath) return;
		if (!(await this.git.isRepo())) return;

		const rel = this.dataFileRepoPath();

		if (!(await this.git.isIgnored(rel))) {
			await this.appendGitignoreEntry(rel);
		}

		// If it was committed before we got a chance to ignore it, untrack it
		// (keeps the local file, just stops tracking changes to it).
		if (await this.git.isTracked(rel)) {
			try {
				await this.git.untrack(rel);
			} catch {
				/* non-fatal */
			}
		}
	}

	private async appendGitignoreEntry(rel: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const path = ".gitignore";
		let content = "";
		try {
			if (await adapter.exists(path)) {
				content = await adapter.read(path);
			}
		} catch {
			content = "";
		}

		const lines = content.split("\n").map((l) => l.trim());
		if (lines.includes(rel) || lines.includes(`/${rel}`)) return;

		const needsNewline = content.length > 0 && !content.endsWith("\n");
		const addition = `${needsNewline ? "\n" : ""}\n${GITIGNORE_BANNER}\n${rel}\n`;
		await adapter.write(path, content + addition);
	}

	// ------------------------------------------------------------------- view

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_GIT_HISTORY);
		if (existing.length > 0) {
			await workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_GIT_HISTORY,
			active: true,
		});
		await workspace.revealLeaf(leaf);
	}

	getViews(): GitHistoryView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_GIT_HISTORY)
			.map((leaf: WorkspaceLeaf) => leaf.view)
			.filter((v): v is GitHistoryView => v instanceof GitHistoryView);
	}
}

class GitHistoryReviewerSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: GitHistoryReviewerPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Default filter")
			.setDesc("Which commits to show when the view first opens.")
			.addDropdown((dd) =>
				dd
					.addOption("all", "All commits")
					.addOption("unapproved", "Needs review")
					.addOption("approved", "Approved")
					.setValue(this.plugin.settings.defaultFilter)
					.onChange(async (value) => {
						this.plugin.settings.defaultFilter =
							value as HistoryFilter;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Maximum commits to load")
			.setDesc(
				"Limit how many of the most recent commits are loaded. Set to 0 to load the entire history."
			)
			.addText((text) =>
				text
					.setPlaceholder("0")
					.setValue(String(this.plugin.settings.maxCommits))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						this.plugin.settings.maxCommits =
							Number.isFinite(n) && n > 0 ? n : 0;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Git executable path")
			.setDesc(
				"Path to the git binary. Leave as 'git' to use the one on your PATH."
			)
			.addText((text) =>
				text
					.setPlaceholder("git")
					.setValue(this.plugin.settings.gitPath)
					.onChange(async (value) => {
						this.plugin.settings.gitPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Keep review state local (recommended)")
			.setDesc(
				"Automatically add this plugin's data.json to your vault's .gitignore so approving commits never creates new commits to review."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoManageGitignore)
					.onChange(async (value) => {
						this.plugin.settings.autoManageGitignore = value;
						await this.plugin.saveSettings();
						if (value) {
							await this.plugin.protectReviewData();
							for (const v of this.plugin.getViews()) {
								await v.refreshIgnorePill();
							}
						}
					})
			);

		new Setting(containerEl)
			.setName("Protect review data now")
			.setDesc(
				"Run the .gitignore protection immediately for the current vault."
			)
			.addButton((btn) =>
				btn.setButtonText("Protect now").onClick(async () => {
					try {
						await this.plugin.protectReviewData();
						new Notice("Review data is git-ignored and local-only.");
						for (const v of this.plugin.getViews()) {
							await v.refreshIgnorePill();
						}
					} catch (err) {
						new Notice(`Failed: ${String(err)}`);
					}
				})
			);

		const info = containerEl.createDiv({ cls: "ghr-settings-note" });
		info.createEl("p", {
			text:
				"Approval state is stored by commit hash in this plugin's data.json. Because commit hashes never change, your reviews stay attached to the right commits forever — and because the file is git-ignored, marking a commit reviewed won't generate another commit.",
		});
	}
}
