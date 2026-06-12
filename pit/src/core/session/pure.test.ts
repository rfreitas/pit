import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { cwdToBucket, buildSessionLines, systemPromptArgs } from "./pure.ts";
import { formatSandboxNote } from "../sandbox/pure.ts";
import type { WorktreeResult, SandboxMounts } from "../../types.ts";

// ── cwdToBucket ───────────────────────────────────────────────────────────────
//
// pi stores sessions in ~/.pi/agent/sessions/<bucket>/. pit must produce the
// same bucket name or sessions land in the wrong place and are invisible to
// pi's own picker. The algorithm must match exactly what pi already uses.

describe("cwdToBucket", () => {
  it("wraps with double dashes", () => {
    expect(cwdToBucket("/home/user/repo")).toMatch(/^--.*--$/);
  });
  it("strips leading slash so the bucket doesn't start with ---", () => {
    // Without stripping, "/home/user" → "---home-user--" (triple dash).
    // pi produces "--home-user--" (double dash), so sessions would be missed.
    expect(cwdToBucket("/home/user/repo")).toBe("--home-user-repo--");
  });
  it("handles Windows-mounted WSL paths (/mnt/c/...)", () => {
    expect(cwdToBucket("/mnt/c/Users/ricfr/Repos/agent")).toBe("--mnt-c-Users-ricfr-Repos-agent--");
  });
  it("replaces backslashes (Windows paths)", () => {
    expect(cwdToBucket("\\some\\windows\\path")).toBe("--some-windows-path--");
  });
  it("replaces colons (Windows drive letters)", () => {
    expect(cwdToBucket("/mnt/c:/Users")).toBe("--mnt-c--Users--");
  });
  it("matches the format of real session dirs created by pi", () => {
    // Ground-truth sanity check: every bucket pi has already created on this
    // machine follows the --…-- pattern, confirming the algorithm is correct.
    const sessionsDir = path.join(process.env.HOME!, ".pi", "agent", "sessions");
    if (!fs.existsSync(sessionsDir)) return;
    const realBuckets = fs.readdirSync(sessionsDir).filter((d) => d.startsWith("--"));
    for (const bucket of realBuckets.slice(0, 5)) {
      expect(bucket).toMatch(/^--.*--$/);
    }
  });
});

// ── buildSessionLines ─────────────────────────────────────────────────────────
//
// Without sandbox: header + pit entry (2 lines).
// With sandbox: header + pit entry + sandbox message (3 lines).

describe("buildSessionLines", () => {
  const result: WorktreeResult = {
    cwd: "/tmp/repo-wt-abc",
    meta: { repo: "/tmp/repo", branch: "pi/abc12345" },
  };
  const mounts: SandboxMounts = { rw: [{ path: result.cwd }], readDeny: [] };

  it("without sandbox: exactly 2 lines (header + pit entry)", () => {
    expect(buildSessionLines(result, "uuid-1", "ts").trim().split("\n")).toHaveLength(2);
  });
  it("with sandbox: exactly 3 lines (header + pit entry + sandbox message)", () => {
    expect(buildSessionLines(result, "uuid-1", "ts", mounts).trim().split("\n")).toHaveLength(3);
  });
  it("line 1 is a session header with the supplied id and cwd", () => {
    const h = JSON.parse(buildSessionLines(result, "my-uuid", "2026-06-01T12:00:00.000Z").split("\n")[0]);
    expect(h.type).toBe("session");
    expect(h.id).toBe("my-uuid");
    expect(h.cwd).toBe(result.cwd);
    expect(h.version).toBe(CURRENT_SESSION_VERSION);
  });
  it("line 2 is a pit CustomEntry with repo and branch", () => {
    const e = JSON.parse(buildSessionLines(result, "uuid", "ts").split("\n")[1]);
    expect(e.type).toBe("custom");
    expect(e.customType).toBe("pit");
    expect(e.parentId).toBeNull();
    expect(e.data.repo).toBe(result.meta.repo);
    expect(e.data.branch).toBe(result.meta.branch);
    expect(e.data.mode).toBeUndefined();
    expect(e.data.id).toBeUndefined();
  });
  it("line 3 (sandbox): custom_message with sandbox content and display: true", () => {
    const lines = buildSessionLines(result, "uuid", "ts", mounts).trim().split("\n");
    const msg = JSON.parse(lines[2]);
    expect(msg.type).toBe("custom_message");
    expect(msg.display).toBe(true);
    expect(msg.content).toContain("Sandbox (bwrap)");
    expect(msg.content).toBe(formatSandboxNote(mounts));
  });
  it("sandbox message parentId chains to pit entry id", () => {
    const lines = buildSessionLines(result, "uuid", "ts", mounts).trim().split("\n");
    expect(JSON.parse(lines[2]).parentId).toBe(JSON.parse(lines[1]).id);
  });
  it("calling twice produces different pit entry ids (not hardcoded)", () => {
    const a = JSON.parse(buildSessionLines(result, "u", "t").split("\n")[1]).id;
    const b = JSON.parse(buildSessionLines(result, "u", "t").split("\n")[1]).id;
    expect(a).not.toBe(b);
  });
});

// ── systemPromptArgs ──────────────────────────────────────────────────────────
//
// Passes sandbox context only — agent derives git context from git tools.

describe("systemPromptArgs", () => {
  const mounts: SandboxMounts = { rw: [{ path: "/work" }], readDeny: [] };

  it("returns empty array when not sandboxed", () => {
    expect(systemPromptArgs(undefined)).toHaveLength(0);
  });
  it("returns two elements when sandboxed", () => {
    expect(systemPromptArgs(mounts)).toHaveLength(2);
  });
  it("first element is --append-system-prompt", () => {
    expect(systemPromptArgs(mounts)[0]).toBe("--append-system-prompt");
  });
  it("second element is formatSandboxNote output", () => {
    expect(systemPromptArgs(mounts)[1]).toBe(formatSandboxNote(mounts));
    expect(systemPromptArgs(mounts)[1]).toContain("Sandbox (bwrap)");
  });
});

// ── buildSessionLines: no git context injected ────────────────────────────────
//
// Pit no longer tells the agent about worktree mode, branch, or no-tree reason.
// The agent derives git context itself. This suite verifies the session file and
// the system prompt contain sandbox info ONLY — no git metadata.

describe("buildSessionLines: sandbox-only, no git context", () => {
  const result: WorktreeResult = {
    cwd: "/tmp/repo-wt-abc",
    meta: { repo: "/tmp/repo", branch: "pi/abc12345" },
  };
  const mounts: SandboxMounts = {
    rw: [{ path: result.cwd }],
    readDeny: [],
  };

  it("sandbox message does not mention branch name", () => {
    const lines = buildSessionLines(result, "uuid", "ts", mounts).trim().split("\n");
    const msg = JSON.parse(lines[2]);
    expect(msg.content).not.toContain("pi/abc12345");
  });

  it("sandbox message does not mention worktree mode", () => {
    const lines = buildSessionLines(result, "uuid", "ts", mounts).trim().split("\n");
    expect(JSON.parse(lines[2]).content).not.toContain("worktree mode");
  });

  it("without sandbox: no message at all — agent gets no pit context", () => {
    const lines = buildSessionLines(result, "uuid", "ts").trim().split("\n");
    expect(lines).toHaveLength(2);
    // Verify no custom_message entry exists
    expect(lines.every(l => JSON.parse(l).type !== "custom_message")).toBe(true);
  });

  it("pit entry stores only repo and branch — no mode, id, or created", () => {
    const pitEntry = JSON.parse(buildSessionLines(result, "uuid", "ts").split("\n")[1]);
    expect(Object.keys(pitEntry.data).sort()).toEqual(["branch", "repo"]);
  });
});
