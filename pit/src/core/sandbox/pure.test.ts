import { describe, it, expect } from "vitest";
import { formatSandboxNote, buildSandboxMountSpec, applyDenylist } from "./pure.ts";
import type { OverlayMount, SandboxMounts } from "../../types.ts";

describe("formatSandboxNote", () => {
  const ro  = (p: string, label?: string) => ({ path: p, label });
  const rw  = (p: string, label?: string) => ({ path: p, label });
  const ov  = (src: string, dest: string, label?: string): OverlayMount => ({ src, dest, label });

  it("includes the bwrap header", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")] })).toContain("**Sandbox (bwrap):**");
  });
  it("lists rw paths under Read-write", () => {
    const n = formatSandboxNote({ ro: [], rw: [rw("/work"), rw("/cfg", "Pi config dir")] });
    expect(n).toContain("`/work`");
    expect(n).toContain("`Pi config dir`");
  });
  it("lists ro paths under Read-only", () => {
    expect(formatSandboxNote({ ro: [ro("/usr", "system dirs"), ro("/etc", "system dirs")], rw: [] }))
      .toMatch(/Read-only:.*system dirs/);
  });
  it("uses literal path when no label", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/some/worktree")] })).toContain("`/some/worktree`");
  });
  it("deduplicates entries with the same label", () => {
    const n = formatSandboxNote({
      ro: [ro("/ext/a.ts", "Pi extensions"), ro("/ext/b.ts", "Pi extensions")],
      rw: [],
    });
    expect((n.match(/`Pi extensions`/g) ?? []).length).toBe(1);
  });
  it("Read-write appears before Read-only", () => {
    const n = formatSandboxNote({
      ro: [ro("/home", "home directory")],
      rw: [rw("/work"), rw("/cfg", "Pi config dir")],
    });
    expect(n.indexOf("Read-write")).toBeLessThan(n.indexOf("Read-only"));
  });
  it("includes the no-access footer", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")] })).toContain("No access:");
  });
  it("no overlay section when overlay absent", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")] })).not.toContain("Ephemeral overlay");
  });
  it("no overlay section when overlay is empty array", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")], overlay: [] })).not.toContain("Ephemeral overlay");
  });
  it("includes overlay section when mounts present", () => {
    const n = formatSandboxNote({
      ro: [], rw: [rw("/work")],
      overlay: [ov("/parent/node_modules", "/work/node_modules", "node_modules")],
    });
    expect(n).toContain("Ephemeral overlay");
    expect(n).toContain("`node_modules`");
  });
  it("overlay falls back to dest path when no label", () => {
    const n = formatSandboxNote({
      ro: [], rw: [rw("/work")],
      overlay: [ov("/parent/node_modules", "/work/node_modules")],
    });
    expect(n).toContain("`/work/node_modules`");
  });
  it("deduplicates overlay entries with same label", () => {
    const n = formatSandboxNote({
      ro: [], rw: [],
      overlay: [
        ov("/parent/a/node_modules", "/wt/a/node_modules", "node_modules"),
        ov("/parent/b/node_modules", "/wt/b/node_modules", "node_modules"),
      ],
    });
    expect((n.match(/`node_modules`/g) ?? []).length).toBe(1);
  });
});

describe("applyDenylist", () => {
  const settings = {
    defaultModel: "claude-sonnet",
    packages: [
      "npm:@casualjim/pi-heimdall",
      "npm:@spences10/pi-confirm-destructive",
      "npm:@jerryan/pi-sanity",
      "npm:pi-agent-browser-native",
    ],
  };
  it("removes denied packages", () => {
    expect(applyDenylist(settings, ["npm:@casualjim/pi-heimdall"]).packages)
      .not.toContain("npm:@casualjim/pi-heimdall");
  });
  it("keeps allowed packages", () => {
    expect(applyDenylist(settings, ["npm:@casualjim/pi-heimdall"]).packages)
      .toContain("npm:pi-agent-browser-native");
  });
  it("removes all denied in one pass", () => {
    const r = applyDenylist(settings, ["npm:@casualjim/pi-heimdall", "npm:@spences10/pi-confirm-destructive"]);
    expect(r.packages).toHaveLength(2);
  });
  it("empty denylist leaves settings unchanged", () => {
    expect(applyDenylist(settings, []).packages).toEqual(settings.packages);
  });
  it("missing denylist entry is silently ignored", () => {
    expect(applyDenylist(settings, ["npm:@nobody/does-not-exist"]).packages).toEqual(settings.packages);
  });
  it("missing packages key treated as empty array", () => {
    expect(applyDenylist({ defaultModel: "sonnet" }, ["npm:x"]).packages).toEqual([]);
  });
  it("does not mutate the original", () => {
    const original = [...settings.packages];
    applyDenylist(settings, ["npm:@casualjim/pi-heimdall"]);
    expect(settings.packages).toEqual(original);
  });
  it("preserves non-packages keys", () => {
    expect(applyDenylist(settings, ["npm:@casualjim/pi-heimdall"]).defaultModel).toBe("claude-sonnet");
  });
});

describe("buildSandboxMountSpec", () => {
  const base = {
    home: "/home/user",
    cwd: "/home/user/repo-wt-abc",
    agentDirReal: "/home/user/.pi/agent",
    extensionMounts: [] as string[],
    nodeDir: "/usr/local",
    gitRwMounts: [] as Array<{ path: string; label?: string }>,
    overlayDirs: [] as OverlayMount[],
  };
  it("ro includes home directory", () => {
    expect(buildSandboxMountSpec(base).ro.some((m) => m.label === "home directory")).toBe(true);
  });
  it("ro includes /usr and /etc as system dirs", () => {
    const paths = buildSandboxMountSpec(base).ro.filter((m) => m.label === "system dirs").map((m) => m.path);
    expect(paths).toContain("/usr");
    expect(paths).toContain("/etc");
  });
  it("rw includes cwd", () => {
    expect(buildSandboxMountSpec(base).rw.some((m) => m.path === base.cwd)).toBe(true);
  });
  it("rw includes agentDirReal as Pi config dir", () => {
    expect(buildSandboxMountSpec(base).rw.some((m) => m.label === "Pi config dir" && m.path === base.agentDirReal)).toBe(true);
  });
  it("extension mounts appear in ro as Pi extensions", () => {
    const mounts = buildSandboxMountSpec({ ...base, extensionMounts: ["/ext/foo.ts"] });
    expect(mounts.ro.filter((m) => m.label === "Pi extensions").map((m) => m.path)).toContain("/ext/foo.ts");
  });
  it("gitRwMounts appear at the start of rw", () => {
    const gitMounts = [
      { path: "/repo/.git/worktrees/wt", label: "worktree git metadata" },
      { path: "/repo/.git/objects", label: "git objects" },
    ];
    const mounts = buildSandboxMountSpec({ ...base, gitRwMounts: gitMounts });
    expect(mounts.rw[0].label).toBe("worktree git metadata");
    expect(mounts.rw[1].label).toBe("git objects");
  });
  it("overlayDirs appear in overlay field", () => {
    const overlayDirs: OverlayMount[] = [{ src: "/repo/nm", dest: "/wt/nm", label: "node_modules" }];
    const mounts = buildSandboxMountSpec({ ...base, overlayDirs });
    expect(mounts.overlay).toHaveLength(1);
    expect(mounts.overlay![0].label).toBe("node_modules");
  });
  it("empty overlayDirs produces empty overlay array", () => {
    expect(buildSandboxMountSpec(base).overlay).toEqual([]);
  });
  it("home drives npm/mise/nodeDir rw entries", () => {
    const m = buildSandboxMountSpec({ ...base, home: "/custom/home", nodeDir: "/custom/node" });
    const paths = m.rw.map((e) => e.path);
    expect(paths).toContain("/custom/home/.npm");
    expect(paths).toContain("/custom/home/.local/share/mise/shims");
    expect(paths).toContain("/custom/node/lib/node_modules");
    expect(paths).toContain("/custom/node/bin");
  });
});
