# pit/src/escape

The out-of-sandbox helper process. Communicates with the sandboxed Pi session over a Unix socket.

## Two parts

**`server.ts`** — boundary. Socket setup, request routing via `dispatchEffect`, single `.catch` converts unhandled op errors to `{ error: "..." }` responses. No op logic here.

**`core/ops/`** — domain logic. Op implementations. No display logic — errors propagate to `server.ts`. Same rule as `pit/src/core/`: no `console.*`, no `process.exit`.

| File | Ops handled |
|---|---|
| `git.ts` | `gitEffect`, `detectParentBranch` (shared helper) |
| `state.ts` | `get-state` |
| `merge.ts` | `merge-to-parent`, `is-merged` |
| `diff.ts` | `loc-diff` |
| `settings.ts` | `refresh-settings` |
| `subscribe.ts` | `subscribe` (persistent connection, pushes `ref-change` events) |

## Protocol

Newline-delimited JSON over a Unix socket. One request per connection except `subscribe`. Socket path passed into the sandbox via `PIT_ESCAPE_SOCKET`.
