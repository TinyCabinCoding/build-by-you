# Build by Grok

Build by Grok is a Codex-style VS Code chat agent powered by the xAI Grok API. It helps inspect, edit, test, preview, and ship the repo currently open in VS Code.

It is built for early builders, students, creators, and developers who want a focused AI coding workspace without leaving the editor.

## Highlights

- Grok-powered build, Astro, find, repair, security-audit, slide-deck, and Python lab workflows
- Grok Imagine project image generation for local project assets
- Clean sidebar chat with screenshot/file attachments, clipboard image paste, voice dictation, and recent chats
- Start/Stop Server support for Astro, Vite/React, Slidev, static HTML, and common npm previews
- Dedicated `/astro` AstroMax Agent for Astro sites, islands, Tailwind, integrations, debugging, and deploy-ready builds
- Dedicated `/py` Python Lab Agent for scripts, data generation, plots, dashboards, and junior-scientist projects
- Dedicated `/sd` Slide Deck Agent for Slidev/Marp decks, Vercel-ready decks, and image-heavy presentations
- Dedicated `/find` read-only rail for locating files, copy, handlers, routes, and repo sections
- Explicit `/streamlit <path>` runner for Streamlit apps through the project `.venv`
- Cloudflare `/cf`, Vercel `/vc`, and Git/GitHub `/git` workflows
- Default approval mode plus Full Access for faster autonomous builds
- Local preview panel, terminal-backed command execution, concise final summaries, and diff reports

## What You Can Build

- Astro, React/Vite, and static HTML sites, with a dedicated AstroMax rail for Astro-first builds
- Founder hubs, bio sites, portfolios, marketing pages, and small product sites
- Slidev and Marp slide decks
- Python science labs, CSV generation, plots, Plotly dashboards, and Streamlit apps
- Cloudflare Pages/Workers and Vercel-ready projects

## Latest Release Notes

### 4.20.143

- Improved `/find` search behavior with case-insensitive natural-language keyword extraction, ranked partial matches, and path/name matches.
- Added a find-specific fallback response so incomplete find turns report candidate files or searched context instead of a generic inspected-steps summary.

### 4.20.144

- Added `/search` as an alias for the read-only find rail alongside `/find` and `/locate`.

### 4.20.142

- Added `/find` and `/locate` read-only search rails for locating files, copy, routes, handlers, and repo sections without editing or running commands.
- The find rail checks README-style files first for repo context, then searches exact terms and useful variants before returning file paths and line numbers.

### 4.20.141

- Removed the experimental `/imageadjust` and `/imgadjust` flags.
- Restored image handling to the Grok-driven behavior from before the local optimizer experiment.

### 4.20.140

- Added a default-agent instruction for empty-workspace Astro builds so the agent scaffolds immediately and continues editing.
- Keeps Astro site generation on the fast direct rail without adding another retry loop.

The extension is workspace-native:

- Single-folder workspace: uses that repo automatically
- Multi-root workspace: lets you choose the active workspace folder
- No workspace open: repo tools stay disabled until you open a folder

## What It Does

- Uses the Activity Bar sidebar as the primary coding chat surface
- Supports a popout chat window when you want a larger temporary workspace
- Keeps the UI focused on the conversation instead of duplicating terminal output inside chat
- Stores your xAI API key in VS Code Secret Storage
- Resolves the active repo from the current VS Code workspace
- Streams assistant responses into the chat UI, including lightweight `Thinking:` previews when the API provides them
- Supports image attachments from file picker, drag and drop, and clipboard paste
- Adds a guided `Build New Site` flow for greenfield web project creation
- Adds explicit `Verify` and `Repair` workflows for build, lint, compile, and test loops
- Offers a direct Verify -> Repair handoff when verification fails
- Lets Grok inspect, edit, run commands, and check results inside the selected workspace
- Keeps all file operations scoped to the selected workspace folder
- Opens approval/review flows for edits and commands when your execution mode requires them
- Reuses an integrated terminal session per workspace folder
- Detects local preview URLs from dev-server output
- Adds `Start Server` and `Stop Server` controls for common local web workflows
- Includes Cloudflare slash commands through `/cf` and `/cloudflare` for Wrangler-based setup and deployment tasks

## Common Uses

- Build a small site or landing page from a simple prompt
- Inspect or repair an existing repo
- Run verify/repair loops while staying inside VS Code
- Attach screenshots to ask the model about UI bugs or layout problems
- Create and deploy Cloudflare Pages or Workers projects with Wrangler shortcuts
- Build slide decks, Python lab scripts, Streamlit apps, and static HTML reports
- Push projects toward GitHub, Cloudflare, or Vercel with command shortcuts

## Install And Run

1. Open this repo in VS Code.
2. Run `npm install` if dependencies are not already present.
3. Run `npm run compile`.
4. Press `F5` in VS Code to launch the Extension Development Host.
5. In the new VS Code window, run `Build by Grok: Open Chat Sidebar` from the Command Palette.

You can also use the `Build by Grok` view container in the Activity Bar and work from the `Build by Grok` sidebar view.

## Local Preview

When a dev server prints a localhost URL like `http://localhost:3000` or `http://127.0.0.1:5173`, Build by Grok detects it from terminal output and keeps the latest preview URL for that workspace.

You can open it using:

- the `Start Server` button to launch a dev server when one is configured
- the `Open Preview` button in the chat UI
- `/preview`
- `/open`

To start a local dev server quickly:

- click `Start Server`
- use `/dev`
- use `/serve`

This is meant to make local web builds easy to check without adding full browser automation.

## Build New Site

You can start a new site flow from:

- the `Build New Site` button in the chat UI
- `Build by Grok: Build New Site`

The sidebar is the default chat experience. If you want a larger temporary surface, use `Build by Grok: Open Chat Popout`.

The extension asks:

1. what kind of site you want to build
2. what tech stack you want to use

It also gives guided quick-pick options for common site types such as marketing, dashboard, portfolio, blog, ecommerce, and docs, plus suggested stack directions like Next.js, Astro, Vite + React, and Nuxt.

If you answer `IDK` for the stack, Grok recommends suitable stack options based on the requested site style and goals before moving into implementation.

## Verify And Repair Loop

You can now run explicit verification and repair flows from the chat UI:

- `Verify`
  Runs the available verification presets such as `compile`, `build`, `lint`, and `test`.
- `Repair`
  Checks the repo, applies fixes when possible, and reruns the relevant check before reporting the result.

When verification fails and an xAI API key is configured, you can hand the issue directly to Repair from the chat.

## Build A VSIX Package

To build an installable extension package:

1. Run `npm install`
2. Run `npm run package:vsix`
3. The package will be created as `grokrepchat-<version>.vsix`

To install it in VS Code:

1. Open Extensions
2. Click the `...` menu in the top right
3. Choose `Install from VSIX...`
4. Select the generated `grokrepchat-<version>.vsix`

## API Key Setup

Use one of these:

1. Command Palette:
   Run `Build by Grok: Set xAI API Key`
2. Chat panel:
   Click `Set API Key`

The key is stored in VS Code Secret Storage, not in `settings.json`.

If you want a full clean slate without reinstalling, use `Build by Grok: Factory Reset Workspace State`. It clears workspace chat memory, timeline, workflow state, task history, terminal history, and can optionally clear the stored API key too.

To clear it:

- Run `Build by Grok: Clear xAI API Key`
- Run `Build by Grok: Build New Site`
- Run `Build by Grok: Factory Reset Workspace State`
- Run `Build by Grok: Verify Workspace`
- Run `Build by Grok: Repair Workspace`
- Run `Build by Grok: Start Dev Server`
- Run `Build by Grok: Open Preview`
- Run `Build by Grok: Open Workspace Terminal`
- Run `Build by Grok: Open Source Control`
- Run `Build by Grok: Rerun Last Workflow`
- Run `Build by Grok: Show Last Failure`

## Settings UI

This extension uses the normal VS Code extension settings UI. Open:

- Command Palette -> `Preferences: Open Settings (UI)`
- Search for `grokrepchat`

Or from the command palette, open the extension settings directly.

Available settings:

- `grokrepchat.baseUrl`
- `grokrepchat.executorModel`
- `grokrepchat.imageModel`
- `grokrepchat.commandTimeoutMs`
- `grokrepchat.maxRepairIterations`
- `grokrepchat.requireApprovalForFileWrites`
- `grokrepchat.requireApprovalForCommands`
- `grokrepchat.autonomousCommandPolicy`
- `grokrepchat.autonomousAllowedCommands`
- `grokrepchat.safeCommandPrefixes`
- `grokrepchat.blockedCommandPatterns`
- `grokrepchat.autoStageApprovedChanges`
- `grokrepchat.persistSensitiveHistory`
- `grokrepchat.maxToolOutputChars`
- `grokrepchat.maxReadFileChars` (500,000-character minimum effective read window for source/page/config file context)
- `grokrepchat.taskPresets`

## Modes, Models, and Audit Coverage

Default Mode lets low-risk edits and safe commands run with less friction while keeping sensitive reads, deletes, critical files, and higher-risk commands behind approval. Full Access runs non-blocked workspace file edits and commands autonomously for faster builds and repairs.

Build, repair, slide-deck, and security-audit turns use the configured Grok coding model. Image generation uses the configured Grok image model and stores generated assets locally in the project.

Security Audit is broad repository analysis, not a formal penetration test. It reviews common source, dependency, configuration, auth, deployment, data-handling, and secrets-risk areas when those files exist.

## How Repo Selection Works

- If one workspace folder is open, that folder is the repo scope.
- If multiple workspace folders are open, use the `Workspace` button in the chat panel or run `Build by Grok: Select Workspace Folder`.
- Work is scoped to the selected workspace folder.

## Execution Mode

At the bottom of the chat UI there is an access-mode selector:

- `Verify All Changes`
  File edits and shell commands go through the review/approval flow.
- `Allow Grok To Make Changes Autonomously`
  Grok can apply edits and run commands without per-action approval for the current chat session.

This mode is session-scoped and persists for the current workspace session.

Autonomous command behavior can be adjusted in VS Code settings.

## Slash Commands

- `/help`
- `/reset`
- `/settings`
- `/workspace`
- `/verify`
- `/repair`
- `/find <prompt>`
- `/locate <prompt>`
- `/search <prompt>`
- `/astro <prompt>`
- `/security`
- `/audit`
- `/rerun`
- `/failure`
- `/sidebar`
- `/panel`
- `/dev`
- `/serve`
- `/streamlit <path>`
- `/st <path>`
- `/terminal`
- `/history`
- `/run <command>`
- `/py <prompt>`
- `/python <prompt>`
- `/py deps basic`
- `/py deps science`
- `/py run <path>`
- `/py check <path>`
- `/slide-deck [--slidev|--marp] [--vercel] <prompt>`
- `/slide [--slidev|--marp] [--vercel] <prompt>`
- `/sd [--slidev|--marp] [--vercel] <prompt>`
- `/cf help`
- `/cf login`
- `/cf update`
- `/cf deploy`  (Workers deploy)
- `/cf pages create <name>`
- `/cf pages deploy <dir> [--project-name <name>]`
- `/cf worker init <name>`
- `/cf db create <name>`
- `/cf table <db> --file schema.sql`
- `/cf kv create <name>`
- `/cf r2 create <name>`
- `/vc help`
- `/vc login`
- `/vc whoami`
- `/vc link`
- `/vc deploy`
- `/vc deploy prod`
- `/vc dev`
- `/vc logs`
- `/vc inspect`
- `/vc open`
- `/preview`
- `/open`
- `/tasks`
- `/task <name>`
- `/git status`
- `/git diff [path]`
- `/git diff-staged [path]`
- `/git stage <path>`
- `/git stage-all`
- `/git unstage <path>`
- `/git unstage-all`
- `/git login`
- `/git whoami`
- `/git init`
- `/git start`
- `/git bootstrap`
- `/git branch`
- `/git checkout <branch>`
- `/git checkout-new <branch>`
- `/git commit <message>`
- `/git acp <message>`
- `/git remote`
- `/git remote add <url>`
- `/git remote add <name> <url>`
- `/git remote set <name> <url>`
- `/git push [remote] [branch]`
- `/git pull [remote] [branch]`
- `/git sync`
- `/git publish github <repo> [--public|--private]`
- `/git pr create [title]`
- `/scm`

## Task Presets

The extension automatically offers common presets when matching scripts exist:

- `lint`
- `test`
- `build`
- `compile`

You can also define your own in workspace settings:

```json
"grokrepchat.taskPresets": [
  {
    "name": "typecheck",
    "command": "npm run typecheck",
    "description": "Run project type checking"
  }
]
```

## Cloudflare Commands

Cloudflare/Wrangler flows are available through slash commands in chat.

Examples:

- `/cf login`
- `/cf update`
- `/cf deploy`  (Workers deploy)
- `/cf pages create my-site`
- `/cf pages deploy dist --project-name my-site`
- `/cf worker init my-worker`
- `/cf db create app-db`
- `/cf table app-db --file schema.sql`
- `/cf kv create APP_CACHE`
- `/cf r2 create uploads`
- `/cf wrangler tail`

Aliases:

- `/cf ...`
- `/cloudflare ...`

Behavior:

- `/cf wrangler <command>` runs the Wrangler command directly through `npx wrangler`.
- `/cf update` updates the local Wrangler dependency using the workspace package manager when possible.
- Most other `/cf` shortcuts expand to Wrangler commands and then run through the existing agent command flow with a concise summary.
- `/cf deploy` is for Workers. For static Pages sites, use `/cf pages deploy ...`.

## Vercel Commands

Vercel flows are available through their own slash-command provider path in chat.

Examples:

- `/vc login`
- `/vc whoami`
- `/vc link`
- `/vc deploy`
- `/vc deploy prod`
- `/vc dev`
- `/vc logs`
- `/vc inspect`
- `/vc open`

Aliases:

- `/vc ...`
- `/vercel ...`

Behavior:

- `/vc deploy` creates a preview deployment.
- `/vc deploy prod` runs a production deployment.
- `/vc help` shows the available commands and the current linked-project state when `.vercel/project.json` exists.
- `/vc vercel <command>` runs the Vercel CLI subcommand directly through `npx vercel`.

## Chat UI Notes

- The footer layout is responsive and should resize with the chat panel instead of staying fixed-width.
- The `+` launcher opens attachment actions and leaves room for future footer tools.
- `View S/D` reuses the local preview flow for Slidev workspaces and can open or start the deck preview path.

## Slide Deck Commands

Use these to tell the agent to build or update a presentation:

- `/slide-deck <prompt>`
- `/slide <prompt>`
- `/sd <prompt>`

Examples:

- `/slide-deck Create a 10-slide investor deck for our product launch`
- `/slide --slidev Turn this repo into a conference talk deck about the architecture`
- `/sd --marp Build a short internal kickoff presentation with speaker-friendly bullets`
- `/sd --slidev --vercel Build me a slide deck based around these specs: moon occupy`

Behavior:

- The slide-deck commands use a dedicated slide-focused agent mode.
- The agent prefers deck structure already present in the repo when possible.
- If no deck tooling exists yet, it defaults to Slidev.
- Marp is the fallback for simpler markdown-first or minimal deck builds.
- You can force the deck format inline with `--slidev` or `--marp`.
- You can add `--vercel` to make the agent prepare the deck for Vercel deployment, including a minimal `vercel.json` when it is absent and useful.
