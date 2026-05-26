import { describe, it, expect } from "vitest";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { cwdToBucket, buildAnnouncement, buildSessionLines, systemPromptArgs } from "./pure.ts";
import { formatSandboxNote } from "../sandbox/pure.ts";
import type { WorktreeResult, SandboxMounts, PitMetadata } from "../../types.ts";

describe("cwdToBucket", () => {
  it("wraps with double dashes", () => {
    expect(cwdToBucket("/home/user/repo")).toMatch(/^--.*--$/);
  });
  it("strips leading slash so bucket doesn't start with ---", () => {
    expect(cwdToBucket("/home/user/repo")).toBe("--home-user-repo--");
  });
  it("handles WSL paths", () => {
    expect(cwdToBucket("/mnt/c/Users/ricfr/Repos/agent")).toBe("--mnt-c-Users-ricfr-Repos-agent--");
  });
  it("replaces backslashes", () => {
    expect(cwdToBucket("\\some\\windows\\path")).toBe("--some-windows-path--");
  });
  it("replaces colons", () => {
    expect(cwdToBucket("/mnt/c:/Users")).toBe("--mnt-c--Users--");
  });
});

describe("buildAnnouncement", () => {
  const worktreeMeta: PitMetadata = {
    id: "a1b2c3d4", repo: "/tmp/repo", worktree: "/tmp/repo-wt-a1b2c3d4",
    branch: "pi/a1b2c3d4", created: "2026-01-01T00:00:00.000Z", mode: "worktree",
  };
  const forcedMeta: PitMetadata = {
    id: "b2c3d4e5", repo: "/tmp/repo", worktree: "/tmp/repo",
    branch: "", created: "2026-01-01T00:00:00.000Z", mode: "no-tree", noTreeReason: "forced",
  };
  const noRepoMeta: PitMetadata = {
    id: "c3d4e5f6", repo: "/tmp/somedir", worktree: "/tmp/somedir",
    branch: "", created: "2026-01-01T00:00:00.000Z", mode: "no-tree", noTreeReason: "no-repo",
  };
  const mounts: SandboxMounts = {
    ro: [{ path: "/home/user", label: "home directory" }],
    rw: [{ path: "/tmp/repo-wt-a1b2c3d4" }, { path: "/home/user/.pi/agent", label: "Pi config dir" }],
  };

  it("worktree mode: contains header", () => {
    expect(buildAnnouncement(worktreeMeta)).toContain("**pit — worktree mode**");
  });
  it("worktree mode: contains branch", () => {
    expect(buildAnnouncement(worktreeMeta)).toContain("`pi/a1b2c3d4`");
  });
  it("worktree mode: explains isolation", () => {
    const t = buildAnnouncement(worktreeMeta);
    expect(t).toContain("not on the main branch");
    expect(t).toContain("The main working tree is untouched");
  });
  it("no-tree forced: contains skipped header", () => {
    expect(buildAnnouncement(forcedMeta)).toContain("worktree creation skipped");
  });
  it("no-tree no-repo: explains absent repo", () => {
    expect(buildAnnouncement(noRepoMeta)).toContain("Not inside a git repository");
  });
  it("no mounts: no sandbox section", () => {
    expect(buildAnnouncement(worktreeMeta)).not.toContain("Sandbox (bwrap)");
  });
  it("with mounts: includes sandbox section", () => {
    expect(buildAnnouncement(worktreeMeta, mounts)).toContain("Sandbox (bwrap)");
  });
  it("sandbox section is formatSandboxNote output", () => {
    const t = buildAnnouncement(worktreeMeta, mounts);
    expect(t).toContain(formatSandboxNote(mounts));
  });
  it("all modes include sandbox when mounts provided", () => {
    for (const meta of [worktreeMeta, forcedMeta, noRepoMeta])
      expect(buildAnnouncement(meta, mounts)).toContain("Sandbox (bwrap)");
  });
});

describe("buildSessionLines", () => {
  const result: WorktreeResult = {
    mode: "worktree", cwd: "/tmp/repo-wt-abc",
    meta: { id: "abc12345", repo: "/tmp/repo", worktree: "/tmp/repo-wt-abc",
            branch: "pi/abc12345", created: "2026-01-01T00:00:00.000Z", mode: "worktree" },
  };
  it("returns exactly 3 lines", () => {
    expect(buildSessionLines(result, "uuid-1", "2026-01-01T00:00:00.000Z").trim().split("\n")).toHaveLength(3);
  });
  it("line 1 is session header with supplied id and timestamp", () => {
    const [l1] = buildSessionLines(result, "my-uuid", "2026-06-01T12:00:00.000Z").split("\n");
    const h = JSON.parse(l1);
    expect(h.type).toBe("session");
    expect(h.id).toBe("my-uuid");
    expect(h.timestamp).toBe("2026-06-01T12:00:00.000Z");
    expect(h.version).toBe(CURRENT_SESSION_VERSION);
  });
  it("line 2 is pit CustomEntry", () => {
    const [, l2] = buildSessionLines(result, "uuid", "ts").split("\n");
    const e = JSON.parse(l2);
    expect(e.type).toBe("custom");
    expect(e.customType).toBe("pit");
    expect(e.data.id).toBe(result.meta.id);
  });
  it("line 3 is custom_message chained to line 2", () => {
    const [, l2, l3] = buildSessionLines(result, "uuid", "ts").split("\n");
    const msg = JSON.parse(l3);
    expect(msg.type).toBe("custom_message");
    expect(msg.display).toBe(true);
    expect(msg.parentId).toBe(JSON.parse(l2).id);
  });
  it("two calls produce different id values", () => {
    const a = JSON.parse(buildSessionLines(result, "u", "t").split("\n")[1]).id;
    const b = JSON.parse(buildSessionLines(result, "u", "t").split("\n")[1]).id;
    expect(a).not.toBe(b);
  });
});

describe("systemPromptArgs", () => {
  const meta: PitMetadata = {
    id: "abc", repo: "/repo", worktree: "/repo-wt-abc",
    branch: "pi/abc", created: "2026-01-01T00:00:00.000Z", mode: "worktree",
  };
  it("returns two elements", () => { expect(systemPromptArgs(meta, undefined)).toHaveLength(2); });
  it("first element is --append-system-prompt", () => {
    expect(systemPromptArgs(meta, undefined)[0]).toBe("--append-system-prompt");
  });
  it("second element is buildAnnouncement output", () => {
    expect(systemPromptArgs(meta, undefined)[1]).toBe(buildAnnouncement(meta, undefined));
  });
  it("includes sandbox section when mounts provided", () => {
    const mounts: SandboxMounts = { ro: [{ path: "/home" }], rw: [{ path: "/work" }] };
    expect(systemPromptArgs(meta, mounts)[1]).toContain("Sandbox (bwrap)");
  });
});
