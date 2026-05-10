/**
 * Rename Session Extension
 *
 * Uses the active model to analyze the conversation and suggest a session name
 * via structured JSON output, then applies it with pi.setSessionName().
 *
 * Usage: /rename
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ContentBlock = {
	type?: string;
	text?: string;
};

type SessionEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

const extractText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ContentBlock[])
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
};

const buildConversationText = (entries: SessionEntry[]): string => {
	const lines: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const { role, content } = entry.message;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractText(content).trim();
		if (text) lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
	}
	return lines.join("\n\n");
};

const PROMPT = (conversation: string) => `\
You are a helpful assistant that names coding sessions.

Analyze the conversation below and respond with a short, descriptive session name.
Rules:
- 2 to 5 words
- Title Case
- No punctuation
- Reflect the main topic or goal

Respond ONLY with valid JSON matching this schema, no other text:
{"name": string}

<conversation>
${conversation}
</conversation>`;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("rename", {
		description: "Ask the agent to name the current session using structured output",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch() as SessionEntry[];
			const conversation = buildConversationText(branch);

			if (!conversation.trim()) {
				ctx.ui.notify("No conversation to analyze yet", "warning");
				return;
			}

			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No active model", "warning");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				ctx.ui.notify(auth.error, "warning");
				return;
			}

			ctx.ui.notify("Asking the model for a session name…", "info");

			const response = await complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: PROMPT(conversation) }],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey ?? "", headers: auth.headers },
			);

			const raw = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");

			// Extract JSON object from response (guard against extra prose)
			const match = raw.match(/\{[^}]*\}/s);
			if (!match) {
				ctx.ui.notify("Could not parse structured output from model", "error");
				return;
			}

			let parsed: { name?: string };
			try {
				parsed = JSON.parse(match[0]);
			} catch {
				ctx.ui.notify("Invalid JSON in model response", "error");
				return;
			}

			const name = parsed.name?.trim();
			if (!name) {
				ctx.ui.notify("Model returned an empty name", "error");
				return;
			}

			pi.setSessionName(name);
			ctx.ui.notify(`Session renamed to: "${name}"`, "info");
		},
	});
}
