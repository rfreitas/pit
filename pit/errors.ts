/**
 * Typed error classes for pit, using Effect's Data.TaggedError.
 * One error per distinct failure mode — callers pattern-match on the tag.
 *
 * Note: eslint-disable functional/no-class-inheritance — Effect's TaggedError
 * pattern requires class inheritance. This is the only place in the codebase
 * that uses it and it cannot be avoided with the Effect API.
 */
/* eslint-disable functional/no-class-inheritance */

import * as Data from "effect/Data";

// ── worktree errors ───────────────────────────────────────────────────────────

export class WorktreeCreationError extends Data.TaggedError("WorktreeCreationError")<{
  readonly message: string;
}> {}

export class WorktreeMissingError extends Data.TaggedError("WorktreeMissingError")<{
  readonly branch: string;
}> {}

// ── socket / pit-escape errors ────────────────────────────────────────────────

/** pit-escape is already listening on this socket — another terminal has it open. */
export class SocketAliveError extends Data.TaggedError("SocketAliveError")<{
  readonly sessionId: string;
}> {}

// ── session errors ────────────────────────────────────────────────────────────

export class SessionWriteError extends Data.TaggedError("SessionWriteError")<{
  readonly message: string;
}> {}

// ── settings errors ───────────────────────────────────────────────────────────

export class SettingsWriteError extends Data.TaggedError("SettingsWriteError")<{
  readonly message: string;
}> {}
