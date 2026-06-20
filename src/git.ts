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

/** A pull request discovered locally via its GitHub `refs/pull/<n>/head` ref. */
export interface PullRequestRef {
	number: number;
	/** Head commit SHA of the PR. */
	head: string;
	shortHead: string;
	author: string;
	dateISO: string;
	subject: string;
}

/** Pure parser for the `for-each-ref` output used to list pull requests. */
export function parsePullRefs(out: string): PullRequestRef[] {
	const prs: PullRequestRef[] = [];
	for (const line of out.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const f = trimmed.split(FIELD_SEP);
		if (f.length < 6) continue;
		const m = f[0].match(/\/pr\/(\d+)$/);
		if (!m) continue;
		prs.push({
			number: parseInt(m[1], 10),
			head: f[1],
			shortHead: f[2],
			author: f[3],
			dateISO: f[4],
			subject: f[5],
		});
	}
	return prs;
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
				this.gitPath,
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
	 * Fetches every PR's head commit from GitHub into
	 * `refs/remotes/<remote>/pr/<number>`. Only works against GitHub remotes
	 * (which expose the pull-request head refs).
	 */
	async fetchPullRefs(remote: string): Promise<void> {
		// Also fetch the `…/merge` refs: GitHub keeps one only while a PR is
		// open (and mergeable) and drops it when the PR is closed/merged, so
		// with `--prune` they become a local signal for "still open".
		await this.run([
			"fetch",
			"--prune",
			remote,
			`+refs/pull/*/head:refs/remotes/${remote}/pr/*`,
			`+refs/pull/*/merge:refs/remotes/${remote}/pr-merge/*`,
		]);
	}

	/** Numbers of PRs that still have a `…/merge` ref (i.e. open & mergeable). */
	private async openPullNumbers(remote: string): Promise<Set<number>> {
		const res = await this.runRaw([
			"for-each-ref",
			"--format=%(refname)",
			`refs/remotes/${remote}/pr-merge/*`,
		]);
		const nums = new Set<number>();
		if (res.code !== 0) return nums;
		for (const line of res.stdout.split("\n")) {
			const m = line.trim().match(/\/pr-merge\/(\d+)$/);
			if (m) nums.add(parseInt(m[1], 10));
		}
		return nums;
	}

	/** True when `ancestor` is an ancestor of (already contained in) `ref`. */
	async isAncestor(ancestor: string, ref: string): Promise<boolean> {
		const res = await this.runRaw([
			"merge-base",
			"--is-ancestor",
			ancestor,
			ref,
		]);
		return res.code === 0;
	}

	/**
	 * Lists locally-known PRs (from previously fetched pr refs) that are not yet
	 * merged into `base`. Already-merged PRs are filtered out.
	 */
	async listOpenPulls(
		base: string,
		remote: string
	): Promise<PullRequestRef[]> {
		const fmt = [
			"%(refname)",
			"%(objectname)",
			"%(objectname:short)",
			"%(authorname)",
			"%(authordate:iso-strict)",
			"%(contents:subject)",
		].join(FIELD_SEP);
		const out = await this.run([
			"for-each-ref",
			`--format=${fmt}`,
			`refs/remotes/${remote}/pr/*`,
		]);
		const all = parsePullRefs(out);
		const openNumbers = await this.openPullNumbers(remote);
		const open: PullRequestRef[] = [];
		for (const pr of all) {
			// Only list open & cleanly-mergeable PRs — those keep a `…/merge`
			// ref. Closed PRs (and ones that currently conflict with the base)
			// have no merge ref and are dropped, so we never offer to merge a
			// PR that's actually closed. GitHub is the only remote that exposes
			// pull refs, so an empty set genuinely means "nothing mergeable".
			if (!openNumbers.has(pr.number)) continue;
			// Belt-and-braces: also drop anything already merged into base.
			if (await this.isAncestor(pr.head, base)) continue;
			open.push(pr);
		}
		open.sort((a, b) => b.number - a.number);
		return open;
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

	/** Pushes `branch` to `remote`. */
	async push(remote: string, branch: string): Promise<void> {
		await this.run(["push", remote, branch]);
	}
}
