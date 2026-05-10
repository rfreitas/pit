/**
 * Chat Summary extension - ask the LLM to summarise the current conversation.
 *
 * Usage: /summary
 *
 * Sends the conversation history to the current model and injects the result
 * as a message directly in the chat. No blocking UI panels.
 */

import { complete, getModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContentBlock = { type?: string; text?: string };

type SessionEntry = {
	type: string;
	message?: { role?: string; content?: unknown };
};

// ---------------------------------------------------------------------------
// Conversation extraction
// ---------------------------------------------------------------------------

const extractText = (content: unknown): string => {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((p): p is ContentBlock => !!p && typeof p === "object")
		.filter((p) => p.type === "text" && typeof p.text === "string")
		.map((p) => (p.text as string).trim())
		.join(" ")
		.trim();
};

const buildConversationText = (entries: SessionEntry[]): string => {
	const lines: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractText(entry.message.content);
		if (!text) continue;
		lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
	}
	return lines.join("\n\n");
};

// ---------------------------------------------------------------------------
// Prompt — instructions baked into the user message, no separate system field
// ---------------------------------------------------------------------------

const buildPrompt = (conversation: string): string =>
	[
		"Summarise the key topics from this conversation as a concise bullet-point list.",
		"Be high-level and succinct — one short phrase per bullet.",
		"Return ONLY the bullet points. No preamble, no conclusions, no extra text.",
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("summary", {
		description: "Summarise the conversation so far as a concise bullet-point list of topics",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch() as SessionEntry[];
			const conversation = buildConversationText(branch);

			if (!conversation.trim()) {
				ctx.ui.notify("Nothing to summarise yet.", "warning");
				return;
			}

			const activeModel =
				(ctx.model as ReturnType<typeof getModel>) ??
				getModel("anthropic", "claude-haiku-4-5") ??
				getModel("openai", "gpt-4.1-mini");

			if (!activeModel) {
				ctx.ui.notify("Could not resolve a model for summarisation.", "error");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(activeModel);
			if (!auth.ok) {
				ctx.ui.notify(auth.error, "error");
				return;
			}
			if (!auth.apiKey) {
				ctx.ui.notify(`No API key for ${activeModel.provider}/${activeModel.id}.`, "error");
				return;
			}

			ctx.ui.notify("Generating summary…", "info");

			const response = await complete(
				activeModel,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: buildPrompt(conversation) }],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers },
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			if (!summary) {
				ctx.ui.notify("Model returned an empty summary.", "warning");
				return;
			}

			pi.sendMessage({ customType: "chat-summary", content: `**Chat Summary**\n\n${summary}`, display: true });
		},
	});
}
