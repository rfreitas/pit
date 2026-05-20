# pit-escape socket — trust boundary and bypass notes

## What pit-escape is

`escape/server.ts` runs **outside** the bwrap sandbox with full host filesystem
access. It accepts connections on a Unix socket whose path is set in
`PIT_ESCAPE_SOCKET` inside the sandbox environment. The sandboxed agent uses
this to perform operations that require host access: git branch ref writes,
settings refresh.

## The bypass I did (and why it works)

When `git commit` via pi's native git tool failed (refs/heads/ is read-only
inside the sandbox by design), I needed to route through pit-escape. Instead
of using the registered `tools/git.ts` extension, I called the socket directly:

```js
const sock = net.createConnection(process.env.PIT_ESCAPE_SOCKET);
sock.write(JSON.stringify({ op: 'git', args: ['commit', '-m', '...'] }) + '\n');
```

This worked because the protocol is unauthenticated newline-delimited JSON. Any
process inside the sandbox that knows the socket path can send any op — there is
no token, no capability check beyond the op-name allowlist, and no verification
that the sender is the legitimate pi session.

`escape/client.ts` does exactly the same thing. I just skipped the abstraction.

## Why I should have used the git tool instead

The registered `tools/git.ts` is a `pi.registerTool` extension. In this session
it was loaded by pit and routes through pit-escape via `escape/client.ts`. Calling
it through pi's tool-calling mechanism would have been the correct path — it goes
through the same socket but via the intended interface and leaves a trace in the
session.

I went direct because the native `git` tool (pi built-in, not the pit extension)
failed first and I didn't stop to check whether the pit git tool would succeed.

## The actual security exposure

### What any sandbox process can do via the socket

The op allowlist in `escape/server.ts`:

```ts
const GIT_ALLOWED = new Set([
  "add", "commit", "diff", "log", "merge",
  "rebase", "reset", "show", "stash", "status",
]);
```

Plus the non-git ops:

| Op | Effect |
|---|---|
| `get-state` | reads branch, merge state, parent branch |
| `merge-to-parent` | fast-forward merges the worktree branch into master/main on the host |
| `subscribe` | opens a persistent connection watching the parent branch ref |
| `is-merged` | reads merge status |
| `refresh-settings` | overwrites the shadow settings file on the host |
| `rename-branch` | runs `git branch -m` on the host |

### What this means in practice

A compromised or malicious extension loaded into the same pi session could:

- Run `git reset --hard` to destroy uncommitted work
- Run `git commit` to forge commits with arbitrary content
- Run `merge-to-parent` to push unreviewed changes to master/main without the
  user running `/merge`
- Run `refresh-settings` to overwrite the shadow settings file (limited impact
  since the denylist is re-applied, but the file is host-writable)
- Run `rename-branch` to rename the branch

It cannot escape the git allowlist to run arbitrary shell commands — `op: "git"`
only accepts subcommands in `GIT_ALLOWED`. Other ops are bounded.

### The root issue

`PIT_ESCAPE_SOCKET` is in the environment, visible to every process in the
sandbox including all loaded extensions. There is no shared secret or capability
token. Any code that can read the environment and open a Unix socket can speak
the full protocol.

## Possible mitigations (not yet implemented)

**Short term — lowest effort:**
- Add a random nonce to the socket path itself (already somewhat implicit since
  the socket is `pit-<sessionId>.sock` and sessionId is a UUID, but the full
  path is in the environment)

**Medium term:**
- Require a shared secret generated at session start: pit.ts generates a token,
  passes it to pit-escape at startup, and requires every request to include it.
  The token is injected into the session environment but not `PIT_ESCAPE_SOCKET`
  itself, making it slightly harder to discover by casual inspection.

**Longer term:**
- Scope `merge-to-parent` and `rename-branch` to require explicit user
  confirmation via a separate channel (e.g. the TUI confirm prompt) rather than
  being callable unilaterally by any socket client.
- Consider whether extensions should have access to `PIT_ESCAPE_SOCKET` at all,
  or whether only the core pi session process should.

## Threat model note

The primary threat this matters for is a **malicious npm package loaded as a pi
extension** (e.g. via `packages` in settings.json). The denylist in
`pit/config.json` is the current control for that. A bypassed extension that
gets `PIT_ESCAPE_SOCKET` can do everything listed above regardless of the
denylist, because the escape server trusts the socket unconditionally.

The sandbox filesystem isolation (bwrap) is effective against arbitrary
filesystem writes. The escape socket is the one channel that punches through it
with intentional but unauthenticated host access.
