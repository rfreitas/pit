# Agent Instructions

This repo contains personal Pi agent extensions and tooling.

## Extensions

Extensions live in `extensions/`. They are auto-loaded by Pi via `~/.pi/agent/settings.json`.

### Adding dependencies

Pi bundles the following packages at runtime — do NOT add them to `package.json`, just import them directly:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-ai`
- `typebox`

Node.js built-ins (`node:fs`, `node:path`, `node:crypto`, etc.) are always available.

For anything else, install it explicitly:

```bash
cd C:/Users/ricfr/Repos/agent   # always install here, not globally
npm install <package>
```

This installs into `node_modules/` local to this repo. Jiti resolves imports by walking up from the extension file's path, so it will find packages here regardless of what directory pi is running from. Do not use `npm install -g`.

**If you add a non-bundled import to any extension without running `npm install`, it will crash at runtime.**

After installing, run `npm run typecheck` to verify.
