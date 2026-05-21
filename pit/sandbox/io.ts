/**
 * Sandbox IO — reads/writes pit config and settings, discovers unversioned dirs.
 * All IO operations are Effect-based with platform services.
 */

import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import { make as makeCommand, lines as commandLines } from "@effect/platform/Command";
import { FileSystem } from "@effect/platform/FileSystem";
import { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import type { PitConfig } from "../types.ts";
import { applyDenylist } from "./pure.ts";
import { SettingsWriteError } from "../errors.ts";

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
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of [...a, ...b]) {
      if (!raw.endsWith("/")) continue;
      const rel = raw.replace(/\/$/, "");
      if (rel && !seen.has(rel)) {
        seen.add(rel);
        result.push(rel);
      }
    }
    return result;
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

// ── settings filtering ────────────────────────────────────────────────────────

/**
 * Write filtered settings to the given path.
 * Propagates SettingsWriteError — caller decides whether to abort or continue.
 */
export const writeFilteredSettings = (
  agentDir: string,
  pitConfig: PitConfig,
  hostSettingsPath: string,
): Effect.Effect<void, SettingsWriteError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const settingsPath = join(agentDir, "settings.json");
    const exists = yield* fs.exists(settingsPath).pipe(Effect.orElse(() => Effect.succeed(false)));
    const raw = exists
      ? yield* fs.readFileString(settingsPath).pipe(Effect.orElse(() => Effect.succeed("{}")))
      : "{}";
    const settings = (() => {
      try { return JSON.parse(raw.trim() || "{}") as Record<string, unknown>; }
      catch { return {} as Record<string, unknown>; }
    })();
    const filtered = applyDenylist(settings, pitConfig.denyPackages ?? []);
    yield* fs.makeDirectory(dirname(hostSettingsPath), { recursive: true }).pipe(
      Effect.ignore,
    );
    yield* fs.writeFileString(hostSettingsPath, JSON.stringify(filtered, null, 2) + "\n").pipe(
      Effect.mapError(
        (e) => new SettingsWriteError({ message: String(e) }),
      ),
    );
  });

/**
 * Create a temporary file in tmpdir(), write filtered settings into it,
 * and return the path. Caller is responsible for deleting it when done.
 */
export const createTempSettingsFileEffect = (
  agentDir: string,
  pitConfig: PitConfig,
): Effect.Effect<string, SettingsWriteError, FileSystem> =>
  Effect.gen(function* () {
    const tmp = join(tmpdir(), `pit-settings-${process.pid}.json`);
    yield* writeFilteredSettings(agentDir, pitConfig, tmp);
    return tmp;
  });
