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
- **Keyword auto-filing** — a rule-based classifier (`rules.json`) scores your text against
  keyword and `#tag` lists and picks a folder (Tasks, Ideas, Journal, Research, People,
  Projects, Quotes, or Inbox as fallback). No AI calls, fully offline and private.
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
  show the file on disk.
- **Import** — copy images / PDFs into `attachments/` (embedded as Markdown), or save a URL
  as its own note in `Links/`.

## Run it

You need [Node.js](https://nodejs.org) (v18+).

```bash
cd synapse
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

## Project layout

| File | Role |
|------|------|
| `main.js` | Electron main process — owns the filesystem & IPC |
| `preload.js` | Secure bridge exposing `window.synapse` to the UI |
| `classifier.js` | Keyword routing + Markdown parsing (unit-tested) |
| `vault.js` | Scans the folder, builds the `{nodes, links}` graph model |
| `src/index.html` / `styles.css` | The capture screen + workspace shell |
| `src/graph.js` | Dependency-free force-directed graph on `<canvas>` |
| `src/renderer.js` | Wires the UI to the main process |
| `rules.json` | Default sorting rules (copied into each new vault) |

## Roadmap ideas

- Backlinks panel and unlinked-mention suggestions
- PDF thumbnails as graph nodes
- Optional AI fallback for ambiguous notes (hybrid mode)
- Local full-text search across note bodies
- Time-lapse / "what did I think about this week" view

Built as an MVP scaffold — the capture → classify → graph loop is fully working and every
piece is plain, hackable JavaScript.
