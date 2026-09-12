import type {
	ExtensionAPI,
	SessionEntry,
	SessionMessageEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

type AssistantMessage = Extract<Message, { role: "assistant" }>;

type MutableSessionManager = Pick<
	SessionManager,
	| "appendMessage"
	| "appendModelChange"
	| "appendThinkingLevelChange"
	| "appendCustomMessageEntry"
	| "appendCustomEntry"
	| "appendSessionInfo"
>;

const CUSTOM_TYPE = "gaslight";

function clone<T>(value: T): T {
	if (value === undefined) return value;
	return JSON.parse(JSON.stringify(value)) as T;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			if ((block as { type?: unknown }).type !== "text") return "";
			return (block as { text?: unknown }).text;
		})
		.filter((text): text is string => typeof text === "string")
		.join("\n");
}

function asAssistantEntry(entry: SessionEntry | undefined) {
	if (entry?.type !== "message") return undefined;
	if (entry.message.role !== "assistant") return undefined;
	return entry as SessionMessageEntry;
}

function makeAssistantMessage(
	original: AssistantMessage,
	text: string,
): AssistantMessage {
	const message = {
		...clone(original),
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
		usage: clone(original.usage),
		api: original.api,
		provider: original.provider,
		model: original.model,
	} as AssistantMessage & { errorMessage?: string };

	delete message.errorMessage;
	return message;
}

function copyHistoryBefore(
	manager: MutableSessionManager,
	entries: SessionEntry[],
	selectedIndex: number,
) {
	for (const entry of entries.slice(0, selectedIndex)) {
		if (entry.type === "message") {
			manager.appendMessage(clone(entry.message));
		} else if (entry.type === "model_change") {
			manager.appendModelChange(entry.provider, entry.modelId);
		} else if (entry.type === "thinking_level_change") {
			manager.appendThinkingLevelChange(entry.thinkingLevel);
		} else if (entry.type === "branch_summary") {
			manager.appendCustomMessageEntry(
				CUSTOM_TYPE,
				`Branch summary from ${entry.fromId}:\n\n${entry.summary}`,
				true,
				{ copiedFrom: entry.id, sourceType: entry.type },
			);
		}
	}
}

export default function gaslightExtension(pi: ExtensionAPI) {
	pi.registerCommand("gaslight", {
		description: "Edit the current assistant message and fork from there",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/gaslight requires an interactive UI", "error");
				return;
			}

			if (args.trim()) {
				ctx.ui.notify("Usage: /gaslight", "warning");
				return;
			}

			await ctx.waitForIdle();

			const branch = ctx.sessionManager.getBranch();
			const selected = asAssistantEntry(ctx.sessionManager.getLeafEntry());
			if (!selected) {
				ctx.ui.notify(
					"Use /tree to select an assistant message, then run /gaslight.",
					"warning",
				);
				return;
			}

			const currentText = textFromContent(selected.message.content);
			const edited = await ctx.ui.editor(
				"Edit assistant message; delete the tail to simulate interruption",
				currentText,
			);
			if (edited === undefined) return;

			const selectedIndex = branch.findIndex((entry) => entry.id === selected.id);
			if (selectedIndex < 0) {
				ctx.ui.notify("Selected message disappeared", "error");
				return;
			}

			const markInterrupted = await ctx.ui.confirm(
				"Mark interrupted?",
				"Tell future agents this assistant response was stopped here?",
			);

			const parentSession = ctx.sessionManager.getSessionFile();
			const originalSessionName = ctx.sessionManager.getSessionName();
			const replacement = makeAssistantMessage(
				selected.message as AssistantMessage,
				edited,
			);

			const result = await ctx.newSession({
				parentSession,
				setup: async (manager) => {
					copyHistoryBefore(manager, branch, selectedIndex);
					manager.appendMessage(replacement);
					if (markInterrupted) {
						manager.appendCustomMessageEntry(
							CUSTOM_TYPE,
							"The previous assistant response was interrupted by " +
								"the user at this point. Treat it as stopped here.",
							false,
							{ originalEntryId: selected.id, marker: "interrupted" },
						);
					}
					if (originalSessionName) {
						manager.appendSessionInfo(`Gaslight: ${originalSessionName}`);
					}
					manager.appendCustomEntry(CUSTOM_TYPE, {
						originalEntryId: selected.id,
						originalSession: parentSession,
					});
				},
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify(
						"Gaslight fork created. Continue from the edited reply.",
						"info",
					);
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("Gaslight fork cancelled", "info");
			}
		},
	});
}
