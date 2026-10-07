import * as vscode from 'vscode';
import { ChatMessage, ChatSessionState, PersistedChatSessionState, RecentConversationRecord, TaskRunRecord, TerminalCommandRecord, TimelineEntry } from '../core/types';

const SESSION_KEY = 'buildbyyou.chatSession';
const TIMELINE_KEY = 'buildbyyou.timeline';
const TERMINAL_HISTORY_KEY = 'buildbyyou.terminalHistory';
const TASK_HISTORY_KEY = 'buildbyyou.taskHistory';
const RECENT_CONVERSATIONS_KEY = 'buildbyyou.recentConversations';
const MAX_RECENT_CONVERSATIONS = 5;
const MAX_RECENT_CONVERSATION_MESSAGES = 60;

export class SessionStoreService {
	public constructor(
		private readonly workspaceState: vscode.Memento,
		private readonly globalState: vscode.Memento,
	) {}

	public load(): ChatSessionState {
		const saved = this.workspaceState.get<PersistedChatSessionState>(SESSION_KEY);
		return {
			selectedWorkspace: saved?.selectedWorkspace ? vscode.Uri.parse(saved.selectedWorkspace) : undefined,
			messages: saved?.messages ?? [],
			recentPrompts: saved?.recentPrompts ?? [],
			executionMode: saved?.executionMode ?? 'verify',
			lastWorkflow: saved?.lastWorkflow,
		};
	}

	public async save(session: ChatSessionState): Promise<void> {
		const persisted: PersistedChatSessionState = {
			selectedWorkspace: session.selectedWorkspace?.toString(),
			messages: this.sanitizeMessages(session.messages),
			recentPrompts: session.recentPrompts.slice(0, 3),
			executionMode: session.executionMode,
			lastWorkflow: session.lastWorkflow,
		};
		await this.workspaceState.update(SESSION_KEY, persisted);
	}

	public loadRecentConversations(): RecentConversationRecord[] {
		return this.globalState.get<RecentConversationRecord[]>(RECENT_CONVERSATIONS_KEY) ?? [];
	}

	public async upsertRecentConversation(record: RecentConversationRecord): Promise<void> {
		const cleanRecord: RecentConversationRecord = {
			...record,
			title: record.title.trim() || record.workspaceLabel || 'Untitled conversation',
			messages: this.sanitizeMessages(record.messages).slice(-MAX_RECENT_CONVERSATION_MESSAGES),
		};
		const existing = this.loadRecentConversations().filter((entry) => entry.id !== cleanRecord.id);
		await this.globalState.update(
			RECENT_CONVERSATIONS_KEY,
			[cleanRecord, ...existing]
				.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
				.slice(0, MAX_RECENT_CONVERSATIONS),
		);
	}

	public async deleteRecentConversation(id: string): Promise<void> {
		await this.globalState.update(
			RECENT_CONVERSATIONS_KEY,
			this.loadRecentConversations().filter((entry) => entry.id !== id),
		);
	}

	public loadTimeline(): TimelineEntry[] {
		return this.workspaceState.get<TimelineEntry[]>(TIMELINE_KEY) ?? [];
	}

	public async saveTimeline(entries: TimelineEntry[]): Promise<void> {
		await this.workspaceState.update(TIMELINE_KEY, entries);
	}

	public loadTerminalHistory(): Record<string, TerminalCommandRecord[]> {
		return this.workspaceState.get<Record<string, TerminalCommandRecord[]>>(TERMINAL_HISTORY_KEY) ?? {};
	}

	public async saveTerminalHistory(entries: Record<string, TerminalCommandRecord[]>): Promise<void> {
		await this.workspaceState.update(TERMINAL_HISTORY_KEY, entries);
	}

	public loadTaskHistory(): TaskRunRecord[] {
		return this.workspaceState.get<TaskRunRecord[]>(TASK_HISTORY_KEY) ?? [];
	}

	public async saveTaskHistory(entries: TaskRunRecord[]): Promise<void> {
		await this.workspaceState.update(TASK_HISTORY_KEY, entries);
	}

	public async clear(): Promise<void> {
		await this.workspaceState.update(SESSION_KEY, undefined);
		await this.workspaceState.update(TIMELINE_KEY, undefined);
		await this.workspaceState.update(TERMINAL_HISTORY_KEY, undefined);
		await this.workspaceState.update(TASK_HISTORY_KEY, undefined);
	}

	private sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
		return messages.map((message) => ({
			role: message.role,
			text: message.text,
			trace: message.trace
				? {
					text: message.trace.text,
					elapsedMs: message.trace.elapsedMs,
					tokenCount: message.trace.tokenCount,
					stepCount: message.trace.stepCount,
				}
				: undefined,
		}));
	}
}
