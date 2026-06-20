# Git History Reviewer

An Obsidian plugin for people who are *particular* about their vault's git
history. It lets you walk through **every commit** in your vault's repository,
read a pretty dark-mode diff for each one, and tick off the commits you've
**reviewed and approved** — with a filter to show everything or just what's
left to review.

> Built for the classic [Obsidian Git](https://github.com/Vinzent03/obsidian-git)
> auto-commit setup, where commits pile up faster than you can read them.

![desktop only](https://img.shields.io/badge/platform-desktop-blue)

## Features

- **Full commit history** loaded straight from your repo (`git log`).
- **Dark-mode diff view** with per-file collapsing, line numbers, rename
  detection, and add/remove highlighting.
- **Per-file review circles** — tick off each changed file as you read it. A
  live `2 / 5 files reviewed` counter shows progress, and when every file is
  ticked the commit is *ready to approve*.
- **Reviewed & approved checkbox** per commit, plus a record of *when* you
  approved it. Approving a commit fills in all its file circles; un-ticking a
  file on an approved commit drops it back to a partial review.
- **Auto-advance**: approve the commit you're viewing from the list and the
  detail pane jumps to the next one to review.
- **Merges auto-expand** to show every change they introduced (vs the first
  parent), with a toggle back to the merge's own conflict-resolution diff.
- **Approve up to a date** — bulk-approve every commit on or before a chosen
  date in one click (great for clearing out old auto-commits).
- **Filter** between *All commits*, *Needs review*, and *Approved*, with a live
  count of how many are left.
- **Search** by commit message, hash, or author.
- **Keyboard-free, click-through workflow**: tick a commit in the list or from
  the detail pane.

## The "never-ending loop" problem — solved

The obvious trap: if approving a commit wrote its state into a tracked file,
your auto-commit setup would commit that change… which produces a new commit…
which needs reviewing… which writes another change… forever.

This plugin avoids that completely:

1. Approval state is stored **by commit hash** in the plugin's own
   `data.json`. Commit hashes never change, so reviews stay glued to the right
   commit for good.
2. On load, the plugin automatically adds that `data.json` to your vault's
   **`.gitignore`**, so changing it never produces a commit. If the file was
   somehow already tracked, it's removed from the index (`git rm --cached`,
   your local file is kept).
3. A status pill in the top bar continuously verifies this with
   `git check-ignore`. If your review data is ever *not* ignored, it turns
   orange — click it to fix instantly.

In short: **your review state is local-only and can never enter your history.**

## Installation

### From a release

Download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/TimDommett/Obsidian-Git-History-Reviewer/releases/latest),
drop them into `<your-vault>/.obsidian/plugins/git-history-reviewer/`, reload
Obsidian, and enable **Git History Reviewer** in *Settings → Community plugins*.

### From source

`main.js` is a build artifact and is **not** committed, so build it first:

```bash
npm install
npm run build      # produces main.js
```

Then copy `main.js`, `manifest.json`, and `styles.css` into
`<your-vault>/.obsidian/plugins/git-history-reviewer/`, reload Obsidian, and
enable **Git History Reviewer** in *Settings → Community plugins*.

### Developing

Symlink (or clone) this repo into your vault's plugin folder and run
`npm run dev` to rebuild on save.

## Usage

- Open with the ribbon icon (the commit dots) or the command palette:
  **"Open Git History Reviewer"**.
- Click a commit on the left to see its diff on the right.
- Tick **Reviewed & approved** in the list or the detail pane.
- Use the filter dropdown to hide everything you've already approved.

## Settings

| Setting | What it does |
| --- | --- |
| **Default filter** | Which commits show when the view opens. |
| **Maximum commits to load** | Cap the most-recent N commits (`0` = all). |
| **Git executable path** | Override if `git` isn't on your PATH. |
| **Keep review state local** | Auto-manage `.gitignore` (leave on). |
| **Protect review data now** | Run the `.gitignore` protection immediately. |

## Releasing (maintainers)

1. Bump the version (updates `manifest.json` and `versions.json` via
   `version-bump.mjs`):

   ```bash
   npm version patch   # or minor / major
   ```

2. Push the commit **and** the tag:

   ```bash
   git push && git push --tags
   ```

The tag (e.g. `1.0.1`, no `v` prefix) triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which runs
`npm ci && npm run build` and opens a **draft** GitHub release with `main.js`,
`manifest.json`, and `styles.css` attached — exactly what the Obsidian Community
Plugins directory expects. Review the draft and click **Publish**.

3. Publish the draft release on GitHub.

> The workflow follows the official
> [obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin)
> conventions (committed `package-lock.json` + `npm ci` for reproducible builds,
> build-provenance attestation, draft release).

To list the plugin in the directory, submit a PR adding it to
[`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases)
once a release is published.

## Requirements

- **Desktop only.** The plugin shells out to your system `git`, which isn't
  available on Obsidian mobile.
- A git repository at your vault root (the standard Obsidian Git layout).

## License

[MIT](LICENSE)
