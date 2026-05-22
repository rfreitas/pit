/**
 * refresh-settings op — rewrites the filtered settings file from host settings.
 * No display logic — errors propagate to the socket boundary (server.ts).
 */

import * as Effect from "effect/Effect";
import { FileSystem } from "@effect/platform/FileSystem";
import { readPitConfig, writeFilteredSettings } from "../../core/sandbox/io.ts";

export const opRefreshSettings = (
  agentDir: string,
  pitDir: string,
  hostSettingsPath: string,
): Effect.Effect<object, never, FileSystem> =>
  Effect.gen(function* () {
    const config = yield* readPitConfig(pitDir);
    return yield* writeFilteredSettings(agentDir, config, hostSettingsPath).pipe(
      Effect.map(() => ({ ok: true }) as object),
      Effect.catchAll((e) => Effect.succeed({ error: e.message })),
    );
  });
