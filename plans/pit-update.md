# Plan: `pit update` updates pit's own pi dependency

## Problem

Today `pit update` is a blind passthrough to the global `pi` CLI:

```ts
// pit/src/program.ts
if (filteredArgv.length > 0 && PI_SUBCOMMANDS.has(filteredArgv[0])) {
  const r = spawnSync("pi", filteredArgv, { stdio: "inherit", shell: false });
  process.exit(r.status ?? 0);
}
```

`pi update` only ever does a **global** `npm install -g @earendil-works/pi-coding-agent@latest`
(inspected in `pi-coding-agent/dist/config.js` → `detectInstallMethod` / `getSelfUpdateCommandForMethod`).
It never touches a local `node_modules`. pit, at runtime, loads the **hoisted local copy**
it resolves from its own `import { main } from "@earendil-works/pi-coding-agent"` — which in
this repo is `agent/node_modules/@earendil-works/pi-coding-agent` (v0.80.3), not the global
install (v0.75.4). So `pit update` bumps the wrong thing and leaves pit's actual runtime
dependency untouched.

## Goal

`pit update` updates the `pi-coding-agent` (and the lockstep siblings `pi-ai`, `pi-tui`) that
pit actually loads — in whatever topology pit runs in. It does **not** touch the global `pi` CLI.

## Topologies

| Topology | `require.resolve("@earendil-works/pi-coding-agent")` from pit points at | Update mechanism |
|---|---|---|
| Local workspace (today) | hoisted `agent/node_modules/...` | `npm install` at workspace root with refreshed range |
| Global pit, bundled dep (future publish shape) | pit's own `node_modules` under the global prefix | `npm i -g @ricfr/pit@latest` |
| Global pit, peer on global pi | global `pi`'s `node_modules` | passthrough to `pi update` (only case passthrough is correct) |

Row 3 only exists if pit is published with `pi-coding-agent` as a `peerDependency`. Row 2 is
the recommended publish shape (see Tradeoffs). The dispatcher below handles all three; row 3
is a fallback, not the default.

## Design

### Phase 1 — topology detection (`pit/src/core/update.ts`)

Resolve at runtime:
- `binDir` = `realpath(argv[1])` dir.
- `resolvedPi` = `require.resolve("@earendil-works/pi-coding-agent")` realpath — the *actual*
  copy pit will load. This is the source of truth, not any declaration.
- `repoRoot` = nearest ancestor of `binDir` with a `package.json` containing `workspaces`
  (fallback: nearest `.git`).
- `globalRoot` = `npm root -g` realpath.

Classify by where `resolvedPi` lives:
- **local** — under `repoRoot/node_modules` → Phase 2.
- **bundled-global** — under the global prefix and inside a `pit` install → Phase 3.
- **peer-global** — under the global prefix inside a `pi` install → passthrough to `pi update`
  (row 3). Log a one-line FYI that this updates the global `pi`.

### Phase 2 — local-repo update

1. `npm view <pkg> version` for each of `{pi-coding-agent, pi-ai, pi-tiu}` that is actually
   declared in `repoRoot/package.json` (don't touch undeclared ones).
2. Write `^<latest>` into the `devDependencies` of `repoRoot/package.json` **and**
   `pit/package.json`, only in keys that already declare the package. Leave
   `peerDependencies` at `*` (compatibility surface, not install constraint).
3. `spawn("npm", ["install"], { cwd: repoRoot, stdio: "inherit" })`.
4. Print `old → new` per package. Exit with npm's exit code.

### Phase 3 — bundled-global self-update (gated on publish shape decision)

1. `npm view @ricfr/pit version` → latest.
2. If current == latest and no `--force`: print "up to date", exit 0.
3. Else `spawn("npm", ["i", "-g", "@ricfr/pit@latest"], { stdio: "inherit" })`. This pulls
   fresh pi-coding-agent as a bundled dep. No global `pi` touched.
4. Windows quarantine: skip for now (Linux/Mac only). TODO referencing
   `pi-coding-agent/dist/utils/windows-self-update.js` for when a global build ships.

### Phase 4 — wire into `program.ts`

Route `update` to `update.ts`. Keep `install`/`remove`/`uninstall`/`list`/`config` as `pi`
passthroughs (they're about pi packages, not pit). Drop the blanket passthrough for `update`.
Support `--force` (Phase 3) and `--all`/`--extensions` only as forward-to-`pi` for the
peer-global row.

## Tradeoffs (discussed and resolved)

### Keep the hoist, don't "rely on global pi" for local dev

**Rejected alternative:** drop the local dev dep, `npm link @earendil-works/pi-coding-agent`
to the global install, make `pit update` a one-line passthrough to `pi update`.

Why rejected (verified, not asserted):
- Node ESM resolution **does not consult the global npm prefix**. A bare specifier
  `@earendil-works/pi-coding-agent` only resolves by walking up for a local `node_modules`.
  `NODE_PATH` is CommonJS-only and is ignored by ESM. Verified on Node 24:
  `ERR_MODULE_NOT_FOUND` both with and without `NODE_PATH` set to `npm root -g`.
- So "rely on global" requires `npm link`, which is a manual per-clone step that `rm -rf
  node_modules && npm install` silently drops. Loses clone-and-run, loses the lockfile pin
  on pit's runtime dep, and adds environment state that rots.
- The hoist regenerates from `package-lock.json` on every install and pins the exact pi
  pit is tested against. The ~40 lines of `update.ts` preserve that for free.

### Publish shape: bundled `dependency`, not peer

If published with `pi-coding-agent` as a `peerDependency`, "update pit's pi" becomes "update
global pi" — which contradicts the stated constraint (don't touch global pi) and couples pit's
runtime version to the global CLI's release cadence.

Recommended: when publishing, move `pi-coding-agent`/`pi-ai`/`pi-tui` from `peerDependencies`
to `dependencies` in `pit/package.json` (or maintain a publish-shaped `package.json`). Then a
global pit install bundles its own pi, independent of the global `pi` CLI. Two copies on disk
for a user with both — identical to today's local situation (pit uses repo copy, `pi` CLI uses
global), so consistent, not a regression.

### Why `^<latest>` and not `*`

Keep ranges floating at the major (`^0.80.3`) so a fresh `npm install` is reproducible from
the lockfile without forcing every patch bump through `pit update`. `peerDependencies` stay
`*` because they describe compatibility, not a pinned install.

## Tests (`pit/tests/update.test.ts`)

Unit (no real npm):
- **Topology classifier** — temp-dir fixtures simulating each row of the table:
  (a) workspace tree with hoisted `node_modules/@earendil-works/pi-coding-agent` under a
  `.git` root; (b) global-prefix layout with a `pit` install owning its own `node_modules`;
  (c) global-prefix layout where the resolved package lives under a `pi` install. Assert the
  classifier returns `local` / `bundled-global` / `peer-global`.
- **Range writer** — given a fake `repoRoot/package.json` and `pit/package.json` with the
  current `*`/`^x` declarations and a `{ "pi-coding-agent": "0.81.0" }` latest map, assert:
  `devDependencies` get `^0.81.0` in both files, `peerDependencies` stay `*`, undeclared
  packages are untouched, idempotent on re-run.
- **Spawn args** — assert the constructed argv/cwd for Phase 2 (`["install"]` at `repoRoot`)
  and Phase 3 (`["i","-g","@ricfr/pit@latest"]`) without executing npm. Stub `spawn` via
  dependency injection (a `runCmd` port, same pattern as existing `pit/src/core/` IO).

Integration (gated behind `PIT_UPDATE_INTEGRATION=1`, off by default — mutates node_modules):
- Fresh temp workspace with a local registry fixture (or `npm view` against the real registry
  with `--prefer-offline`), run the real Phase 2 path, assert the hoisted copy's
  `package.json` version matches the latest map.

No test executes a real `npm i -g`.

## Build order

1. Phases 1, 2, 4 + tests (local topology) — fixes the actual problem today.
2. Publish-shape change (peer→dep in `pit/package.json`) + Phase 3 + Windows TODO — when
   global publish is on the table.
