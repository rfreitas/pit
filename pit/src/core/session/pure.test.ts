import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { cwdToBucket, buildAnnouncement, buildSessionLines, systemPromptArgs } from "./pure.ts";
import { formatSandboxNote } from "../sandbox/pure.ts";
import type { WorktreeResult, SandboxMounts, PitMetadata } from "../../types.ts";

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

// ── buildAnnouncement ─────────────────────────────────────────────────────────
//
// Pure function that composes the full agent announcement from PitMetadata
// and an optional mount list. Covers all three mode variants.

describe("buildAnnouncement", () => {
  const worktreeMeta: PitMetadata = {
    id: "a1b2c3d4", repo: "/tmp/repo",
    branch: "pi/a1b2c3d4", created: "2026-01-01T00:00:00.000Z", mode: "worktree",
  };
  const forcedMeta: PitMetadata = {
    id: "b2c3d4e5", repo: "/tmp/repo",
    branch: "", created: "2026-01-01T00:00:00.000Z", mode: "no-tree", noTreeReason: "forced",
  };
  const noRepoMeta: PitMetadata = {
    id: "c3d4e5f6", repo: "/tmp/somedir",
    branch: "", created: "2026-01-01T00:00:00.000Z", mode: "no-tree", noTreeReason: "no-repo",
  };
  const worktreeCwd = "/tmp/repo-wt-a1b2c3d4";
  const mounts: SandboxMounts = {
    ro: [{ path: "/home/user", label: "home directory" }],
    rw: [{ path: worktreeCwd }, { path: "/home/user/.pi/agent", label: "Pi config dir" }],
  };

  it("worktree mode: contains the pit worktree mode header", () => {
    expect(buildAnnouncement(worktreeMeta, worktreeCwd)).toContain("**pit — worktree mode**");
  });
  it("worktree mode: contains the branch name", () => {
    expect(buildAnnouncement(worktreeMeta, worktreeCwd)).toContain("`pi/a1b2c3d4`");
  });
  it("worktree mode: contains the worktree path", () => {
    expect(buildAnnouncement(worktreeMeta, worktreeCwd)).toContain("`/tmp/repo-wt-a1b2c3d4`");
  });
  it("worktree mode: explains branch isolation to the agent", () => {
    const t = buildAnnouncement(worktreeMeta, worktreeCwd);
    expect(t).toContain("not on the main branch");
    expect(t).toContain("The main working tree is untouched");
  });
  it("no-tree forced: contains the no-tree skipped header", () => {
    expect(buildAnnouncement(forcedMeta, "/tmp/repo")).toContain("worktree creation skipped");
  });
  it("no-tree forced: explains -nt flag", () => {
    expect(buildAnnouncement(forcedMeta, "/tmp/repo")).toContain("-nt");
  });
  it("no-tree forced: warns about missing git isolation", () => {
    expect(buildAnnouncement(forcedMeta, "/tmp/repo")).toContain("No git isolation");
  });
  it("no-tree no-repo: contains the no-tree header", () => {
    expect(buildAnnouncement(noRepoMeta, "/tmp/somedir")).toContain("**pit — no-tree mode**");
  });
  it("no-tree no-repo: explains the absence of a git repository", () => {
    expect(buildAnnouncement(noRepoMeta, "/tmp/somedir")).toContain("Not inside a git repository");
  });
  it("no-tree no-repo: warns about missing git isolation", () => {
    expect(buildAnnouncement(noRepoMeta, "/tmp/somedir")).toContain("No git isolation");
  });
  it("no sandbox mounts: announcement contains no sandbox section", () => {
    expect(buildAnnouncement(worktreeMeta, worktreeCwd)).not.toContain("Sandbox (bwrap)");
  });
  it("with sandbox mounts: announcement contains the sandbox section", () => {
    expect(buildAnnouncement(worktreeMeta, worktreeCwd, mounts)).toContain("Sandbox (bwrap)");
  });
  it("sandbox section appears after the mode content", () => {
    const t = buildAnnouncement(worktreeMeta, worktreeCwd, mounts);
    expect(t.indexOf("Sandbox (bwrap)")).toBeGreaterThan(t.indexOf("worktree mode"));
  });
  it("sandbox section is identical to formatSandboxNote output", () => {
    expect(buildAnnouncement(worktreeMeta, worktreeCwd, mounts)).toContain(formatSandboxNote(mounts));
  });
  it("all three modes include the sandbox section when mounts are provided", () => {
    expect(buildAnnouncement(worktreeMeta, worktreeCwd, mounts)).toContain("Sandbox (bwrap)");
    expect(buildAnnouncement(forcedMeta, "/tmp/repo", mounts)).toContain("Sandbox (bwrap)");
    expect(buildAnnouncement(noRepoMeta, "/tmp/somedir", mounts)).toContain("Sandbox (bwrap)");
  });
  it("all three modes omit the sandbox section when mounts are absent", () => {
    expect(buildAnnouncement(worktreeMeta, worktreeCwd)).not.toContain("Sandbox (bwrap)");
    expect(buildAnnouncement(forcedMeta, "/tmp/repo")).not.toContain("Sandbox (bwrap)");
    expect(buildAnnouncement(noRepoMeta, "/tmp/somedir")).not.toContain("Sandbox (bwrap)");
  });
});

// ── buildSessionLines ─────────────────────────────────────────────────────────
//
// Pure content builder for session JSONL files. setupNewSession calls this
// after generating sessionId + isoTs at the IO boundary.

describe("buildSessionLines", () => {
  const result: WorktreeResult = {
    mode: "worktree", cwd: "/tmp/repo-wt-abc",
    meta: { id: "abc12345", repo: "/tmp/repo",
            branch: "pi/abc12345", created: "2026-01-01T00:00:00.000Z", mode: "worktree" },
  };

  it("returns exactly 3 newline-terminated lines", () => {
    expect(buildSessionLines(result, "uuid-1", "2026-01-01T00:00:00.000Z").trim().split("\n")).toHaveLength(3);
  });
  it("line 1 is a session header with the supplied id and timestamp", () => {
    const [l1] = buildSessionLines(result, "my-uuid", "2026-06-01T12:00:00.000Z").split("\n");
    const h = JSON.parse(l1);
    expect(h.type).toBe("session");
    expect(h.id).toBe("my-uuid");
    expect(h.timestamp).toBe("2026-06-01T12:00:00.000Z");
    expect(h.cwd).toBe(result.cwd);
    expect(h.version).toBe(CURRENT_SESSION_VERSION);
  });
  it("line 2 is a pit CustomEntry with the worktree metadata", () => {
    const [, l2] = buildSessionLines(result, "uuid", "ts").split("\n");
    const e = JSON.parse(l2);
    expect(e.type).toBe("custom");
    expect(e.customType).toBe("pit");
    expect(e.parentId).toBeNull();
    expect(e.data.id).toBe(result.meta.id);
    expect(e.data.branch).toBe(result.meta.branch);
  });
  it("line 3 is a custom_message with display:true that chains to line 2", () => {
    const [, l2, l3] = buildSessionLines(result, "uuid", "ts").split("\n");
    const msg = JSON.parse(l3);
    expect(msg.type).toBe("custom_message");
    expect(msg.display).toBe(true);
    expect(msg.parentId).toBe(JSON.parse(l2).id);
  });
  it("sandbox section appears in line 3 content when mounts provided", () => {
    const mounts: SandboxMounts = { ro: [{ path: "/home", label: "home directory" }], rw: [{ path: result.cwd }] };
    expect(JSON.parse(buildSessionLines(result, "uuid", "ts", mounts).split("\n")[2]).content)
      .toContain("Sandbox (bwrap)");
  });
  it("sandbox section absent when no mounts provided", () => {
    expect(JSON.parse(buildSessionLines(result, "uuid", "ts").split("\n")[2]).content)
      .not.toContain("Sandbox (bwrap)");
  });
  it("calling twice produces different id1/id2 values (not hardcoded)", () => {
    // id1/id2 are random 4-byte hex values; collision probability is negligible.
    const a = JSON.parse(buildSessionLines(result, "u", "t").split("\n")[1]).id;
    const b = JSON.parse(buildSessionLines(result, "u", "t").split("\n")[1]).id;
    expect(a).not.toBe(b);
  });
});

// ── systemPromptArgs ──────────────────────────────────────────────────────────
//
// Thin wrapper that packages the announcement into --append-system-prompt args.

describe("systemPromptArgs", () => {
  const meta: PitMetadata = {
    id: "abc", repo: "/repo",
    branch: "pi/abc", created: "2026-01-01T00:00:00.000Z", mode: "worktree",
  };
  const cwd = "/repo-wt-abc";
  it("returns a two-element array", () => {
    expect(systemPromptArgs(meta, cwd, undefined)).toHaveLength(2);
  });
  it("first element is --append-system-prompt", () => {
    expect(systemPromptArgs(meta, cwd, undefined)[0]).toBe("--append-system-prompt");
  });
  it("second element is the buildAnnouncement output", () => {
    expect(systemPromptArgs(meta, cwd, undefined)[1]).toBe(buildAnnouncement(meta, cwd, undefined));
  });
  it("sandbox section is included when mounts are provided", () => {
    const mounts: SandboxMounts = { ro: [{ path: "/home" }], rw: [{ path: "/work" }] };
    expect(systemPromptArgs(meta, cwd, mounts)[1]).toContain("Sandbox (bwrap)");
  });
});
