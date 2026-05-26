/**
 * rename-branch effect — pure rename logic.
 * Uses ctx.ui.notify for progress updates only; errors propagate to the
 * command boundary (index.ts) which converts them to error notifications.
 */

import { Effect, Option } from "effect";
import { NodeContext } from "@effect/platform-node";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readWorktreeBranch } from "../../../core/git/utils.ts";
import { sendEffect, errMsg } from "../../escape/client.ts";

// ── git context ────────────────────────────────────────────────────────────

type StateResponse = { parentBranch: string | null };

const buildGitContextEffect = (
  socketPath: string,
  token: string,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const stateResp = yield* sendEffect(socketPath, token, { op: "get-state" });
    if ("error" in stateResp) return Option.none();

    const { parentBranch } = stateResp as unknown as StateResponse;
    if (!parentBranch) return Option.none();

    const [logResp, diffResp] = yield* Effect.all([
      sendEffect(socketPath, token, {
        op: "git",
        args: ["log", `${parentBranch}..HEAD`, "--oneline", "--max-count=20"],
      }),
      sendEffect(socketPath, token, {
        op: "git",
        args: ["diff", "--stat", `${parentBranch}...HEAD`],
      }),
    ]);

    const log =
      !("error" in logResp) && logResp.code === 0 ? logResp.stdout.trim() : "";
    const diff =
      !("error" in diffResp) && diffResp.code === 0 ? diffResp.stdout.trim() : "";

    if (!log) return Option.none();

    const parts = [
      log ? `Commits:\n${log}` : null,
      diff ? `Files changed:\n${diff}` : null,
    ].filter((s): s is string => s !== null);
    return Option.some(parts.join("\n\n"));
  });

// ── conversation fallback ──────────────────────────────────────────────────

type ContentBlock = { type?: string; text?: string };
type SessionEntry = { type: string; message?: { role?: string; content?: unknown } };

const extractText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
};

const buildConversationText = (entries: SessionEntry[]): string =>
  entries
    .filter(e => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"))
    .flatMap(e => {
      const text = extractText(e.message!.content).trim();
      if (!text) return [];
      return [`${e.message!.role === "user" ? "User" : "Assistant"}: ${text}`];
    })
    .join("\n\n");

// ── prompt ─────────────────────────────────────────────────────────────────

const PROMPT = (context: string) => `\
You are a helpful assistant that names git branches.

Analyze the following context and respond with a short branch slug describing what was done or the topic.
Rules:
- Lowercase only
- Words separated by hyphens (no spaces, no underscores, no special characters)
- 2 to 5 words, max 40 characters total
- Must be a valid git branch name component

Respond ONLY with valid JSON matching this schema, no other text:
{"slug": string}

<context>
${context}
</context>`;

// ── main effect ────────────────────────────────────────────────────────────

type AuthResult =
  | { ok: true; apiKey: string | null; headers: Record<string, string> }
  | { ok: false; error: string };

export const renameBranchEffect = (
  ctx: ExtensionCommandContext,
  socketPath: string,
  token: string,
): Effect.Effect<void, Error, NodeContext.NodeContext> =>
  Effect.gen(function* () {
    const cwd = process.cwd();
    const currentBranch = yield* readWorktreeBranch(cwd);
    if (!currentBranch) {
      yield* Effect.fail(new Error("could not read current branch — are you in a pit worktree?"));
      return;
    }

    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("No active model", "warning");
      return;
    }

    const auth = (yield* Effect.tryPromise({
      try: () => ctx.modelRegistry.getApiKeyAndHeaders(model),
      catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
    })) as AuthResult;
    if (!auth.ok) {
      yield* Effect.fail(new Error(auth.error));
      return;
    }

    ctx.ui.notify("Building context...", "info");
    const gitContextOpt = yield* buildGitContextEffect(socketPath, token);

    const context = Option.isSome(gitContextOpt)
      ? gitContextOpt.value
      : buildConversationText(ctx.sessionManager.getBranch() as SessionEntry[]);

    if (!context.trim()) {
      yield* Effect.fail(new Error("nothing to analyze yet — make some commits or start a conversation"));
      return;
    }

    ctx.ui.notify("Asking the model for a branch name...", "info");

    const response = yield* Effect.tryPromise({
      try: () =>
        complete(
          model,
          {
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: PROMPT(context) }],
                timestamp: Date.now(),
              },
            ],
          },
          { apiKey: auth.apiKey ?? "", headers: auth.headers },
        ),
      catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
    });

    const raw = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");

    const match = raw.match(/\{[^}]*\}/s);
    if (!match) {
      yield* Effect.fail(new Error("could not parse structured output from model"));
      return;
    }

    const parsed = (() => {
      try { return JSON.parse(match[0]) as { slug?: string }; }
      catch { return null; }
    })();
    if (!parsed) {
      yield* Effect.fail(new Error("invalid JSON in model response"));
      return;
    }

    const slug = parsed.slug
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);

    if (!slug) {
      yield* Effect.fail(new Error("model returned an empty slug"));
      return;
    }

    const lastSlash = currentBranch.lastIndexOf("/");
    const prefix = lastSlash !== -1 ? currentBranch.slice(0, lastSlash + 1) : "";
    const newBranch = prefix + slug;

    if (newBranch === currentBranch) {
      ctx.ui.notify(`Branch already named: ${currentBranch}`, "info");
      return;
    }

    const resp = yield* sendEffect(socketPath, token, { op: "rename-branch", newBranch });

    if ("error" in resp || resp.code !== 0) {
      yield* Effect.fail(new Error(`branch rename failed: ${errMsg(resp)}`));
      return;
    }

    ctx.ui.notify(`Branch renamed: ${currentBranch} -> ${newBranch}`, "info");
  });
