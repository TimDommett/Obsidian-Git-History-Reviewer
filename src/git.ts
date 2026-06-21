import { FileSystemAdapter, Vault } from "obsidian";
import { execFile } from "child_process";

/** A single commit's metadata (no diff — diffs are fetched lazily). */
export interface CommitMeta {
	hash: string;
	shortHash: string;
	author: string;
	email: string;
	dateISO: string;
	parents: string[];
	subject: string;
	body: string;
	isMerge: boolean;
}

export interface GitRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** An open pull request, as reported by the `gh` CLI. */
export interface PullRequestRef {
	number: number;
	/** Head commit SHA of the PR. */
	head: string;
	shortHead: string;
	author: string;
	dateISO: string;
	subject: string;
	/** GitHub mergeability: "MERGEABLE" | "CONFLICTING" | "UNKNOWN". */
	mergeable: string;
}

// Control characters used to delimit log fields. These never appear in commit
// messages, so they are safe separators for parsing.
const FIELD_SEP = "\x1f"; // unit separator – between fields
const RECORD_SEP = "\x1e"; // record separator – between commits

export const LOG_FORMAT =
	`%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%P${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`;

/** Pure parser for `git log --pretty=format:LOG_FORMAT` output. */
export function parseCommitLog(out: string): CommitMeta[] {
	const commits: CommitMeta[] = [];
	for (const record of out.split(RECORD_SEP)) {
		const trimmed = record.replace(/^\n+/, "");
		if (!trimmed) continue;
		const fields = trimmed.split(FIELD_SEP);
		if (fields.length < 8) continue;
		const [hash, shortHash, author, email, dateISO, parentsRaw, subject] =
			fields;
		const body = fields.slice(7).join(FIELD_SEP);
		const parents = parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [];
		commits.push({
			hash,
			shortHash,
			author,
			email,
			dateISO,
			parents,
			subject,
			body: body.replace(/\s+$/, ""),
			isMerge: parents.length > 1,
		});
	}
	return commits;
}

const MAX_BUFFER = 1024 * 1024 * 128; // 128 MB – large enough for big diffs

export class GitError extends Error {
	constructor(message: string, readonly result?: GitRunResult) {
		super(message);
		this.name = "GitError";
	}
}

/**
 * Thin wrapper around the system `git` executable. All commands run with the
 * vault's root folder as the working directory.
 */
export class GitService {
	private cwd: string | null;

	constructor(private vault: Vault, private gitPath = "git") {
		const adapter = vault.adapter;
		this.cwd =
			adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
	}

	setGitPath(path: string): void {
		this.gitPath = path && path.trim() ? path.trim() : "git";
	}

	get basePath(): string | null {
		return this.cwd;
	}

	/** Runs git and resolves with stdout/stderr and the exit code (never rejects). */
	private runRaw(args: string[]): Promise<GitRunResult> {
		return this.exec(this.gitPath, args);
	}

	/** Runs the `gh` CLI (used only to list pull requests accurately). */
	private ghRaw(args: string[]): Promise<GitRunResult> {
		return this.exec("gh", args);
	}

	private exec(bin: string, args: string[]): Promise<GitRunResult> {
		return new Promise((resolve) => {
			if (!this.cwd) {
				resolve({
					code: -1,
					stdout: "",
					stderr:
						"Git History Reviewer requires a local (desktop) vault with filesystem access.",
				});
				return;
			}
			execFile(
				bin,
				args,
				{
					cwd: this.cwd,
					maxBuffer: MAX_BUFFER,
					windowsHide: true,
					encoding: "utf8",
				},
				(err, stdout, stderr) => {
					let code = 0;
					if (err) {
						const anyErr = err as NodeJS.ErrnoException & {
							code?: number | string;
						};
						code =
							typeof anyErr.code === "number" ? anyErr.code : -1;
						if (typeof anyErr.code === "string") {
							// Spawn error (e.g. ENOENT when git isn't installed).
							stderr = `${anyErr.code}: ${err.message}\n${stderr ?? ""}`;
						}
					}
					resolve({
						code,
						stdout: stdout ?? "",
						stderr: stderr ?? "",
					});
				}
			);
		});
	}

	/** Runs git and rejects with a GitError on non-zero exit. */
	private async run(args: string[]): Promise<string> {
		const res = await this.runRaw(args);
		if (res.code !== 0) {
			throw new GitError(
				`git ${args.join(" ")} failed (code ${res.code}): ${res.stderr.trim()}`,
				res
			);
		}
		return res.stdout;
	}

	/** True when the vault root is inside a git working tree. */
	async isRepo(): Promise<boolean> {
		const res = await this.runRaw(["rev-parse", "--is-inside-work-tree"]);
		return res.code === 0 && res.stdout.trim() === "true";
	}

	/** Returns the absolute path of the repository's top level, or null. */
	async repoToplevel(): Promise<string | null> {
		const res = await this.runRaw(["rev-parse", "--show-toplevel"]);
		return res.code === 0 ? res.stdout.trim() : null;
	}

	/** Returns the current branch name (or a short hash when detached). */
	async currentBranch(): Promise<string | null> {
		const res = await this.runRaw(["rev-parse", "--abbrev-ref", "HEAD"]);
		if (res.code !== 0) return null;
		const branch = res.stdout.trim();
		return branch === "HEAD" ? null : branch;
	}

	/**
	 * Loads commit metadata for the whole history (or the most recent
	 * `maxCount` commits when > 0). Diffs are NOT loaded here.
	 */
	async getCommits(maxCount = 0): Promise<CommitMeta[]> {
		const args = ["log", "--no-color", `--pretty=format:${LOG_FORMAT}`];
		if (maxCount > 0) {
			args.push("-n", String(maxCount));
		}
		return parseCommitLog(await this.run(args));
	}

	/**
	 * Returns the raw unified diff (patch text) for a commit. For merge
	 * commits git produces a combined diff by default, which the diff parser
	 * also understands.
	 */
	async getCommitDiff(hash: string): Promise<string> {
		// --format= strips the commit header so we only get the patch body.
		// -M/-C detect renames and copies for nicer output.
		return this.run([
			"show",
			"--no-color",
			"--format=",
			"-M",
			"-C",
			hash,
		]);
	}

	/**
	 * Returns the diff of `toRef` against `fromRef`. Used for merge commits to
	 * show everything a merge introduced relative to its first parent, since
	 * the default combined diff hides clean merges.
	 */
	async getDiffAgainstParent(
		fromRef: string,
		toRef: string
	): Promise<string> {
		return this.run([
			"diff",
			"--no-color",
			"-M",
			"-C",
			fromRef,
			toRef,
		]);
	}

	/** True when `relPath` (relative to the repo) is ignored by git. */
	async isIgnored(relPath: string): Promise<boolean> {
		const res = await this.runRaw(["check-ignore", "-q", "--", relPath]);
		// check-ignore exits 0 when the path is ignored, 1 when it is not.
		return res.code === 0;
	}

	/** True when `relPath` is currently tracked (staged or committed). */
	async isTracked(relPath: string): Promise<boolean> {
		const res = await this.runRaw([
			"ls-files",
			"--error-unmatch",
			"--",
			relPath,
		]);
		return res.code === 0;
	}

	/** Removes `relPath` from the index but leaves the working-tree file. */
	async untrack(relPath: string): Promise<void> {
		await this.run(["rm", "--cached", "--quiet", "--", relPath]);
	}

	// --------------------------------------------------------- pull requests

	/** Name of the first configured remote (usually "origin"), or null. */
	async firstRemote(): Promise<string | null> {
		const res = await this.runRaw(["remote"]);
		if (res.code !== 0) return null;
		const remotes = res.stdout
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
		if (remotes.length === 0) return null;
		// Prefer "origin" (the PR/canonical remote) over an alphabetically
		// earlier one like "fork".
		return remotes.includes("origin") ? "origin" : remotes[0];
	}

	/**
	 * Fetches the PRs' head commits into `refs/remotes/<remote>/pr/<number>` so
	 * they're available locally for diffing and merging. The open/closed list
	 * itself comes from `gh` (see listPullRequests); this just makes the commits
	 * present so everything after the list stays pure local git.
	 */
	async fetchPullRefs(remote: string): Promise<void> {
		await this.run([
			"fetch",
			"--prune",
			remote,
			`+refs/pull/*/head:refs/remotes/${remote}/pr/*`,
		]);
	}

	/** True when the `gh` CLI is installed and runnable. */
	async isGhAvailable(): Promise<boolean> {
		const res = await this.ghRaw(["--version"]);
		return res.code === 0;
	}

	/**
	 * Lists the repo's OPEN pull requests via the GitHub CLI. This is the only
	 * piece that isn't local git: `gh` is the reliable source of open/closed
	 * state and mergeability (local refs can't distinguish closed from
	 * conflicting). Throws a GitError carrying gh's message (e.g. asking you to
	 * run `gh auth login`) on failure.
	 */
	async listPullRequests(limit = 100): Promise<PullRequestRef[]> {
		const res = await this.ghRaw([
			"pr",
			"list",
			"--state",
			"open",
			"--limit",
			String(limit),
			"--json",
			"number,title,author,headRefOid,createdAt,mergeable",
		]);
		if (res.code !== 0) {
			throw new GitError(
				`gh pr list failed (code ${res.code}): ${res.stderr.trim()}`,
				res
			);
		}
		const raw = JSON.parse(res.stdout) as Array<{
			number: number;
			title: string;
			author: { login?: string } | null;
			headRefOid: string;
			createdAt: string;
			mergeable: string;
		}>;
		return raw
			.map((p) => ({
				number: p.number,
				head: p.headRefOid,
				shortHead: p.headRefOid.slice(0, 8),
				author: p.author?.login ?? "",
				dateISO: p.createdAt,
				subject: p.title,
				mergeable: p.mergeable,
			}))
			.sort((a, b) => b.number - a.number);
	}

	/** Diff of what a PR introduces relative to its merge-base with `base`. */
	async getPullDiff(base: string, head: string): Promise<string> {
		return this.run([
			"diff",
			"--no-color",
			"-M",
			"-C",
			`${base}...${head}`,
		]);
	}

	/** True when the working tree and index are clean. */
	async isWorkingTreeClean(): Promise<boolean> {
		const res = await this.runRaw(["status", "--porcelain"]);
		return res.code === 0 && res.stdout.trim() === "";
	}

	/** True when a merge/rebase/cherry-pick/revert is already in progress, so we
	 * never start a PR merge on top of an unfinished operation. */
	async isMergeInProgress(): Promise<boolean> {
		for (const ref of [
			"MERGE_HEAD",
			"REBASE_HEAD",
			"CHERRY_PICK_HEAD",
			"REVERT_HEAD",
		]) {
			const res = await this.runRaw(["rev-parse", "-q", "--verify", ref]);
			if (res.code === 0) return true;
		}
		return false;
	}

	/** Current HEAD commit SHA — captured before a merge as a recovery point. */
	async headSha(): Promise<string | null> {
		const res = await this.runRaw(["rev-parse", "HEAD"]);
		return res.code === 0 ? res.stdout.trim() : null;
	}

	/** Merges a PR's head into the current branch with a merge commit. Throws
	 * (leaving the merge in progress) on conflict — call `abortMerge` then. */
	async mergePull(number: number, head: string): Promise<void> {
		await this.run([
			"merge",
			"--no-ff",
			head,
			"-m",
			`Merge pull request #${number}`,
		]);
	}

	/** Aborts an in-progress merge. Returns true if the abort succeeded (so the
	 * caller doesn't claim the tree was restored when it wasn't). */
	async abortMerge(): Promise<boolean> {
		const res = await this.runRaw(["merge", "--abort"]);
		return res.code === 0;
	}

	/**
	 * Pushes `branch` to `remote`. Deliberately a plain push with NO force of
	 * any kind — git rejects a non-fast-forward instead of overwriting, so the
	 * remote's history and commits can never be lost through this.
	 */
	async push(remote: string, branch: string): Promise<void> {
		await this.run(["push", remote, branch]);
	}
}
