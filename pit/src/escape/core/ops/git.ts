/**
 * Git subprocess helper and parent-branch detection for pit-escape ops.
 * No display logic — errors propagate to the socket boundary (server.ts).
 */

import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Chunk from "effect/Chunk";
import { make as makeCommand, start as startCommand, workingDirectory as commandWorkingDirectory } from "@effect/platform/Command";
import { type NodeContext } from "../../../node-context.ts";

export type GitResult = { stdout: string; stderr: string; code: number };

/**
 * Run a git command and capture stdout, stderr, and exit code.
 * Absorbs all failures into { code: 1 } so op handlers always succeed.
 */
export const gitEffect = (
  args: string[],
  cwd: string,
): Effect.Effect<GitResult, never, NodeContext> =>
  Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* startCommand(
        commandWorkingDirectory(makeCommand("git", ...args), cwd),
      );
      const decoder = new TextDecoder("utf8");
      const [stdoutChunks, stderrChunks, code] = yield* Effect.all([
        Stream.runCollect(proc.stdout),
        Stream.runCollect(proc.stderr),
        proc.exitCode,
      ]);
      return {
        stdout: Chunk.toReadonlyArray(stdoutChunks).map((c) => decoder.decode(c)).join(""),
        stderr: Chunk.toReadonlyArray(stderrChunks).map((c) => decoder.decode(c)).join(""),
        code: Number(code),
      };
    }),
  ).pipe(
    Effect.catchAll(() => Effect.succeed({ stdout: "", stderr: "", code: 1 })),
  );

/**
 * Detect the parent branch (master or main) in a repo.
 * Returns null when neither branch exists or git fails.
 */
export const detectParentBranch = (mainRepo: string): string | null =>
  ["master", "main"].find(candidate => {
    try {
      execFileSync("git", ["rev-parse", "--verify", candidate], { cwd: mainRepo, stdio: "ignore" });
      return true;
    } catch { return false; }
  }) ?? null;
