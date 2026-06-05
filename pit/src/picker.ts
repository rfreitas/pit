/**
 * Picker — session discovery, labeling, and TUI session picker.
 *
 * Extracted from program.ts so the dispatch Effect stays lean.
 * Owns all SessionSelectorComponent interactions and the
 * discoverSessionsForPicker / showBranchDeletedPrompt logic.
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { layer as NodeContextLayer, type NodeContext } from "./node-context.ts";
import {
  SessionManager,
  SessionSelectorComponent,
  initTheme,
  type CustomEntry,
} from "@earendil-works/pi-coding-agent";
import type { PitMetadata } from "./types.ts";
import { AGENT_DIR } from "./core/constants.ts";
import { scanSessionsByRepo } from "./core/session/io.ts";
import {
  isLinkedWorktree,
  resolveMainRepo,
  listRepoWorktrees,
  readWorktreeBranch,
  gitRepoRoot,
} from "./core/git/utils.ts";
import { launchEffect } from "./launcher.ts";

// ── types ─────────────────────────────────────────────────────────────────────

/** 
 * Represents a session loaded for the picker. Ensures we fulfill the
 * UI component's render contract at compile time.
 */
export interface PickerSession {
  path: string;
  modified: Date;
  firstMessage?: string;
  name?: string;
  cwd?: string | null;
  messageCount?: number;
  branch?: string; // checked-out branch name
  [key: string]: unknown; // Allow passthrough of other SessionManager fields
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Production-line helper to check if a branch exists locally in Git.
 * Exported so that our TUI E2E tests can execute the real plumbing under test.
 */
export const productionBranchExists = (
  branch: string,
  repo: string | null,
): Promise<boolean> =>
  Effect.runPromise(
    Effect.promise(async () => {
      try {
        const { execSync } = await import("node:child_process");
        execSync(`git show-ref --verify refs/heads/${branch}`, { cwd: repo ?? undefined, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })
  );

// ── pure labeling logic ───────────────────────────────────────────────────────

export const getWorktreeLabel = (
  branch: string | null | undefined,
  dirExists: boolean,
  hasBranch: boolean,
  isRegistered: boolean,
): string => {
  const isValidBranch = branch && branch !== "deleted";

  if (dirExists) {
    if (isValidBranch && hasBranch) {
      return isRegistered
        ? `[worktree branch:${branch}]`
        : `⚠ [unregistered worktree:${branch}]`;
    } else {
      return `⚠ [deleted branch${isValidBranch ? `:${branch}` : ""}]`;
    }
  } else {
    if (isValidBranch && hasBranch) {
      return `[missing worktree branch:${branch}]`;
    } else {
      return `[deleted branch:${branch ?? "unknown"}]`;
    }
  }
};

export const applySessionLabel = (s: Readonly<PickerSession>, labelText: string): PickerSession => {
  if (!labelText) return s;
  return s.name
    ? { ...s, name: `${labelText} ${s.name}` }
    : { ...s, firstMessage: `${labelText} ${s.firstMessage ?? "(no messages)"}` };
};

// ── discovery ─────────────────────────────────────────────────────────────────

/**
 * Discover sessions for the picker by combining live git worktree data
 * with a metadata scan for pruned worktrees.
 *
 * When isLinked=true, returns ONLY sessions for the current cwd (worktree
 * isolation — Fix 2.3).
 *
 * Otherwise:
 *   1. Query sessions for each known worktree path (from git worktree list).
 *   2. Scan all session files for any whose meta.repo matches the current repo
 *      but whose cwd is NOT in the git worktree list (pruned worktrees).
 *   3. Deduplicate by session path.
 *   4. Label worktree sessions with live branch name; add ⚠ when the dir
 *      exists but readWorktreeBranch returns null (Fix 2.4).
 */
export const discoverSessionsForPicker = async (
  opts: Readonly<{
    cwd: string;
    repo: string | null;
    isLinked: boolean;
    worktrees: readonly string[];
    agentDir: string;
  }>,
  deps: Readonly<{
    listSessions: (cwd: string) => Promise<readonly PickerSession[]>;
    readWorktreeBranch: (wt: string) => Promise<string | null>;
    existsSync: (p: string) => boolean;
    branchExists: (branch: string) => Promise<boolean>;
    scanSessionsByRepo: (repo: string, agentDir: string) => Promise<readonly PickerSession[]>;
  }>,
): Promise<readonly PickerSession[]> => {
  // 2.3: Worktree isolation — when inside a linked worktree, only show
  // sessions for THIS worktree, not siblings or the parent repo.
  if (opts.isLinked) {
    return deps.listSessions(opts.cwd).catch(() => []);
  }

  // Deduplicate: when running from the repo root, repo === cwd,
  // so mainPaths would contain duplicates without Set.
  const mainPaths = opts.repo
    ? [...new Set([opts.repo, opts.cwd])]
    : [opts.cwd];

  // 1. Sessions from git-known worktree paths
  const worktreeBranchInfo: Array<[string, string | null]> = await Promise.all(
    opts.worktrees.map(async (wt) => {
      const branch = await deps.readWorktreeBranch(wt);
      return [wt, branch] as [string, string | null];
    }),
  );
  const worktreeBranch = new Map(worktreeBranchInfo.map(([wt, b]) => [wt, b]));

  const [mainGroups, wtGroups] = await Promise.all([
    Promise.all(
      mainPaths.map((p) => deps.listSessions(p).catch(() => [] as PickerSession[])),
    ),
    Promise.all(
      opts.worktrees.map((wt) => deps.listSessions(wt).catch(() => [] as PickerSession[])),
    ),
  ]);

  // 1. Deduplicate raw sessions by path.
  const uniqueSessions = [
    ...new Map([...mainGroups.flat(), ...wtGroups.flat()].map(s => [s.path, s])).values()
  ];

  // 2. Filter out leaked sessions from other worktrees (if listSessions didn't isolate them).
  const validSessions = uniqueSessions.filter(s => {
    if (!s.cwd) return true; // keep old sessions without cwd
    if (s.cwd === opts.cwd || s.cwd === opts.repo) return true;
    return opts.worktrees.some(wt => s.cwd === wt || s.cwd!.startsWith(wt + "/"));
  });

  // 3. Label worktree sessions dynamically based on disk and branch state.
  const labeledPromises = validSessions.map(async (s) => {
    const matchedWt = s.cwd ? opts.worktrees.find(wt => s.cwd === wt || s.cwd!.startsWith(wt + "/")) : undefined;
    if (!matchedWt) return s; // Not a worktree session (or no cwd), leave unlabeled.

    const branch = worktreeBranch.get(matchedWt);
    const dirExists = deps.existsSync(matchedWt);
    const hasBranch = branch ? await deps.branchExists(branch) : false;

    const labelText = getWorktreeLabel(branch, dirExists, hasBranch, true);
    return applySessionLabel(s, labelText);
  });

  const flatMarked = await Promise.all(labeledPromises);

  // 2.1: Metadata scan for pruned worktrees — only include sessions whose
  // paths are NOT already known from SessionManager.list() (git worktree list
  // or main repo).
  const knownPaths = new Set(flatMarked.map((s) => s.path));

  const prunedSessions = opts.repo
    ? (await deps.scanSessionsByRepo(opts.repo, opts.agentDir).catch(() => [] as PickerSession[]))
        .filter((s) => !knownPaths.has(s.path))
    : [];

  const markedPruned = await Promise.all(
    prunedSessions.map(async (s) => {
      const b = s.branch ?? "unknown";
      const dirExists = s.cwd ? deps.existsSync(s.cwd) : false;
      const hasBranch = await deps.branchExists(b);

      const labelText = getWorktreeLabel(b, dirExists, hasBranch, false);
      return applySessionLabel(s, labelText);
    })
  );

  // Combine. Everything is strictly deduplicated.
  const combined = [...flatMarked, ...markedPruned];

  return [...combined].sort((a, b) => b.modified.getTime() - a.modified.getTime());
};

// ── tui prompts ───────────────────────────────────────────────────────────────

export const showBranchDeletedPrompt = async (
  branch: string,
): Promise<boolean> => {
  const { TUI, ProcessTerminal } = await import("@earendil-works/pi-tui");
  const { ExtensionSelectorComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme();

  return new Promise<boolean>((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal, true);

    const title = `Branch ${branch} no longer exists. Create a fresh branch off main?`;
    const options = ["Yes", "No"];

    const selector = new ExtensionSelectorComponent(
      title,
      options,
      (selected) => {
        tui.stop();
        resolve(selected === "Yes");
      },
      () => {
        tui.stop();
        resolve(false);
      }
    );

    tui.start();
    tui.addChild(selector);
    tui.setFocus(selector);
  });
};

// ── resume via session picker ─────────────────────────────────────────────────

export const showPicker = async (
  piArgs: string[],
  sandbox: boolean,
): Promise<{ sessionFile: string; meta: PitMetadata; sessionCwd: string; sessionUUID: string } | null> => {
  const { TUI, ProcessTerminal } = await import("@earendil-works/pi-tui");
  initTheme();

  const selectedPath = await new Promise<string | null>((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal, true);

    const selector = new SessionSelectorComponent(
      async (progress) => {
        const cwd = process.cwd();
        const rawRepo = await Effect.runPromise(gitRepoRoot().pipe(Effect.provide(NodeContextLayer)));
        const isLinked = await Effect.runPromise(isLinkedWorktree(cwd).pipe(Effect.provide(NodeContextLayer)));

        const mainRepo = isLinked
          ? await Effect.runPromise(resolveMainRepo(cwd).pipe(Effect.provide(NodeContextLayer)))
          : null;
        const repo = rawRepo && isLinked ? (mainRepo ?? rawRepo) : rawRepo;

        const worktrees = repo
          ? await Effect.runPromise(
              listRepoWorktrees(repo).pipe(
                Effect.catchAll(() => Effect.succeed([] as string[])),
                Effect.provide(NodeContextLayer),
              ),
            )
          : [];

        const { existsSync } = await import("node:fs");
        const sessions = await discoverSessionsForPicker(
          { cwd, repo, isLinked, worktrees, agentDir: AGENT_DIR },
          {
            listSessions: (p) => SessionManager.list(p, undefined, progress).catch(() => []) as unknown as Promise<PickerSession[]>,
            readWorktreeBranch: (wt) =>
              Effect.runPromise(readWorktreeBranch(wt).pipe(Effect.provide(NodeContextLayer))),
            existsSync,
            branchExists: (branch) => productionBranchExists(branch, repo),
            scanSessionsByRepo,
          },
        );
        return sessions as unknown as Awaited<ReturnType<typeof SessionManager.list>>;
      },
      (progress) => SessionManager.listAll(progress),
      (sessionPath) => { tui.stop(); resolve(sessionPath); },
      () => { tui.stop(); resolve(null); },
      () => { tui.stop(); resolve(null); },
      () => tui.requestRender(),
    );

    tui.start();
    tui.addChild(selector);
    tui.setFocus(selector);
  });

  if (!selectedPath) return null;

  try {
    const sm = SessionManager.open(selectedPath);
    const pitEntry = sm.getEntries().find(
      (e): e is CustomEntry<PitMetadata> =>
        e.type === "custom" && (e as CustomEntry).customType === "pit",
    );
    const sessionCwd = sm.getCwd() ?? selectedPath;
    const sessionUUID = sm.getSessionId();
    if (!pitEntry?.data) {
      // No pit metadata — still launch in the session's own cwd, not process.cwd().
      await Effect.runPromise(
        launchEffect(sessionCwd, ["--session", selectedPath, ...piArgs], sandbox).pipe(
          Effect.provide(NodeContextLayer),
        ),
      );
      return null;
    }
    return { sessionFile: selectedPath, meta: pitEntry.data, sessionCwd, sessionUUID };
  } catch {
    console.warn("pit: could not read session metadata — opening session directly");
    await Effect.runPromise(
      launchEffect(process.cwd(), ["--session", selectedPath, ...piArgs], sandbox).pipe(
        Effect.provide(NodeContextLayer),
      ),
    );
    return null;
  }
};
