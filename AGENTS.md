# Agent Instructions

This repo contains personal Pi agent extensions and tooling. Read `README.md` for the full structure overview.

## Documentation principles

- Human docs (`README.md`, package READMEs) hold the detail — keep them authoritative
- Agent docs (`AGENTS.md`) stay lean: point to human docs rather than duplicate them
- After structural changes, read `README.md` and relevant `AGENTS.md` files and update them to reflect the new structure

## Working on a package

Each package in `packages/` has its own `AGENTS.md`. Read it before making changes:

- `packages/handoff/AGENTS.md` — `/handoff` extension

## Extension dependencies

Pi bundles these at runtime — import directly, do NOT add to `package.json`:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-ai`
- `typebox`

Node.js built-ins (`node:fs`, `node:path`, `node:crypto`, etc.) are always available.

For anything else:

```bash
cd C:/Users/ricfr/Repos/agent   # always install here, not globally
npm install <package>
```

**If you add a non-bundled import without running `npm install`, it will crash at runtime.**

## After any change

```bash
npm run typecheck   # must pass
npm test            # must pass if tests exist for the changed code
```

If the change adds or modifies a feature, update `README.md` to reflect it:
- New flags, commands, or extensions → add to the relevant section
- Changed behaviour (mounts, config, protocols) → update the description
- New concepts or components → add a section if none exists

`README.md` is the authoritative human doc. Keep it in sync.
