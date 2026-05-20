/**
 * Typed error classes for pit, using Effect's Data.TaggedError.
 * One error per distinct failure mode — callers pattern-match on the tag.
 */

import { Data } from "effect";

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
