/**
 * /rename-branch — rename the worktree branch based on what was actually built.
 *
 * Human-facing command, only active in pit sessions (PIT_ESCAPE_SOCKET is set).
 *
 * Uses git log + diff stat against the parent branch as the primary signal
 * (what was actually committed is more precise than chat history). Falls back
 * to conversation text when the branch has no commits yet.
 *
 * Branch ref updates must go through pit-escape (outside the sandbox):
 * refs/heads/ is shared state across all worktrees and is not rw-mounted in
 * the sandbox. The extension reads the current branch (worktree gitdir is
 * rw-mounted and readable), computes the new name, then delegates the actual
 * git branch -m to pit-escape.
 */

import { Effect, Option } from "effect";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readWorktreeBranch } from "../git/utils.ts";
import { sendEffect, errMsg } from "../escape/client.ts";

// ── git context ────────────────────────────────────────────────────────────

type StateResponse = { parentBranch: string | null };

const buildGitContextEffect = (
  socketPath: string,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const stateResp = yield* sendEffect(socketPath, { op: "get-state" });
    if ("error" in stateResp) return Option.none();

    const { parentBranch } = stateResp as unknown as StateResponse;
    if (!parentBranch) return Option.none();

    const [logResp, diffResp] = yield* Effect.all([
      sendEffect(socketPath, {
        op: "git",
        args: ["log", `${parentBranch}..HEAD`, "--oneline", "--max-count=20"],
      }),
      sendEffect(socketPath, {
        op: "git",
        args: ["diff", "--stat", `${parentBranch}...HEAD`],
      }),
    ]);

    const log =
      !("error" in logResp) && logResp.code === 0
        ? logResp.stdout.trim()
        : "";
    const diff =
      !("error" in diffResp) && diffResp.code === 0
        ? diffResp.stdout.trim()
        : "";

    if (!log) return Option.none();

    const parts: string[] = [];
    if (log) parts.push(`Commits:\n${log}`);
    if (diff) parts.push(`Files changed:\n${diff}`);
    return Option.some(parts.join("\n\n"));
  });

// ── conversation fallback ──────────────────────────────────────────────────

type ContentBlock = { type?: string; text?: string };
type SessionEntry = { type: string; message?: { role?: string; content?: unknown } };

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function buildConversationText(entries: SessionEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;
    const { role, content } = entry.message;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(content).trim();
    if (text) lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  return lines.join("\n\n");
}

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

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PIT_ESCAPE_SOCKET;
  if (!socketPath) return;

  pi.registerCommand("rename-branch", {
    description:
      "Rename the worktree branch based on what was built (git diff) or the session topic",
    handler: async (_args, ctx) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const cwd = process.cwd();
          const currentBranch = readWorktreeBranch(cwd);
          if (!currentBranch) {
            ctx.ui.notify(
              "Could not read current branch — are you in a pit worktree?",
              "error",
            );
            return;
          }

          const model = ctx.model;
          if (!model) {
            ctx.ui.notify("No active model", "warning");
            return;
          }

          const auth = yield* Effect.tryPromise({
            try: () => ctx.modelRegistry.getApiKeyAndHeaders(model),
            catch: (e) => e,
          });
          if (!auth.ok) {
            ctx.ui.notify(auth.error, "warning");
            return;
          }

          ctx.ui.notify("Building context...", "info");
          const gitContextOpt = yield* buildGitContextEffect(socketPath!);

          let context: string;
          if (Option.isSome(gitContextOpt)) {
            context = gitContextOpt.value;
          } else {
            const entries = ctx.sessionManager.getBranch() as SessionEntry[];
            context = buildConversationText(entries);
          }

          if (!context.trim()) {
            ctx.ui.notify(
              "Nothing to analyze yet — make some commits or start a conversation",
              "warning",
            );
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
            catch: (e) => e,
          });

          const raw = response.content
            .filter(
              (c): c is { type: "text"; text: string } => c.type === "text",
            )
            .map((c) => c.text)
            .join("");

          const match = raw.match(/\{[^}]*\}/s);
          if (!match) {
            ctx.ui.notify(
              "Could not parse structured output from model",
              "error",
            );
            return;
          }

          let parsed: { slug?: string };
          try {
            parsed = JSON.parse(match[0]);
          } catch {
            ctx.ui.notify("Invalid JSON in model response", "error");
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
            ctx.ui.notify("Model returned an empty slug", "error");
            return;
          }

          const lastSlash = currentBranch.lastIndexOf("/");
          const prefix =
            lastSlash !== -1 ? currentBranch.slice(0, lastSlash + 1) : "";
          const newBranch = prefix + slug;

          if (newBranch === currentBranch) {
            ctx.ui.notify(`Branch already named: ${currentBranch}`, "info");
            return;
          }

          const resp = yield* sendEffect(socketPath!, {
            op: "rename-branch",
            newBranch,
          });

          if ("error" in resp || resp.code !== 0) {
            ctx.ui.notify(`Branch rename failed: ${errMsg(resp)}`, "error");
            return;
          }

          ctx.ui.notify(
            `Branch renamed: ${currentBranch} -> ${newBranch}`,
            "info",
          );
        }),
      );
    },
  });
}
