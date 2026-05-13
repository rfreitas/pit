# pi-agent

Personal [Pi coding agent](https://pi.dev) extensions, scripts, and tooling. Cross-platform (Windows + Unix).

## Structure

```
extensions/   Pi extensions — auto-loaded globally via ~/.pi/agent/settings.json
              Simple single-file extensions live here directly.
              Extensions with tests/multiple files live in packages/ with a copy installed here.
packages/     Extension subprojects (source + tests). See each package's AGENTS.md.
bin/          Shell scripts (Git Bash / WSL on Windows, bash on Unix)
plans/        Design docs and notes
```

## How extensions are loaded

`~/.pi/agent/settings.json` points Pi at the `extensions/` folder:

```json
{
  "extensions": ["C:/Users/ricfr/Repos/agent/extensions"]
}
```

Any `.ts` file dropped in `extensions/` is picked up automatically on the next `/reload` or Pi restart.

### Imports

Pi loads extensions via [jiti](https://github.com/unjs/jiti) (TypeScript without compilation). It resolves `node_modules` by walking up the directory tree from the extension file, so the `package.json` at the repo root covers all extensions in `extensions/`.

The Pi core packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `typebox`) are bundled by Pi at runtime — they don't need to be in `node_modules` to work. They're installed here as `devDependencies` only for type checking.

To add an npm dependency to an extension:

```bash
npm install <package>      # adds to package.json + node_modules
# jiti will resolve it automatically at runtime
```

### Type checking

```bash
npm run typecheck
```

---

## Extensions

### `/handoff` — Move session to another project

Source lives in `packages/handoff/`. The `extensions/handoff.ts` file is a gitignored copy — see `packages/handoff/AGENTS.md` for development workflow.

### `/rename` — Ask the model to name the session

Reads the conversation history, calls the active model with a structured JSON prompt, and sets the session name in the Pi session picker.

```
/rename
```

- Uses whatever model is currently active (`ctx.model`)
- Asks for `{"name": string}` — 2–5 words, Title Case, no punctuation
- Safe parses the response (regex-extracts the JSON object before parsing)

---

## bin/

### `pit` — Git worktree manager for Pi

Creates isolated git worktrees and launches Pi inside them. Useful for working on multiple tasks in parallel without interfering with the main branch.

```bash
pit              # create a new worktree (branch: pi/<id>) and launch pi
pit list         # list pit worktrees for the current repo
pit list --all   # list all pit worktrees across all repos
pit clean        # remove orphaned registry entries
pit clean <id>   # remove a specific worktree, its branch, and registry entry
```

Each worktree gets a short random id (8 hex chars). Pi is launched inside the worktree so it picks up the correct `cwd` and creates its own session naturally.

**Registry:** `~/.pi/pit/registry.json` — single source of truth, no per-worktree marker files.

**Platform:** requires bash + git. On Windows, use Git Bash or WSL. Add `bin/` to your `PATH`:

```bash
# Git Bash / WSL (~/.bashrc or ~/.bash_profile)
export PATH="$HOME/Repos/agent/bin:$PATH"
```

---

## Setup

### 1. Clone and install

```bash
git clone <repo-url> ~/Repos/agent
cd ~/Repos/agent
npm install
```

### 2. Point Pi at the extensions folder

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["C:/Users/<you>/Repos/agent/extensions"]
}
```

On Unix:
```json
{
  "extensions": ["/home/<you>/Repos/agent/extensions"]
}
```

### 3. Add bin/ to PATH (optional, for `pit`)

```bash
export PATH="$HOME/Repos/agent/bin:$PATH"
```

### 4. Reload Pi

```
/reload
```

---

## Installed Pi packages

Managed via `pi install` and tracked in `~/.pi/agent/settings.json`:

| Package | Purpose |
|---|---|
| `@casualjim/pi-heimdall` | Blocks dangerous bash commands, protects `.env` and secrets |
| `@spences10/pi-confirm-destructive` | Confirms before destructive session actions |
| `@jerryan/pi-sanity` | Sanity checks on agent operations |
