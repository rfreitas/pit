/**
 * Sandbox IO — reads/writes pit config and settings, discovers unversioned dirs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { PitConfig } from "../types.ts";
import { applyDenylist } from "./pure.ts";

// ── unversioned dir discovery ─────────────────────────────────────────────────

/**
 * Return the relative paths of all unversioned directories in a git repo root.
 * Used to build overlay mounts for the bwrap sandbox.
 * Returns [] if git is unavailable or the path is not a git repo.
 */
export function resolveUnversionedDirs(parentRepo: string): string[] {
  const run = (extra: string[]) => {
    try {
      return execFileSync(
        "git",
        ["-C", parentRepo, "ls-files", "--others", "--directory", "--exclude-standard", ...extra],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of [...run([]), ...run(["--ignored"])]) {
    if (!raw.endsWith("/")) continue;
    const rel = raw.replace(/\/$/, "");
    if (rel && !seen.has(rel)) { seen.add(rel); result.push(rel); }
  }
  return result;
}

// ── pit config ────────────────────────────────────────────────────────────────

/** Read pit config, returning an empty object if the file doesn't exist or is malformed. */
export function readPitConfig(pitDir: string): PitConfig {
  const configPath = path.join(pitDir, "config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as PitConfig;
  } catch {
    return {};
  }
}

// ── settings filtering ────────────────────────────────────────────────────────

/**
 * Write filtered settings to the host-side path used as the shadow agent dir's
 * settings.json. Applies the pit denylist before writing. Creates parent dirs.
 */
export function writeFilteredSettings(
  agentDir: string,
  pitConfig: PitConfig,
  hostSettingsPath: string,
): void {
  const raw = fs.existsSync(path.join(agentDir, "settings.json"))
    ? fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")
    : "{}";
  const settings = JSON.parse(raw) as Record<string, unknown>;
  const filtered = applyDenylist(settings, pitConfig.denyPackages ?? []);
  fs.mkdirSync(path.dirname(hostSettingsPath), { recursive: true });
  fs.writeFileSync(hostSettingsPath, JSON.stringify(filtered, null, 2) + "\n");
}
