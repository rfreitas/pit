/**
 * Sandbox IO — reads/writes pit config and settings, discovers unversioned dirs.
 * All IO operations are Effect-based with platform services.
 */

import { join } from "node:path";
import * as Effect from "effect/Effect";
import { make as makeCommand, lines as commandLines } from "@effect/platform/Command";
import { FileSystem } from "@effect/platform/FileSystem";
import { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import type { PitConfig } from "../../types.ts";

// ── unversioned dir discovery ─────────────────────────────────────────────────

/**
 * Return the relative paths of all unversioned directories in a git repo root.
 * Propagates PlatformError — a [] fallback on git failure silently breaks
 * the sandbox's overlay mounts (parent repo's node_modules etc. would be missing).
 */
export const resolveUnversionedDirs = (
  parentRepo: string,
): Effect.Effect<string[], PlatformError, CommandExecutor> =>
  Effect.gen(function* () {
    const runLines = (
      extra: string[],
    ): Effect.Effect<string[], PlatformError, CommandExecutor> =>
      commandLines(
        makeCommand(
          "git",
          "-C",
          parentRepo,
          "ls-files",
          "--others",
          "--directory",
          "--exclude-standard",
          ...extra,
        ),
      ).pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));

    const [a, b] = yield* Effect.all([runLines([]), runLines(["--ignored"])]);
    return [...new Set(
      [...a, ...b]
        .filter(raw => raw.endsWith("/"))
        .map(raw => raw.replace(/\/$/, ""))
        .filter(Boolean),
    )];
  });

// ── pit config ────────────────────────────────────────────────────────────────

/**
 * Read pit config, returning an empty object if the file doesn't exist or is malformed.
 * Absorbs all errors — absent config is a valid state.
 */
export const readPitConfig = (
  pitDir: string,
): Effect.Effect<PitConfig, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const configPath = join(pitDir, "config.json");
    const exists = yield* fs.exists(configPath).pipe(Effect.orElse(() => Effect.succeed(false)));
    if (!exists) return {};
    const raw = yield* fs.readFileString(configPath).pipe(Effect.orElse(() => Effect.succeed("")));
    try {
      return JSON.parse(raw) as PitConfig;
    } catch {
      return {};
    }
  });

