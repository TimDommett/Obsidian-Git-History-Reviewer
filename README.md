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
  detection, and add/remove highlighting. Merge commits render their combined
  diff.
- **Reviewed & approved checkbox** per commit, plus a record of *when* you
  approved it.
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

### From source (recommended)

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

## Requirements

- **Desktop only.** The plugin shells out to your system `git`, which isn't
  available on Obsidian mobile.
- A git repository at your vault root (the standard Obsidian Git layout).

## License

[MIT](LICENSE)
