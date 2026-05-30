/**
 * Debug probe: verify --bind-try silences missing-path errors in bwrap.
 * Created to confirm the optional rw mount fix before trusting it in production.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const isMacos = process.platform === "darwin";
const bwrapPath = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"].find(p => fs.existsSync(p)) ?? null;
const nodeDir = path.dirname(path.dirname(process.execPath));

function bwrapWorks(): boolean {
  if (!bwrapPath) return false;
  const r = spawnSync(bwrapPath, [
    "--tmpfs", "/", "--dev", "/dev", "--proc", "/proc",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind", nodeDir, nodeDir,
    "--unshare-user", "--", process.execPath, "--eval", "process.exit(0)",
  ], { encoding: "utf8" });
  return r.status === 0;
}

const canRunBwrap = !isMacos && bwrapWorks();

// A path that is guaranteed NOT to exist (created fresh for this run).
const missingPath = path.join(os.tmpdir(), `pit-bind-try-probe-missing-${process.pid}`);

beforeAll(() => {
  // Ensure the path definitely does not exist.
  if (fs.existsSync(missingPath)) fs.rmSync(missingPath, { recursive: true, force: true });
});

function runWithBindFlag(flag: "--bind" | "--bind-try"): { status: number; stderr: string } {
  const r = spawnSync(bwrapPath!, [
    "--tmpfs", "/", "--dev", "/dev", "--proc", "/proc",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind", nodeDir, nodeDir,
    "--unshare-user",
    flag, missingPath, missingPath,
    "--", process.execPath, "--eval", "process.exit(0)",
  ], { encoding: "utf8" });
  return { status: r.status ?? 1, stderr: r.stderr ?? "" };
}

describe("bwrap --bind-try (optional rw mount fix)", () => {
  it.skipIf(!canRunBwrap)("--bind on a missing path fails with 'Can't find source path'", () => {
    const { status, stderr } = runWithBindFlag("--bind");
    expect(status, "hard --bind should fail").not.toBe(0);
    expect(stderr).toContain("Can't find source path");
  });

  it.skipIf(!canRunBwrap)("--bind-try on a missing path silently succeeds", () => {
    const { status, stderr } = runWithBindFlag("--bind-try");
    expect(stderr, "--bind-try must not print 'Can't find source path'").not.toContain("Can't find source path");
    expect(status, `--bind-try should exit 0: stderr=${stderr}`).toBe(0);
  });
});
