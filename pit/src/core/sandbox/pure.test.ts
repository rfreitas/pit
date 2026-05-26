import { describe, it, expect } from "vitest";
import { formatSandboxNote, buildSandboxMountSpec, applyDenylist } from "./pure.ts";
import type { OverlayMount, SandboxMounts } from "../../types.ts";

// ── formatSandboxNote ─────────────────────────────────────────────────────────
//
// Transforms a SandboxMount list into the sandbox section of the agent
// announcement. Key behaviour: label-based deduplication, ordering, and
// the optional flag being a bwrap concern only.

describe("formatSandboxNote", () => {
  const ro  = (p: string, label?: string) => ({ path: p, label });
  const rw  = (p: string, label?: string) => ({ path: p, label });
  const opt = (p: string, label?: string) => ({ path: p, label, optional: true as const });
  const ov  = (src: string, dest: string, label?: string): OverlayMount => ({ src, dest, label });

  it("includes the bwrap header line", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")] })).toContain("**Sandbox (bwrap):**");
  });
  it("lists rw paths under Read-write", () => {
    const n = formatSandboxNote({ ro: [], rw: [rw("/work"), rw("/cfg", "Pi config dir")] });
    expect(n).toContain("`/work`");
    expect(n).toContain("`Pi config dir`");
    expect(n).toMatch(/Read-write:.*\/work/);
  });
  it("lists ro paths under Read-only", () => {
    expect(formatSandboxNote({ ro: [ro("/usr", "system dirs"), ro("/etc", "system dirs")], rw: [] }))
      .toMatch(/Read-only:.*system dirs/);
  });
  it("uses the literal path as label when no label is provided", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/some/worktree")] })).toContain("`/some/worktree`");
  });
  it("deduplicates entries with the same label", () => {
    const n = formatSandboxNote({
      ro: [ro("/ext/foo.ts", "Pi extensions"), ro("/ext/bar.ts", "Pi extensions")],
      rw: [],
    });
    expect((n.match(/`Pi extensions`/g) ?? []).length).toBe(1);
  });
  it("Read-write section always appears before Read-only section", () => {
    const n = formatSandboxNote({
      ro: [ro("/home", "home directory"), ro("/usr", "system dirs")],
      rw: [rw("/work"), rw("/cfg", "Pi config dir")],
    });
    expect(n.indexOf("Read-write")).toBeLessThan(n.indexOf("Read-only"));
  });
  it("optional flag does not affect the label (it is a bwrap concern only)", () => {
    // { optional: true } controls whether bwrap uses --ro-bind-try instead
    // of --ro-bind. It must NOT change what the announcement shows the agent.
    const required = formatSandboxNote({ ro: [ro("/lib", "system dirs")],  rw: [] });
    const optional = formatSandboxNote({ ro: [opt("/lib", "system dirs")], rw: [] });
    expect(required).toBe(optional);
  });
  it("includes the no-access footer", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")] })).toContain("No access:");
  });
  it("no overlay section when overlay is absent", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")] })).not.toContain("Ephemeral overlay");
  });
  it("no overlay section when overlay is empty array", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")], overlay: [] })).not.toContain("Ephemeral overlay");
  });
  it("includes ephemeral overlay section when overlay mounts present", () => {
    const n = formatSandboxNote({
      ro: [], rw: [rw("/work")],
      overlay: [ov("/parent/node_modules", "/work/node_modules", "node_modules")],
    });
    expect(n).toContain("Ephemeral overlay");
    expect(n).toContain("`node_modules`");
  });
  it("overlay section falls back to dest path when no label", () => {
    const n = formatSandboxNote({
      ro: [], rw: [rw("/work")],
      overlay: [ov("/parent/node_modules", "/work/node_modules")],
    });
    expect(n).toContain("`/work/node_modules`");
  });
  it("overlay section lists multiple dirs", () => {
    const n = formatSandboxNote({
      ro: [], rw: [rw("/work")],
      overlay: [ov("/p/nm", "/w/nm", "node_modules"), ov("/p/dist", "/w/dist", "dist")],
    });
    expect(n).toContain("`node_modules`");
    expect(n).toContain("`dist`");
  });
  it("deduplicates overlay entries that share a label", () => {
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

// ── applyDenylist ─────────────────────────────────────────────────────────────
//
// Pure function: filters the packages array in a settings object by removing
// any entry present in the denylist. Must not mutate the input and must
// preserve all other settings keys untouched.

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
  it("removes all packages in the denylist in one pass", () => {
    const r = applyDenylist(settings, ["npm:@casualjim/pi-heimdall", "npm:@spences10/pi-confirm-destructive"]);
    expect(r.packages).toHaveLength(2);
    expect(r.packages).not.toContain("npm:@casualjim/pi-heimdall");
    expect(r.packages).not.toContain("npm:@spences10/pi-confirm-destructive");
  });
  it("empty denylist returns settings unchanged", () => {
    expect(applyDenylist(settings, []).packages).toEqual(settings.packages);
  });
  it("denylist entry not in packages is silently ignored", () => {
    expect(applyDenylist(settings, ["npm:@nobody/does-not-exist"]).packages).toEqual(settings.packages);
  });
  it("missing packages key is treated as empty array", () => {
    expect(applyDenylist({ defaultModel: "sonnet" }, ["npm:@casualjim/pi-heimdall"]).packages).toEqual([]);
  });
  it("does not mutate the original settings object", () => {
    const original = [...settings.packages];
    applyDenylist(settings, ["npm:@casualjim/pi-heimdall"]);
    expect(settings.packages).toEqual(original);
  });
  it("preserves all non-packages keys", () => {
    expect(applyDenylist(settings, ["npm:@casualjim/pi-heimdall"]).defaultModel).toBe("claude-sonnet");
  });
});

// ── buildSandboxMountSpec ─────────────────────────────────────────────────────
//
// Pure mount-list assembler. Callers resolve all IO and pass pre-computed arrays.

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
  it("ro section includes home dotfiles (selective mounts)", () => {
    expect(buildSandboxMountSpec(base).ro.some((m) => m.label === "home dotfiles")).toBe(true);
  });

  it("ro section does NOT include a wholesale home directory bind", () => {
    expect(buildSandboxMountSpec(base).ro.some((m) => m.label === "home directory")).toBe(false);
  });
  it("ro section includes /usr and /etc as system dirs", () => {
    const paths = buildSandboxMountSpec(base).ro.filter((m) => m.label === "system dirs").map((m) => m.path);
    expect(paths).toContain("/usr");
    expect(paths).toContain("/etc");
  });
  it("rw section includes the cwd", () => {
    expect(buildSandboxMountSpec(base).rw.some((m) => m.path === base.cwd)).toBe(true);
  });
  it("rw section includes the agentDirReal as Pi config dir", () => {
    expect(buildSandboxMountSpec(base).rw
      .some((m) => m.label === "Pi config dir" && m.path === base.agentDirReal)).toBe(true);
  });
  it("extension mounts appear in ro section labelled 'Pi extensions'", () => {
    const mounts = buildSandboxMountSpec({ ...base, extensionMounts: ["/ext/foo.ts", "/ext/bar.ts"] });
    const extPaths = mounts.ro.filter((m) => m.label === "Pi extensions").map((m) => m.path);
    expect(extPaths).toContain("/ext/foo.ts");
    expect(extPaths).toContain("/ext/bar.ts");
  });
  it("gitRwMounts appear at the start of the rw section", () => {
    const gitMounts = [
      { path: "/repo/.git/worktrees/wt", label: "worktree git metadata" },
      { path: "/repo/.git/objects", label: "git objects" },
    ];
    const mounts = buildSandboxMountSpec({ ...base, gitRwMounts: gitMounts });
    expect(mounts.rw[0].label).toBe("worktree git metadata");
    expect(mounts.rw[1].label).toBe("git objects");
  });
  it("overlayDirs appear in the overlay field", () => {
    const overlayDirs: OverlayMount[] = [{ src: "/repo/nm", dest: "/wt/nm", label: "node_modules" }];
    const mounts = buildSandboxMountSpec({ ...base, overlayDirs });
    expect(mounts.overlay).toHaveLength(1);
    expect(mounts.overlay![0].label).toBe("node_modules");
  });
  it("empty overlayDirs produces an empty overlay array", () => {
    expect(buildSandboxMountSpec(base).overlay).toEqual([]);
  });
  it("home path drives the npm + mise + nodeDir rw entries", () => {
    const mounts = buildSandboxMountSpec({ ...base, home: "/custom/home", nodeDir: "/custom/node" });
    const paths = mounts.rw.map((m) => m.path);
    expect(paths).toContain("/custom/home/.npm");
    expect(paths).toContain("/custom/home/.local/share/mise/shims");
    expect(paths).toContain("/custom/node/lib/node_modules");
    expect(paths).toContain("/custom/node/bin");
  });
});
