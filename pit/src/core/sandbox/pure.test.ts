import { describe, it, expect } from "vitest";
import { formatSandboxNote, buildSandboxMountSpec, applyDenylist } from "./pure.ts";
import type { OverlayMount, SandboxMounts } from "../../types.ts";

// ── formatSandboxNote ─────────────────────────────────────────────────────────

describe("formatSandboxNote", () => {
  const ro  = (p: string, label?: string) => ({ path: p, label });
  const rw  = (p: string, label?: string) => ({ path: p, label });
  const opt = (p: string, label?: string) => ({ path: p, label, optional: true as const });
  const ov  = (src: string, dest: string, label?: string): OverlayMount => ({ src, dest, label });

  // ── whitelist mode (bwrap / Linux) ────────────────────────────────────────

  it("whitelist: includes the bwrap header line", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")] })).toContain("**Sandbox (bwrap):**");
  });
  it("whitelist: backend field controls header name", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")], backend: "bwrap" }))
      .toContain("**Sandbox (bwrap):**");
  });
  it("whitelist: lists rw paths under Read-write", () => {
    const n = formatSandboxNote({ ro: [], rw: [rw("/work"), rw("/cfg", "Pi config dir")] });
    expect(n).toContain("`/work`");
    expect(n).toContain("`Pi config dir`");
    expect(n).toMatch(/Read-write:.*\/work/);
  });
  it("whitelist: lists ro paths under Read-only", () => {
    expect(formatSandboxNote({ ro: [ro("/usr", "system dirs"), ro("/etc", "system dirs")], rw: [] }))
      .toMatch(/Read-only:.*system dirs/);
  });
  it("whitelist: uses the literal path as label when no label is provided", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/some/worktree")] })).toContain("`/some/worktree`");
  });
  it("whitelist: deduplicates entries with the same label", () => {
    const n = formatSandboxNote({
      ro: [ro("/ext/foo.ts", "Pi extensions"), ro("/ext/bar.ts", "Pi extensions")],
      rw: [],
    });
    expect((n.match(/`Pi extensions`/g) ?? []).length).toBe(1);
  });
  it("whitelist: Read-write section always appears before Read-only section", () => {
    const n = formatSandboxNote({
      ro: [ro("/home", "home directory"), ro("/usr", "system dirs")],
      rw: [rw("/work"), rw("/cfg", "Pi config dir")],
    });
    expect(n.indexOf("Read-write")).toBeLessThan(n.indexOf("Read-only"));
  });
  it("whitelist: optional flag does not affect the label", () => {
    const required = formatSandboxNote({ ro: [ro("/lib", "system dirs")],  rw: [] });
    const optional = formatSandboxNote({ ro: [opt("/lib", "system dirs")], rw: [] });
    expect(required).toBe(optional);
  });
  it("whitelist: includes the no-access footer", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")] })).toContain("No access:");
  });
  it("whitelist: no overlay section when overlay is absent", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")] })).not.toContain("Ephemeral overlay");
  });
  it("whitelist: no overlay section when overlay is empty array", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")], overlay: [] })).not.toContain("Ephemeral overlay");
  });
  it("whitelist: includes ephemeral overlay section when overlay mounts present", () => {
    const n = formatSandboxNote({
      ro: [], rw: [rw("/work")],
      overlay: [ov("/parent/node_modules", "/work/node_modules", "node_modules")],
    });
    expect(n).toContain("Ephemeral overlay");
    expect(n).toContain("`node_modules`");
  });
  it("whitelist: overlay section falls back to dest path when no label", () => {
    const n = formatSandboxNote({
      ro: [], rw: [rw("/work")],
      overlay: [ov("/parent/node_modules", "/work/node_modules")],
    });
    expect(n).toContain("`/work/node_modules`");
  });
  it("whitelist: deduplicates overlay entries that share a label", () => {
    const n = formatSandboxNote({
      ro: [], rw: [],
      overlay: [
        ov("/parent/a/node_modules", "/wt/a/node_modules", "node_modules"),
        ov("/parent/b/node_modules", "/wt/b/node_modules", "node_modules"),
      ],
    });
    expect((n.match(/`node_modules`/g) ?? []).length).toBe(1);
  });

  // ── blacklist mode (sandbox-exec / macOS) ─────────────────────────────────

  it("blacklist: uses sandbox-exec header", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")], readDeny: [], backend: "sandbox-exec" }))
      .toContain("**Sandbox (sandbox-exec):**");
  });
  it("blacklist: lists rw paths under Read-write", () => {
    const n = formatSandboxNote({ ro: [], rw: [rw("/work")], readDeny: [], backend: "sandbox-exec" });
    expect(n).toContain("`/work`");
    expect(n).toMatch(/Read-write:.*\/work/);
  });
  it("blacklist: no Read-only section", () => {
    const n = formatSandboxNote({ ro: [ro("/usr")], rw: [], readDeny: [], backend: "sandbox-exec" });
    expect(n).not.toContain("Read-only:");
  });
  it("blacklist: with empty readDeny shows reads unrestricted", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")], readDeny: [], backend: "sandbox-exec" }))
      .toContain("Reads unrestricted");
  });
  it("blacklist: lists denied paths in reads section", () => {
    const n = formatSandboxNote({
      ro: [], rw: [rw("/work")],
      readDeny: [{ path: "/home/user/.ssh", label: "~/.ssh" }, { path: "/home/user/.aws", label: "~/.aws" }],
      backend: "sandbox-exec",
    });
    expect(n).toContain("`~/.ssh`");
    expect(n).toContain("`~/.aws`");
    expect(n).toContain("Reads unrestricted except:");
  });
  it("blacklist: footer says no write access", () => {
    expect(formatSandboxNote({ ro: [], rw: [rw("/work")], readDeny: [], backend: "sandbox-exec" }))
      .toContain("No write access:");
  });
  it("blacklist: no Ephemeral overlay section (macOS feature gap)", () => {
    expect(formatSandboxNote({ ro: [], rw: [], readDeny: [], backend: "sandbox-exec" }))
      .not.toContain("Ephemeral overlay");
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
    agentDir: "agent", agentDirReal: "/home/user/.pi/agent",
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

// ── buildSandboxMountSpec (darwin) ────────────────────────────────────────────

describe("buildSandboxMountSpec (darwin)", () => {
  const base = {
    home: "/Users/user",
    cwd: "/Users/user/repo-wt-abc",
    agentDir: "agent", agentDirReal: "/Users/user/.pi/agent",
    extensionMounts: [] as string[],
    nodeDir: "/usr/local",
    gitRwMounts: [] as Array<{ path: string; label?: string }>,
    overlayDirs: [] as OverlayMount[],
    platform: "darwin" as const,
  };

  it("backend is sandbox-exec", () => {
    expect(buildSandboxMountSpec(base).backend).toBe("sandbox-exec");
  });

  it("readDeny is populated (blacklist mode)", () => {
    expect(buildSandboxMountSpec(base).readDeny).toBeDefined();
    expect(buildSandboxMountSpec(base).readDeny!.length).toBeGreaterThan(0);
  });

  it("readDeny includes ~/.ssh", () => {
    const deny = buildSandboxMountSpec(base).readDeny!;
    expect(deny.some((m) => m.path === "/Users/user/.ssh")).toBe(true);
  });

  it("readDeny includes ~/.aws", () => {
    const deny = buildSandboxMountSpec(base).readDeny!;
    expect(deny.some((m) => m.path === "/Users/user/.aws")).toBe(true);
  });

  it("overlay is absent (no overlayfs on macOS)", () => {
    expect(buildSandboxMountSpec(base).overlay).toBeUndefined();
  });

  it("rw section contains cwd and agentDirReal", () => {
    const mounts = buildSandboxMountSpec(base);
    expect(mounts.rw.some((m) => m.path === base.cwd)).toBe(true);
    expect(mounts.rw.some((m) => m.path === base.agentDirReal)).toBe(true);
  });

  it("pitConfig.sandbox.allowRead removes path from readDeny", () => {
    const mounts = buildSandboxMountSpec({
      ...base,
      pitConfig: { sandbox: { allowRead: ["/Users/user/.ssh"] } },
    });
    expect(mounts.readDeny!.some((m) => m.path === "/Users/user/.ssh")).toBe(false);
  });

  it("pitConfig.sandbox.denyRead adds extra paths to readDeny", () => {
    const mounts = buildSandboxMountSpec({
      ...base,
      pitConfig: { sandbox: { denyRead: ["/Users/user/.vault"] } },
    });
    expect(mounts.readDeny!.some((m) => m.path === "/Users/user/.vault")).toBe(true);
  });

  it("pitConfig.sandbox.allowWrite adds paths to rw", () => {
    const mounts = buildSandboxMountSpec({
      ...base,
      pitConfig: { sandbox: { allowWrite: ["/Users/user/extra"] } },
    });
    expect(mounts.rw.some((m) => m.path === "/Users/user/extra")).toBe(true);
  });

  it("linux platform produces no readDeny (whitelist model)", () => {
    const mounts = buildSandboxMountSpec({ ...base, platform: "linux" as const });
    expect(mounts.readDeny).toBeUndefined();
    expect(mounts.backend).toBe("bwrap");
  });
});
