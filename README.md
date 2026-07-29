# Synapse

[![Build Windows app](https://github.com/drakontosc9/synapseMAIN/actions/workflows/build.yml/badge.svg)](https://github.com/drakontosc9/synapseMAIN/actions/workflows/build.yml)
[![▶ Run build](https://img.shields.io/badge/%E2%96%B6%20Run%20build-2ea44f?style=for-the-badge)](https://github.com/drakontosc9/synapseMAIN/actions/workflows/build.yml)

> Click **▶ Run build**, then hit the green **Run workflow** button to build the Windows `.exe`.
> When it finishes, the app zip is under that run's **Artifacts**. (Pushing a `v*` tag instead attaches it to a Release.)

A mind-mapping app built around one idea: **capture a thought, and it files itself.**
Open it, answer *"What's on your mind?"*, hit Enter — Synapse routes the note into the
right folder and drops you into an Obsidian-style graph you navigate instead of a file tree.

Everything is plain **Markdown on your disk**. No lock-in, no database. You can open the
same vault in Obsidian, VS Code, or any text editor.


BEFORE YOU RUN THIS AS WITH ANY CODE DOWNLOADED FROM THE EVIL INTERNET RUN IT THROUGH ANTIVIRUS. PLEASE

## What it does

- **Capture bar** — a calm "What's on your mind?" screen. As you type, a live hint shows
  where the thought will land.
- **Global quick capture** — press **Ctrl+Shift+Space** anywhere in Windows for a one-line
  capture bar. Type, Enter, gone — the main window never has to be open. Rebindable in
  Settings, and Synapse can stay in the tray so capture is always instant.
- **Keyword auto-filing** — a rule-based classifier (`rules.json`) scores your text against
  keyword and `#tag` lists and picks a folder (Tasks, Ideas, Journal, Research, People,
  Projects, Quotes, or Inbox as fallback). No AI calls, fully offline and private.
- **Filing that learns** — when it guesses wrong, the confirmation offers *"Wrong folder?"*.
  Pick the right one and Synapse can add that thought's distinctive words to the folder's
  keywords, so the next similar thought lands correctly.
- **Recent notes** — `Ctrl+E` for a reverse-chronological list bucketed by Today /
  Yesterday / this week. The graph is a map; this is the index.
- **Nested, semantic-zoom graph** — folders are big bubbles; their notes (and sub-folders)
  appear only as you zoom in, recursively. Click a folder to zoom into it; capturing a
  thought flips you into the graph focused on the new note. Scroll to zoom, drag the
  background to pan, `⤢` to fit.
- **Build hierarchy by gesture**
  - **Long-press a note (~2s)** to pick it up (it lifts with a shadow), then drop it on
    another note to make it a **child** — stored as a reversible `parent:` field, drawn as
    an orange directed arrow.
  - **Ctrl/Cmd-drag** from one note to another to draw a **`[[wikilink]]`**.
- **Groups** — make an empty group (toolbar `＋ Group` or right-click), or Shift-click
  several notes and "Group into folder". Which methods are available is toggleable in Settings.
- **Three kinds of edges**
  - **Orange arrow** = `parent → child` hierarchy.
  - **Solid** = explicit `[[wikilinks]]`.
  - **Faint dotted** = notes sharing a `#tag`.
  - Toggle any of them in the legend.
- **Note editor** — click a node to read it; hit *Edit* for the raw Markdown; *Reveal* to
  show the file on disk. Edits autosave when you click away, switch notes or close the
  panel, so nothing is lost by accident. `[[wikilinks]]` in the preview are clickable.
- **Move / delete** — re-file a note into any folder, or send it to the system trash
  (recoverable) from the note panel, the right-click menu or the command palette.
- **Import** — copy images / PDFs into `attachments/` (embedded as Markdown), or save a URL
  as its own note in `Links/`.
- **Live sync with your other editors** — Synapse watches the vault, so notes you change in
  Obsidian, VS Code or Explorer show up without pressing rescan.

### Keyboard

| Key | Action |
|-----|--------|
| `Ctrl+Shift+Space` | Quick capture from anywhere (global, rebindable) |
| `Ctrl+N` | New thought |
| `Ctrl+K` | Command palette |
| `Ctrl+F` | Jump to search |
| `Ctrl+E` | Recent notes |
| `Ctrl+S` / `Ctrl+Enter` | Save the note you're editing |
| `Ctrl+Z` | Undo the last graph change (never steals undo from a text field) |
| `Ctrl+0` | Fit graph to view |
| `Ctrl+R` | Reload the vault from disk |
| `Ctrl+T` | Cycle theme |
| `Esc` | Close the topmost dialog, palette or menu |

## Run it

You need [Node.js](https://nodejs.org) (v18+).

```bash
npm install      # pulls in Electron (~1 min the first time)
npm start
```

On first launch, click **Choose vault folder** and pick an empty folder (or an existing
Markdown vault). Synapse writes a `.synapse/rules.json` inside it — edit that file to
customize how thoughts get sorted.

Run the tests any time with:

```bash
npm test
```

## How your vault is organized

```
your-vault/
├── .synapse/rules.json     ← your editable sorting rules
├── Inbox/                   ← anything that didn't match a rule
├── Tasks/  Ideas/  Journal/ …
├── Links/                   ← saved URLs
└── attachments/             ← imported images & PDFs
```

Each note is a Markdown file with light frontmatter:

```markdown
---
title: "Ship the graph view milestone"
created: 2026-07-22T18:04:00.000Z
folder: Projects
tags: [project]
---
Ship the [[Graph View]] milestone #project
```

## Customizing the sorting

Open `.synapse/rules.json` in your vault. Each rule is a folder plus the keywords and tags
that route to it. Higher keyword/tag matches win; an explicit `#tag` counts for more than a
loose keyword. Add folders, add keywords, reorder freely — changes take effect on the next
captured thought.

## Build a Windows installer

CI builds this for you: **Actions → Build Windows app → Run workflow** produces a
`Synapse Setup` installer (and a portable `.zip`) as downloadable artifacts. Pushing a
`v*` tag attaches them to a GitHub Release.

To build locally on Windows instead:

```bash
npm run dist:win     # outputs dist/Synapse Setup <version>.exe  +  a portable zip
```

## Project layout

| File | Role |
|------|------|
| `main.js` | Electron main process — windows, menu, tray, global hotkey, IPC, filesystem |
| `preload.js` | Secure bridge exposing `window.synapse` to the UI |
| `log.js` | Append-only log in `%APPDATA%/synapse/logs` (Help → Open log file) |
| `safeio.js` | Atomic file writes + vault path containment (tested) |
| `classifier.js` | Keyword routing, title/tag/link extraction, Markdown parsing (tested) |
| `fm.js` | Frontmatter read/write + parent-cycle checks (tested) |
| `vault.js` | Scans the folder into the nested `{nodes, links, suggestions}` graph model (async + mtime-cached) |
| `src/index.html` / `styles.css` | The capture screen + workspace shell |
| `src/quick.html` / `quick.js` | The global quick-capture bar |
| `src/graph.js` | Dependency-free semantic-zoom force graph on `<canvas>` |
| `src/search.js` | Ranked note search (scored + exact modes) |
| `src/renderer.js` | Wires the UI to the main process |
| `rules.json` | Default sorting rules (copied into each new vault) |
| `test/` | Node suites (`npm test`) + a real-renderer Electron smoke test (`npm run test:ui`) |

## Your data

Everything is a plain file you own, and Synapse tries hard not to lose any of it:

- **Atomic writes.** Notes, config and rules are written to a temp file and renamed into
  place, so a crash or power cut can never leave a half-written note.
- **Deletes go to the system trash**, never `unlink`.
- **One instance only.** A second copy would race the first one writing the same files, so
  launching Synapse again just focuses the window you already have.
- **Nothing is swallowed.** Failures are logged rather than silently ignored — Settings →
  How to use → *Show log file*.

## Roadmap ideas

- Image / PDF thumbnails rendered on graph nodes
- Timeline / "what did I think about this week" time-lapse
- Local-graph mode with an adjustable hop count
- Orphan detector (notes nothing links to)
- Optional AI fallback for ambiguous notes (hybrid filing)
- Code-signed installer to remove the SmartScreen warning

Every piece is plain, hackable JavaScript — no build step for the app itself.
