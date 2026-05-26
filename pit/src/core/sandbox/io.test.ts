import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { resolveUnversionedDirs, readPitConfig, writeFilteredSettings } from "./io.ts";

const TEST_SANDBOX = path.join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test-sandbox");
fs.mkdirSync(TEST_SANDBOX, { recursive: true });

const run = <A>(eff: Effect.Effect<A, unknown, NodeContext.NodeContext>) =>
  Effect.runPromise(eff.pipe(Effect.provide(NodeContext.layer)));

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});
const makeTmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
const makeSandboxDir = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(TEST_SANDBOX, prefix));
  tmpDirs.push(d);
  return d;
};
const makeGitRepo = () => {
  const repo = makeTmp("pit-unversioned-test-");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@pit.test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "pit test"], { stdio: "ignore" });
  fs.writeFileSync(path.join(repo, ".gitkeep"), "");
  execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "init"], { stdio: "ignore" });
  return repo;
};

describe("resolveUnversionedDirs", () => {
  it("returns empty array for a non-git dir", async () => {
    expect(await run(resolveUnversionedDirs(makeTmp("pit-nongit-")))).toEqual([]);
  });
  it("returns empty array for non-existent path", async () => {
    expect(await run(resolveUnversionedDirs("/nonexistent/pit-test-unversioned"))).toEqual([]);
  });
  it("returns empty when no untracked or ignored dirs", async () => {
    expect(await run(resolveUnversionedDirs(makeGitRepo()))).toEqual([]);
  });
  it("returns directories only — not untracked files", async () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, "file.txt"), "hello");
    fs.mkdirSync(path.join(repo, "untracked-dir"));
    const r = await run(resolveUnversionedDirs(repo));
    expect(r).toContain("untracked-dir");
    expect(r).not.toContain("file.txt");
  });
  it("returns an untracked directory", async () => {
    const repo = makeGitRepo();
    fs.mkdirSync(path.join(repo, "new-dir"));
    expect(await run(resolveUnversionedDirs(repo))).toContain("new-dir");
  });
  it("returns an ignored directory", async () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    fs.mkdirSync(path.join(repo, "node_modules"));
    expect(await run(resolveUnversionedDirs(repo))).toContain("node_modules");
  });
  it("does not return tracked directories", async () => {
    const repo = makeGitRepo();
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "index.ts"), "");
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-m", "add src"], { stdio: "ignore" });
    expect(await run(resolveUnversionedDirs(repo))).not.toContain("src");
  });
  it("strips trailing slashes", async () => {
    const repo = makeGitRepo();
    fs.mkdirSync(path.join(repo, "some-dir"));
    const r = await run(resolveUnversionedDirs(repo));
    expect(r.every((e) => !e.endsWith("/"))).toBe(true);
  });
  it("deduplicates", async () => {
    const repo = makeGitRepo();
    fs.mkdirSync(path.join(repo, "build"));
    const r = await run(resolveUnversionedDirs(repo));
    expect(r.filter((e) => e === "build").length).toBe(1);
  });
  it("finds nested unversioned dirs inside tracked dirs", async () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    fs.mkdirSync(path.join(repo, "packages", "foo"), { recursive: true });
    fs.writeFileSync(path.join(repo, "packages", "foo", "package.json"), "{}");
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-m", "add packages"], { stdio: "ignore" });
    fs.mkdirSync(path.join(repo, "packages", "foo", "node_modules"));
    const r = await run(resolveUnversionedDirs(repo));
    expect(r).toContain("packages/foo/node_modules");
    expect(r).not.toContain("packages");
  });
});

describe("readPitConfig", () => {
  it("returns empty object when config.json absent", async () => {
    expect(await run(readPitConfig(makeSandboxDir("pit-config-test-")))).toEqual({});
  });
  it("parses denyPackages", async () => {
    const d = makeSandboxDir("pit-config-test-");
    fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ denyPackages: ["npm:@x/pkg"] }));
    expect((await run(readPitConfig(d))).denyPackages).toEqual(["npm:@x/pkg"]);
  });
  it("returns empty object for malformed JSON", async () => {
    const d = makeSandboxDir("pit-config-test-");
    fs.writeFileSync(path.join(d, "config.json"), "{ invalid }");
    expect(await run(readPitConfig(d))).toEqual({});
  });
});

describe("writeFilteredSettings", () => {
  const rawSettings = {
    defaultModel: "claude-sonnet",
    packages: ["npm:@casualjim/pi-heimdall", "npm:pi-agent-browser-native"],
  };
  it("writes a file at the given path", async () => {
    const agentDir = makeSandboxDir("pit-settings-agent-");
    const outDir = makeSandboxDir("pit-settings-out-");
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "settings.json");
    await run(writeFilteredSettings(agentDir, {}, outPath));
    expect(fs.existsSync(outPath)).toBe(true);
  });
  it("output is valid JSON", async () => {
    const agentDir = makeSandboxDir("pit-settings-agent-");
    const outDir = makeSandboxDir("pit-settings-out-");
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "settings.json");
    await run(writeFilteredSettings(agentDir, {}, outPath));
    expect(() => JSON.parse(fs.readFileSync(outPath, "utf8"))).not.toThrow();
  });
  it("removes denied packages", async () => {
    const agentDir = makeSandboxDir("pit-settings-agent-");
    const outDir = makeSandboxDir("pit-settings-out-");
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "settings.json");
    await run(writeFilteredSettings(agentDir, { denyPackages: ["npm:@casualjim/pi-heimdall"] }, outPath));
    const r = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(r.packages).not.toContain("npm:@casualjim/pi-heimdall");
    expect(r.packages).toContain("npm:pi-agent-browser-native");
  });
  it("creates parent directories if needed", async () => {
    const agentDir = makeSandboxDir("pit-settings-agent-");
    const outDir = makeSandboxDir("pit-settings-out-");
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(rawSettings));
    const outPath = path.join(outDir, "nested", "deep", "settings.json");
    await run(writeFilteredSettings(agentDir, {}, outPath));
    expect(fs.existsSync(outPath)).toBe(true);
  });
  it("absent settings.json produces empty object", async () => {
    const agentDir = makeSandboxDir("pit-settings-agent-");
    const outDir = makeSandboxDir("pit-settings-out-");
    const outPath = path.join(outDir, "settings.json");
    await run(writeFilteredSettings(agentDir, {}, outPath));
    expect(JSON.parse(fs.readFileSync(outPath, "utf8"))).toEqual({});
  });
});
