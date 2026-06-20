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
						stdout: (stdout as string) ?? "",
						stderr: (stderr as string) ?? "",
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
}
