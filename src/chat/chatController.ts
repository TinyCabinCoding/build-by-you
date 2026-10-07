import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { diffLines } from 'diff';
import { AgentMode, ApprovalResult, ChatImageAttachment, ChatMessage, ChatSessionState, ChatTraceRecord, ExecutionMode, ExtensionConfig, LastWorkflowState, RecentConversationRecord, TaskRunRecord, TimelineEntry } from '../core/types';
import { ChatPanel, ChatPanelHost, ChatSidebarProvider, ChatSurface } from './chatView';
import { PreviewPanel } from './previewPanel';
import { CommandExecutionService } from '../services/commandExecutionService';
import { ConfigService } from '../services/configService';
import { GitService } from '../services/gitService';
import { GrokAgentService } from '../services/grokAgentService';
import { SecretService } from '../services/secretService';
import { SessionStoreService } from '../services/sessionStoreService';
import { TaskPresetService } from '../services/taskPresetService';
import { TerminalSessionService } from '../services/terminalSessionService';
import { VoiceCaptureServer } from '../services/voiceCaptureServer';
import { WorkspaceContextService } from '../services/workspaceContextService';
import { XaiClient } from '../services/xaiClient';
import { canAutoApproveCommand, matchesBlockedPattern } from '../util/commandPolicy';
import { isSensitiveWorkspacePath } from '../util/sensitivePaths';
import { sanitizeTerminalChunk, summarizeTerminalOutput } from '../util/terminalText';

interface VerificationRunResult {
	label: string;
	command: string;
	exitCode: number;
	output: string;
	diagnosis: string;
	succeeded: boolean;
}

interface PlannerRunOverride {
	forcePlanner?: boolean;
	plannerEffort?: ExtensionConfig['plannerEffort'];
}

const MAX_VOICE_AUDIO_BYTES = 100 * 1024 * 1024;

export class ChatController implements ChatPanelHost {
	private readonly session: ChatSessionState;
	private panel: ChatPanel | undefined;
	private readonly sidebarProvider: ChatSidebarProvider;
	private readonly timeline: TimelineEntry[];
	private readonly taskHistory: TaskRunRecord[];
	private readonly sessionApprovedCommands = new Set<string>();
	private isBusy = false;
	private lastLiveThought = '';
	private activeClient: XaiClient | undefined;
	private currentTurnDraft: { text: string; attachments: ChatImageAttachment[] } | undefined;
	private interruptedTurnDraft: { text: string; attachments: ChatImageAttachment[] } | undefined;
	private recentAgentEvents: string[] = [];
	private readonly commandExecutionService: CommandExecutionService;
	private previewPanel: PreviewPanel | undefined;
	private readonly voiceCaptureServer = new VoiceCaptureServer();

	public constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly configService: ConfigService,
		private readonly secretService: SecretService,
		private readonly sessionStoreService: SessionStoreService,
		private readonly terminalSessionService: TerminalSessionService,
		private readonly gitService: GitService,
		private readonly taskPresetService: TaskPresetService,
		private readonly workspaceContextService: WorkspaceContextService,
		private readonly grokAgentService: GrokAgentService,
		private readonly securityOutputChannel: vscode.OutputChannel,
	) {
		this.session = this.sessionStoreService.load();
		if (this.configService.get().persistSensitiveHistory) {
			this.timeline = this.sessionStoreService.loadTimeline();
			this.taskHistory = this.sessionStoreService.loadTaskHistory();
			this.terminalSessionService.importHistory(this.sessionStoreService.loadTerminalHistory());
		} else {
			this.session.messages = [];
			this.timeline = [];
			this.taskHistory = [];
			void this.sessionStoreService.save({
				...this.session,
				messages: [],
				lastWorkflow: this.session.lastWorkflow
					? {
						...this.session.lastWorkflow,
						detail: 'History persistence is disabled.',
						command: undefined,
						output: undefined,
					}
					: undefined,
			});
			void this.sessionStoreService.saveTimeline([]);
			void this.sessionStoreService.saveTaskHistory([]);
			void this.sessionStoreService.saveTerminalHistory({});
		}
		this.sidebarProvider = new ChatSidebarProvider(this, async () => {
			await this.initializeVisibleSurfaces();
		});
		this.commandExecutionService = new CommandExecutionService(this.terminalSessionService);
	}

	public async openPanel(): Promise<void> {
		this.panel = ChatPanel.createOrShow(this.context, this);
		if (!this.session.selectedWorkspace) {
			const folder = this.workspaceContextService.getDefaultWorkspaceFolder();
			this.session.selectedWorkspace = folder?.uri;
		}

		this.panel.setTitle(`Build by You${this.currentWorkspaceLabel() ? ` - ${this.currentWorkspaceLabel()}` : ''}`);
		await this.refreshState();
		this.replayState();
	}

	public getSidebarProvider(): ChatSidebarProvider {
		return this.sidebarProvider;
	}

	public dispose(): void {
		this.voiceCaptureServer.dispose();
	}

	public async handleWebviewReady(): Promise<void> {
		await this.initializeVisibleSurfaces();
	}

	private async initializeVisibleSurfaces(): Promise<void> {
		if (!this.session.selectedWorkspace) {
			const folder = this.workspaceContextService.getDefaultWorkspaceFolder();
			this.session.selectedWorkspace = folder?.uri;
		}

		await this.refreshState();
		this.replayState();
	}

	public async handlePrompt(text: string, attachments: ChatImageAttachment[] = []): Promise<void> {
		await this.runPrompt(text, attachments, 'default');
	}

	public async handleTranscribeVoice(dataUrl: string, mimeType: string): Promise<string> {
		const apiKey = await this.secretService.getApiKey();
		if (!apiKey) {
			await this.handleSetApiKey();
			throw new Error('Set your xAI API key before using Voice Mode.');
		}

		const match = /^data:([^;,]+)[^,]*,([a-z0-9+/=]+)$/i.exec(dataUrl.trim());
		if (!match) {
			throw new Error('Voice recording was not received in a valid audio format.');
		}

		const detectedMimeType = match[1] || mimeType || 'audio/webm';
		if (!detectedMimeType.startsWith('audio/')) {
			throw new Error(`Voice recording had an unsupported MIME type: ${detectedMimeType}.`);
		}

		const audio = Buffer.from(match[2], 'base64');
		if (audio.length === 0) {
			throw new Error('Voice recording was empty.');
		}

		if (audio.length > MAX_VOICE_AUDIO_BYTES) {
			throw new Error('Voice recording is too large. Stop and send shorter dictation segments.');
		}

		const config = this.configService.get();
		const client = new XaiClient(apiKey, config.baseUrl);
		const transcript = await client.transcribeAudio(audio, detectedMimeType, `build-by-you-voice.${this.audioExtensionForMimeType(detectedMimeType)}`);
		this.securityOutputChannel.appendLine(`[${new Date().toISOString()}] Voice transcription completed (${audio.length} bytes, ${detectedMimeType}).`);
		return transcript;
	}

	public async handleOpenVoiceCapture(): Promise<void> {
		await this.openBrowserVoiceCapture();
	}

	private async openBrowserVoiceCapture(): Promise<void> {
		const apiKey = await this.secretService.getApiKey();
		if (!apiKey) {
			await this.handleSetApiKey();
			this.forEachSurface((surface) => surface.postSystem('Set your xAI API key before using browser Voice Capture.'));
			return;
		}

		const config = this.configService.get();
		const client = new XaiClient(apiKey, config.baseUrl);
		this.forEachSurface((surface) => surface.postSystem('Opening secure browser Voice Capture. Use the mic there to add one or more transcription segments into this prompt. The browser voice session stays open until you end it.'));
		await this.voiceCaptureServer.open({
			transcribe: async (audio, mimeType) => {
				if (audio.length > MAX_VOICE_AUDIO_BYTES) {
					throw new Error('Voice recording is too large. Stop and send shorter dictation segments.');
				}
				const transcript = await client.transcribeAudio(audio, mimeType, `build-by-you-browser-voice.${this.audioExtensionForMimeType(mimeType)}`);
				this.securityOutputChannel.appendLine(`[${new Date().toISOString()}] Browser voice transcription completed (${audio.length} bytes, ${mimeType}).`);
				return transcript;
			},
			onTranscript: (text) => {
				this.forEachSurface((surface) => surface.appendPromptText(text));
				this.forEachSurface((surface) => surface.setStatus('Voice transcribed. Review, then press Enter or click the rocket to send.'));
			},
			onStatus: (text) => {
				if (text) {
					this.forEachSurface((surface) => surface.setStatus(text));
				}
			},
		});
	}

	private audioExtensionForMimeType(mimeType: string): string {
		if (mimeType.includes('ogg')) {
			return 'ogg';
		}
		if (mimeType.includes('mp4')) {
			return 'mp4';
		}
		if (mimeType.includes('mpeg') || mimeType.includes('mp3')) {
			return 'mp3';
		}
		if (mimeType.includes('wav')) {
			return 'wav';
		}
		return 'webm';
	}

	private async runPrompt(
		text: string,
		attachments: ChatImageAttachment[] = [],
		agentMode: AgentMode = 'default',
		plannerOverride: PlannerRunOverride = {},
	): Promise<void> {
		if (this.isBusy) {
			return;
		}

		const slashHandled = agentMode === 'default' ? await this.handleSlashCommand(text) : false;
		if (slashHandled) {
			return;
		}

		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!folder) {
			void vscode.window.showWarningMessage('Open a folder or workspace before using Build by You.');
			return;
		}

		const apiKey = await this.secretService.getApiKey();
		if (!apiKey) {
			void vscode.window.showWarningMessage('Set your xAI API key before sending a prompt.');
			await this.handleSetApiKey();
			return;
		}

		const config = this.configService.get();
		const client = new XaiClient(apiKey, config.baseUrl);
		this.activeClient = client;
		const summary = await this.workspaceContextService.buildSummary(folder);
		const rawPrompt = text.trim() || (attachments.length > 0 ? 'Inspect this image and help with the request.' : '');
		const normalizedText = this.interruptedTurnDraft
			? this.mergeInterruptedPrompt(this.interruptedTurnDraft.text, rawPrompt)
			: rawPrompt;
		const effectiveAgentMode = agentMode === 'default' && this.isLikelyPythonRequest(normalizedText)
			? 'python'
			: agentMode;
		const agentPrompt = this.buildAgentPromptWithMicroMemory(normalizedText);
		const mergedAttachments = this.interruptedTurnDraft
			? [...this.interruptedTurnDraft.attachments, ...attachments]
			: attachments;
		this.currentTurnDraft = { text: agentPrompt, attachments: mergedAttachments };
		this.interruptedTurnDraft = undefined;
		this.recordRecentPrompt(normalizedText);
		this.discloseOutboundContext(summary, agentPrompt, mergedAttachments);
		const displayText = this.buildDisplayedPrompt(normalizedText, mergedAttachments);
		const thinkingMessageId = `thinking-${Date.now()}`;
		const turnId = `turn-${Date.now()}`;
		let assistantText = '';
		let reasoningText = '';
		let lastTraceReasoningLength = 0;
		const workTraceStartedAt = Date.now();
		const traceLines: string[] = [];
		let latestStatus = mergedAttachments.length > 0
			? `Received ${mergedAttachments.length} image attachment${mergedAttachments.length === 1 ? '' : 's'}. Analyzing the image and your prompt...`
			: 'Preparing workspace context...';
		this.lastLiveThought = '';
		const seenTraceLines = new Set<string>();
		const appendTraceLine = (line: string): void => {
			const cleanLine = line.trim();
			const dedupeKey = cleanLine.replace(/\s+/g, ' ');
			if (!cleanLine || seenTraceLines.has(dedupeKey)) {
				return;
			}
			seenTraceLines.add(dedupeKey);
			traceLines.push(cleanLine);
			this.forEachSurface((surface) => {
				surface.updateAssistant(this.formatThinkingMessage(traceLines), thinkingMessageId);
			});
		};
		const appendReasoningTrace = (force = false): void => {
			const normalized = reasoningText
				.replace(/\s+/g, ' ')
				.trim();
			if (!normalized || normalized.length <= lastTraceReasoningLength) {
				return;
			}
			const nextChunk = normalized.slice(lastTraceReasoningLength).trim();
			if (!nextChunk) {
				return;
			}
			if (!force && nextChunk.length < 180 && !/[.!?)]$/.test(nextChunk)) {
				return;
			}
			lastTraceReasoningLength = normalized.length;
			appendTraceLine(nextChunk);
		};
		const buildTraceRecord = (): ChatTraceRecord => {
			const tokenCount = this.realTurnTokenCount(client);
			if (traceLines.length === 0) {
				appendTraceLine(latestStatus || 'Completed request.');
			}
			return {
				text: traceLines.join('\n'),
				elapsedMs: Date.now() - workTraceStartedAt,
				...(tokenCount > 0 ? { tokenCount } : {}),
				stepCount: traceLines.length,
			};
		};
		const renderAssistantProgress = (): void => {
			if (assistantText.trim()) {
				return;
			}

			if (reasoningText.trim()) {
				this.forEachSurface((surface) => surface.updateAssistant(
					this.formatThinkingMessage([...traceLines, ...this.buildReasoningPreviewLines(reasoningText)]),
					thinkingMessageId,
				));
			} else if (latestStatus.trim()) {
				this.forEachSurface((surface) => surface.updateAssistant(this.formatThinkingMessage(traceLines), thinkingMessageId));
			}
		};

		this.isBusy = true;
		this.appendTimeline({
			id: turnId,
			turnId,
			kind: 'turn',
			title: text,
			timestamp: new Date().toISOString(),
		});
		this.forEachSurface((surface) => {
			surface.setBusy(true);
			surface.postUser(displayText);
			surface.postAssistant(this.formatThinkingMessage([latestStatus]), thinkingMessageId);
			surface.setStatus(latestStatus);
		});
		appendTraceLine(latestStatus);

		try {
			assistantText = await this.grokAgentService.runTurn({
				client,
				config,
				folder,
				history: this.session.messages,
				userPrompt: agentPrompt,
				userAttachments: mergedAttachments,
				agentMode: effectiveAgentMode,
				forcePlanner: plannerOverride.forcePlanner,
				plannerEffort: plannerOverride.plannerEffort,
				workspaceSummary: summary,
				onStatus: (message) => {
					latestStatus = message;
					this.forEachSurface((surface) => surface.setStatus(message));
					appendTraceLine(message);
					renderAssistantProgress();
					this.appendTimeline({
						id: `${turnId}-${Date.now()}-${Math.random()}`,
						turnId,
						kind: 'status',
						title: message,
						timestamp: new Date().toISOString(),
					});
				},
				onTextDelta: (delta) => {
					assistantText += delta;
					renderAssistantProgress();
				},
				onReasoningDelta: (delta) => {
					reasoningText += delta;
					appendReasoningTrace(false);
					renderAssistantProgress();
				},
				onEvent: (message) => {
					this.recordAgentEventMemory(message);
					this.appendTimeline({
						id: `${turnId}-${Date.now()}-${Math.random()}`,
						turnId,
						kind: message.startsWith('git ') ? 'git' : message.startsWith('terminal ') ? 'command' : 'tool',
						title: message.split('\n')[0],
						detail: message,
						timestamp: new Date().toISOString(),
					});
				},
				requestApproval: async (details) => this.requestApproval(details),
				terminalSessionService: this.terminalSessionService,
				gitService: this.gitService,
			});

			this.session.messages.push({ role: 'user', text: normalizedText, attachments: mergedAttachments });
			const finalAssistantText = await this.appendDiffReport(folder, assistantText);
			appendReasoningTrace(true);
			const trace = buildTraceRecord();
			this.forEachSurface((surface) => surface.finishWorkTrace({ tokenCount: trace.tokenCount }));
			this.session.messages.push({ role: 'assistant', text: finalAssistantText, trace });
			await this.persistSessionState();
			await this.persistRecentConversation(folder);
			this.forEachSurface((surface) => {
				surface.postAssistant(finalAssistantText || 'The model returned no assistant message.');
				surface.setStatus(this.formatTurnStatus(trace));
			});
		} catch (error) {
			if (this.isAbortError(error)) {
				this.interruptedTurnDraft = this.currentTurnDraft;
				this.forEachSurface((surface) => {
					surface.postSystem('Stopped. Add more instructions and send again to continue from the last prompt.');
					surface.setStatus('Stopped.');
				});
				return;
			}
			const message = this.cleanErrorForChat(error instanceof Error ? error.message : String(error));
			this.forEachSurface((surface) => {
				surface.postSystem(`Error: ${message}`);
				surface.setStatus('Request failed.');
			});
		} finally {
			appendReasoningTrace(true);
			const tokenCount = this.realTurnTokenCount(client);
			this.forEachSurface((surface) => surface.finishWorkTrace({ tokenCount }));
			this.activeClient = undefined;
			this.currentTurnDraft = undefined;
			this.isBusy = false;
			this.forEachSurface((surface) => surface.setBusy(false));
			await this.refreshState();
		}
	}

	private buildDisplayedPrompt(text: string, attachments: ChatImageAttachment[]): string {
		if (attachments.length === 0) {
			return text;
		}

		const label = attachments.length === 1 ? 'Attached image' : 'Attached images';
		const names = attachments.map((attachment) => attachment.name).join(', ');
		return [text, `${label}: ${names}`].filter(Boolean).join('\n\n');
	}

	private isLikelyPythonRequest(text: string): boolean {
		const lowered = text.toLowerCase();
		if (/\/(?:py|python)\b/.test(lowered)) {
			return true;
		}

		const hasPythonTarget = /\b[\w.-]+\.py\b/.test(lowered)
			|| /\bpython\b/.test(lowered)
			|| /\bpython3\b/.test(lowered);
		if (!hasPythonTarget) {
			return false;
		}

		return /\b(?:script|scripts\/|numpy|pandas|matplotlib|scipy|seaborn|statsmodels|csv|data\/raw|requirements\.txt|venv|pip)\b/.test(lowered);
	}

	private cleanErrorForChat(message: string): string {
		const trimmed = message.trim();
		const lower = trimmed.slice(0, 300).toLowerCase();
		if (lower.startsWith('<!doctype html') || lower.startsWith('<html') || /<body[\s>]/i.test(trimmed)) {
			const title = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
				?.replace(/\s+/g, ' ')
				.trim();
			const heading = trimmed.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
				?.replace(/\s+/g, ' ')
				.trim();
			const summary = [title, heading].filter(Boolean).join(' - ');
			return [
				'Received an HTML error page instead of the expected machine-readable response.',
				summary ? `Page summary: ${summary}.` : '',
				'Raw HTML was suppressed.',
			].filter(Boolean).join(' ');
		}

		return trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}\n[error truncated ${trimmed.length - 1200} chars]` : trimmed;
	}

	private mergeInterruptedPrompt(previousText: string, additionalText: string): string {
		if (!additionalText.trim()) {
			return previousText;
		}

		return [
			previousText,
			'',
			'Additional instructions:',
			additionalText,
		].join('\n');
	}

	private buildAgentPromptWithMicroMemory(prompt: string): string {
		const trimmedPrompt = prompt.trim();
		const recentUserMessages = this.session.messages
			.filter((message) => message.role === 'user' && message.text.trim())
			.slice(-3)
			.map((message) => message.text.replace(/\s+/g, ' ').trim().slice(0, 600));
		const recentAssistantMessages = this.session.messages
			.filter((message) => message.role === 'assistant' && message.text.trim())
			.slice(-2)
			.map((message) => message.text.replace(/\s+/g, ' ').trim().slice(0, 600));
		const recentFailures = this.recentAgentEvents
			.filter((event) => /\b(search text was not found|failed|validation failed|not complete|blank|empty)\b/i.test(event))
			.slice(-5);
		const isShortFollowUp = trimmedPrompt.length < 160 || /\b(still|again|same|not fixed|blank|empty|that|it|this)\b/i.test(trimmedPrompt);
		if (!isShortFollowUp && recentFailures.length === 0) {
			return trimmedPrompt;
		}

		return [
			'Current user request:',
			trimmedPrompt,
			'',
			'Micro-memory from this chat:',
			recentUserMessages.length > 0 ? `Recent user requests:\n${recentUserMessages.map((entry) => `- ${entry}`).join('\n')}` : '- No recent user requests recorded.',
			recentAssistantMessages.length > 0 ? `Recent assistant results:\n${recentAssistantMessages.map((entry) => `- ${entry}`).join('\n')}` : '- No recent assistant results recorded.',
			recentFailures.length > 0 ? `Recent tool/validation failures:\n${recentFailures.map((entry) => `- ${entry}`).join('\n')}` : '- No recent tool failures recorded.',
			'',
			'Follow-up handling rules:',
			'- Treat short prompts like "still blank", "same issue", or "fix it" as referring to the most recent relevant user request and failed result.',
			'- If replace_in_file fails because exact search text is missing, do not retry the same brittle replacement. Re-read the full target file or needed line ranges, then use a robust write_file or a new exact replacement based on the current file contents.',
			'- Do not return an automatic success summary when no requested change was actually made and verified.',
		].join('\n');
	}

	private recordAgentEventMemory(message: string): void {
		const compact = message.replace(/\s+/g, ' ').trim();
		if (!compact) {
			return;
		}

		this.recentAgentEvents = [
			...this.recentAgentEvents,
			compact.slice(0, 500),
		].slice(-20);
	}

	private recordRecentPrompt(prompt: string): void {
		const normalized = prompt.trim();
		if (!normalized) {
			return;
		}

		this.session.recentPrompts = [
			normalized,
			...this.session.recentPrompts.filter((entry) => entry !== normalized),
		].slice(0, 3);
	}

	private formatThinkingMessage(lines: string[]): string {
		const cleaned = lines
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => line.replace(/^Thinking:\s*/i, '').trim())
			.filter(Boolean);
		const seen = new Set<string>();
		const unique = cleaned.filter((line) => {
			const key = line.replace(/\s+/g, ' ');
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
		if (unique.length === 0) {
			return 'Thinking:\n- Working on it...';
		}

		return [
			'Thinking:',
			...unique.map((line) => line.startsWith('- ') ? line : `- ${line}`),
		].join('\n');
	}

	private formatTurnStatus(trace: ChatTraceRecord): string {
		const tokenText = trace.tokenCount && trace.tokenCount > 0
			? `Token usage: ${trace.tokenCount.toLocaleString()}`
			: 'Token usage: n/a';
		return `${tokenText} | Time: ${this.formatDuration(trace.elapsedMs ?? 0)} | Ready.`;
	}

	private formatDuration(ms: number): string {
		if (!Number.isFinite(ms) || ms <= 0) {
			return '0s';
		}

		const totalSeconds = Math.max(1, Math.round(ms / 1000));
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		if (minutes <= 0) {
			return `${seconds}s`;
		}

		return `${minutes}m ${seconds}s`;
	}

	private buildReasoningPreviewLines(reasoningText: string): string[] {
		const normalized = reasoningText
			.replace(/\s+/g, ' ')
			.replace(/\s*([,;:])\s*/g, '$1 ')
			.trim();
		if (!normalized) {
			return [];
		}

		const chunks = normalized
			.split(/(?<=[.!?])\s+/)
			.map((chunk) => chunk.trim())
			.filter(Boolean);
		const bullets = chunks.length > 1
			? chunks
			: this.wrapReasoningChunk(normalized);

		return ['Thinking:', ...bullets.map((chunk) => `- ${chunk}`)];
	}

	private wrapReasoningChunk(text: string): string[] {
		const maxLineLength = 96;
		const words = text.split(/\s+/);
		const lines: string[] = [];
		let current = '';

		for (const word of words) {
			const next = current ? `${current} ${word}` : word;
			if (next.length > maxLineLength && current) {
				lines.push(current);
				current = word;
				continue;
			}

			current = next;
		}

		if (current) {
			lines.push(current);
		}

		return lines;
	}

	private realTurnTokenCount(client: XaiClient): number {
		return client.getTokenUsageTotal();
	}

	private async appendDiffReport(folder: vscode.WorkspaceFolder, assistantText: string): Promise<string> {
		const base = assistantText.trim();
		try {
			if (!await this.gitService.isGitRepo(folder)) {
				return base;
			}

			const diffSummary = await this.gitService.diffSummary(folder);
			if (!diffSummary) {
				return base;
			}

			return [base, '', diffSummary].filter(Boolean).join('\n');
		} catch {
			return base;
		}
	}

	private isAbortError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error ?? '');
		return /abort|aborted|The operation was aborted/i.test(message);
	}

	public async handleSetApiKey(): Promise<void> {
		const value = await vscode.window.showInputBox({
			title: 'Set xAI API Key',
			prompt: 'Enter your xAI API key. It will be stored in VS Code Secret Storage.',
			password: true,
			ignoreFocusOut: true,
			validateInput: (input) => input.trim() ? undefined : 'API key is required.',
		});

		if (!value) {
			return;
		}

		await this.secretService.setApiKey(value);
		void vscode.window.showInformationMessage('xAI API key stored for Build by You.');
		await this.refreshState();
	}

	public async handleDeleteRecentPrompt(index: number): Promise<void> {
		if (!Number.isInteger(index) || index < 0 || index >= this.session.recentPrompts.length) {
			return;
		}

		this.session.recentPrompts.splice(index, 1);
		await this.persistSessionState();
		await this.refreshState();
	}

	public async handleOpenRecentConversation(id: string): Promise<void> {
		const conversation = this.sessionStoreService.loadRecentConversations().find((entry) => entry.id === id);
		if (!conversation) {
			return;
		}

		this.session.messages = conversation.messages.map((message) => ({
			role: message.role,
			text: message.text,
			trace: message.trace,
		}));
		this.session.selectedWorkspace = conversation.workspaceUri ? vscode.Uri.parse(conversation.workspaceUri) : this.session.selectedWorkspace;
		await this.persistSessionState();
		await this.refreshState();
		this.replayState();
	}

	public async handleDeleteRecentConversation(id: string): Promise<void> {
		await this.sessionStoreService.deleteRecentConversation(id);
		await this.refreshState();
	}

	public async handleTogglePrivacyMode(): Promise<void> {
		await this.handleToggleMemoryMode();
	}

	public async handleToggleMemoryMode(): Promise<void> {
		const config = vscode.workspace.getConfiguration('buildbyyou');
		const current = this.configService.get().persistSensitiveHistory;
		await config.update('persistSensitiveHistory', !current, vscode.ConfigurationTarget.Global);
		const memoryEnabled = !current;
		this.forEachSurface((surface) => surface.postSystem(
			memoryEnabled
				? 'Chat memory is now on. Recent chats will be saved locally in VS Code.'
				: 'Chat memory is now off. Raw chat history will not be saved locally.',
		));
		await this.persistSessionState();
		await this.persistSensitiveArtifacts();
		if (memoryEnabled) {
			const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
			if (folder && this.session.messages.length > 0) {
				await this.persistRecentConversation(folder);
			}
		}
		await this.refreshState();
	}

	public async handleInterruptTurn(): Promise<void> {
		if (!this.isBusy) {
			return;
		}

		this.activeClient?.abortActiveRequest();
	}

	public async handleBuildNewSite(): Promise<void> {
		const siteArchetype = await vscode.window.showQuickPick([
			{
				label: 'Marketing Site',
				description: 'Landing pages, product messaging, lead capture',
				detail: 'Best for brands, SaaS marketing, startups, and product launches.',
				value: 'marketing site',
			},
			{
				label: 'Dashboard',
				description: 'Authenticated app, data views, admin surfaces',
				detail: 'Best for SaaS products, internal tools, and analytics apps.',
				value: 'dashboard web app',
			},
			{
				label: 'Portfolio',
				description: 'Personal brand, case studies, resume-style site',
				detail: 'Best for creators, developers, designers, and agencies.',
				value: 'portfolio site',
			},
			{
				label: 'Blog',
				description: 'Publishing-focused content site',
				detail: 'Best for editorial content, newsletters, and SEO-heavy sites.',
				value: 'blog or content site',
			},
			{
				label: 'Ecommerce',
				description: 'Storefront, catalog, product pages, checkout flow',
				detail: 'Best for product sales and online commerce experiences.',
				value: 'ecommerce storefront',
			},
			{
				label: 'Docs Site',
				description: 'Documentation, guides, developer portal',
				detail: 'Best for product docs, SDK guides, and knowledge bases.',
				value: 'documentation site',
			},
			{
				label: 'Custom',
				description: 'Something else',
				detail: 'Use a fully custom site description.',
				value: '',
			},
		], {
			title: 'Build New Site',
			placeHolder: 'Choose the kind of site you want to build',
			ignoreFocusOut: true,
		});

		if (!siteArchetype) {
			return;
		}

		const siteType = await vscode.window.showInputBox({
			title: 'Build New Site',
			prompt: 'What kind of site would you like to build?',
			value: siteArchetype.value,
			placeHolder: 'Example: marketing site, SaaS dashboard, portfolio, ecommerce storefront',
			ignoreFocusOut: true,
			validateInput: (input) => input.trim() ? undefined : 'A site description is required.',
		});

		if (!siteType) {
			return;
		}

		const stackHint = await vscode.window.showQuickPick([
			{
				label: 'Recommend For Me',
				description: 'Let Grok choose the stack',
				detail: 'Best when you know the site style but not the stack.',
				value: 'IDK',
			},
			{
				label: 'Next.js',
				description: 'React full-stack framework',
				detail: 'Strong default for modern web apps and marketing sites.',
				value: 'Next.js',
			},
			{
				label: 'Astro',
				description: 'Content and performance focused',
				detail: 'Great for marketing sites, blogs, and docs.',
				value: 'Astro',
			},
			{
				label: 'Vite + React',
				description: 'Lightweight SPA setup',
				detail: 'Good for dashboards and front-end apps.',
				value: 'Vite + React',
			},
			{
				label: 'Nuxt',
				description: 'Vue full-stack framework',
				detail: 'Good if you want a Vue-based product or site.',
				value: 'Nuxt',
			},
			{
				label: 'Custom',
				description: 'Enter a different stack',
				detail: 'Use your own preferred stack.',
				value: '',
			},
		], {
			title: 'Build New Site',
			placeHolder: 'Choose a stack direction or let Grok recommend one',
			ignoreFocusOut: true,
		});

		if (!stackHint) {
			return;
		}

		const techStack = await vscode.window.showInputBox({
			title: 'Build New Site',
			prompt: 'What tech stack would you like to use? Enter IDK if you want Grok to recommend one.',
			value: stackHint.value,
			placeHolder: 'Example: Next.js + Tailwind + Supabase, Astro, plain React, or IDK',
			ignoreFocusOut: true,
		});

		if (techStack === undefined) {
			return;
		}

		const normalizedStack = techStack.trim() || 'IDK';
		const prompt = [
			'Build a new website project in this workspace.',
			`Website type/style request: ${siteType.trim()}`,
			`Requested tech stack: ${normalizedStack}`,
			normalizedStack.toLowerCase() === 'idk'
				? 'The user does not know the stack. Pick a practical stack for the request and proceed.'
				: 'Use the requested stack unless there is a concrete blocker, and if so explain the best alternative briefly before proceeding.',
			'Follow the user request directly.',
			'Avoid interactive scaffolders that can stop for package-name, install, theme, or start-now prompts. If needed, create the project files directly.',
			'Create the project structure, core files, and initial implementation inside the current workspace.',
		].join('\n');

		await this.handlePrompt(prompt);
	}

	public async handleOpenPopout(): Promise<void> {
		await this.openPanel();
	}

	public async handleFactoryReset(): Promise<void> {
		const choice = await vscode.window.showWarningMessage(
			'Factory reset Build by You for this workspace? This clears chat history, task history, timeline, workflow state, terminal history, and selected workspace state.',
			{ modal: true },
			'Reset Workspace State',
			'Reset + Clear API Key',
		);

		if (!choice) {
			return;
		}

		this.terminalSessionService.clearAll();
		this.timeline.length = 0;
		this.taskHistory.length = 0;
		await this.sessionStoreService.clear();
		this.session.selectedWorkspace = undefined;
		this.session.messages = [];
		this.session.executionMode = 'verify';
		this.session.lastWorkflow = undefined;

		if (choice === 'Reset + Clear API Key') {
			await this.secretService.clearApiKey();
		}

		this.forEachSurface((surface) => {
			surface.clearAll();
			surface.postSystem(choice === 'Reset + Clear API Key'
				? 'Build by You workspace state and stored xAI API key were cleared.'
				: 'Build by You workspace state was cleared.');
			surface.setStatus('Ready.');
		});
		await this.refreshState();
	}

	public async handleSelectWorkspace(): Promise<void> {
		const folder = await this.workspaceContextService.pickWorkspaceFolder();
		if (!folder) {
			void vscode.window.showWarningMessage('No workspace folder selected.');
			return;
		}

		this.session.selectedWorkspace = folder.uri;
		await this.persistSessionState();
		this.forEachSurface((surface) => surface.postSystem(`Selected workspace folder: ${folder.name}`));
		await this.refreshState();
	}

	public async handleVerifyWorkspace(): Promise<void> {
		await this.runVerificationWorkflow(false);
	}

	public async handleRepairWorkspace(): Promise<void> {
		await this.runVerificationWorkflow(true);
	}

	public async handleSecurityAudit(): Promise<void> {
		await this.runSecurityAuditWorkflow();
	}

	public async handleRerunLastWorkflow(): Promise<void> {
		if (!this.session.lastWorkflow) {
			this.forEachSurface((surface) => surface.postSystem('No previous workflow run is available to rerun.'));
			return;
		}

		if (this.session.lastWorkflow.mode === 'repair') {
			await this.handleRepairWorkspace();
			return;
		}

		if (this.session.lastWorkflow.mode === 'security') {
			await this.handleSecurityAudit();
			return;
		}

		await this.handleVerifyWorkspace();
	}

	public async handleShowLastFailure(): Promise<void> {
		const lastWorkflow = this.session.lastWorkflow;
		if (!lastWorkflow || lastWorkflow.status !== 'failed') {
			this.forEachSurface((surface) => surface.postSystem('No failed workflow result is available.'));
			return;
		}

		this.forEachSurface((surface) => surface.postSystem([
			`${this.workflowModeLabel(lastWorkflow.mode)} failed: ${lastWorkflow.label}`,
			lastWorkflow.command ? `Command: ${lastWorkflow.command}` : '',
			`Summary: ${lastWorkflow.detail}`,
			lastWorkflow.output || 'No captured output available.',
		].filter(Boolean).join('\n\n')));
	}

	public async handleStartDevServer(): Promise<void> {
		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!folder) {
			return;
		}

		if (this.terminalSessionService.isPersistentCommandRunning(folder)) {
			this.forEachSurface((surface) => surface.postSystem('A dev server is already running for this workspace.'));
			await this.refreshState();
			return;
		}

		const presets = await this.taskPresetService.getDevPresets(folder, this.configService.get().taskPresets);
		if (presets.length === 0) {
			this.forEachSurface((surface) => surface.postSystem('No dev-server preset found. Add a `dev`, `start`, `serve`, or `preview` script, or configure `buildbyyou.taskPresets`.'));
			return;
		}

		const preferredPreset = presets.find((item) => item.name.toLowerCase() === 'dev');
		const preset = preferredPreset
			?? (presets.length === 1
				? presets[0]
				: await vscode.window.showQuickPick(
				presets.map((item) => ({
					label: item.name,
					description: item.command,
					detail: item.description,
					preset: item,
				})),
				{
					title: 'Select a dev server command',
					placeHolder: 'Choose the command to launch for local preview',
				},
			).then((selection) => selection?.preset));

		if (!preset) {
			return;
		}

		const command = preset.command;
		const selectedPreviewPath = await this.selectPreviewPathIfNeeded(preset);
		if (preset.previewChoices && preset.previewChoices.length > 1 && !selectedPreviewPath) {
			return;
		}

		const ready = await this.ensureDevPresetDependencies(folder, command);
		if (!ready) {
			await this.refreshState();
			return;
		}

		this.previewPanel = PreviewPanel.createOrShow({
			command,
			workspaceLabel: folder.name,
		});
		this.previewPanel.showWaiting(command, folder.name);
		this.terminalSessionService.clearPreviewUrl(folder);

		this.appendTimeline({
			id: `dev-${Date.now()}`,
			turnId: `dev-${Date.now()}`,
			kind: 'command',
			title: `Start dev server: ${command}`,
			detail: preferredPreset
				? `${preset.description ?? ''}\nAuto-selected the \`dev\` script because it is the safest default for first-run local preview.`.trim()
				: preset.description,
			timestamp: new Date().toISOString(),
		});
		const taskId = this.startTaskRun('dev', preset.name, command);
		let previewResolved = false;
		const resolvePreview = async (previewUrl: string): Promise<void> => {
			if (previewResolved) {
				return;
			}

			previewResolved = true;
			const resolvedPreviewUrl = this.previewUrlWithPath(previewUrl, selectedPreviewPath ?? preset.previewPath);
			this.terminalSessionService.rememberPreviewUrl(folder, resolvedPreviewUrl);
			this.previewPanel ??= PreviewPanel.createOrShow({
				url: resolvedPreviewUrl,
				workspaceLabel: folder.name,
			});
			this.previewPanel.showPreview(resolvedPreviewUrl, folder.name);
			await this.finishTaskRun(taskId, 'passed', `Preview detected at ${resolvedPreviewUrl}.`, resolvedPreviewUrl);
			await this.refreshState();
		};
		await this.terminalSessionService.startPersistentCommand(
			folder,
			command,
			(chunk) => {
				const text = summarizeTerminalOutput(sanitizeTerminalChunk(chunk), 1200);
				if (text) {
					this.appendTimeline({
						id: `dev-output-${Date.now()}-${Math.random()}`,
						turnId: taskId,
						kind: 'command',
						title: 'Dev server output',
						detail: text,
						timestamp: new Date().toISOString(),
					});
				}
				},
				async (previewUrl) => resolvePreview(previewUrl),
				async () => {
					await this.refreshState();
				},
			);
		void this.detectPreviewUrlFallback(folder, command, selectedPreviewPath ?? preset.previewPath)
			.then(async (previewUrl) => {
				if (previewUrl) {
					await resolvePreview(previewUrl);
				}
			})
			.catch(() => undefined);
		await this.refreshState();
	}

	public async handleStopDevServer(): Promise<void> {
		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!folder) {
			return;
		}

		const stopped = this.terminalSessionService.stopPersistentCommand(folder);
		if (!stopped) {
			this.forEachSurface((surface) => surface.postSystem('No tracked dev-server terminal is available for this workspace.'));
			await this.refreshState();
			return;
		}
		this.terminalSessionService.clearPreviewUrl(folder);
		this.previewPanel?.showWaiting(this.terminalSessionService.getLatestDevCommand(folder), folder.name);

		this.appendTimeline({
			id: `dev-stop-${Date.now()}`,
			turnId: `dev-stop-${Date.now()}`,
			kind: 'command',
			title: 'Stopped dev server',
			detail: this.terminalSessionService.getLatestDevCommand(folder),
			timestamp: new Date().toISOString(),
		});
		await this.refreshState();
	}

	private async handleStreamlitSlashCommand(arg: string): Promise<void> {
		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!folder) {
			this.forEachSurface((surface) => surface.postSystem('Open a workspace folder before using /streamlit.'));
			return;
		}

		if (this.terminalSessionService.isPersistentCommandRunning(folder)) {
			this.forEachSurface((surface) => surface.postSystem('A local server is already running for this workspace. Stop it before starting Streamlit.'));
			await this.refreshState();
			return;
		}

		const appPath = arg
			? this.stripOuterQuotes(arg)
			: await this.pickStreamlitApp(folder);
		if (!appPath) {
			this.forEachSurface((surface) => surface.postSystem('Usage: /streamlit <path-to-app.py> or /st <path-to-app.py>'));
			return;
		}

		const resolvedApp = this.resolveWorkspaceRelativePath(folder, appPath);
		if (!resolvedApp) {
			this.forEachSurface((surface) => surface.postSystem(`Streamlit app path is outside this workspace: ${appPath}`));
			return;
		}

		try {
			const stat = await fs.stat(resolvedApp.absolutePath);
			if (!stat.isFile() || !/\.py$/i.test(resolvedApp.relativePath)) {
				this.forEachSurface((surface) => surface.postSystem(`Streamlit app must be a Python file: ${resolvedApp.relativePath}`));
				return;
			}
		} catch {
			this.forEachSurface((surface) => surface.postSystem(`Streamlit app not found: ${resolvedApp.relativePath}`));
			return;
		}

		const source = await fs.readFile(resolvedApp.absolutePath, 'utf8').catch(() => '');
		if (!/^\s*(?:import\s+streamlit\b|from\s+streamlit\b)/m.test(source.slice(0, 50000))) {
			this.forEachSurface((surface) => surface.postSystem(`That file does not appear to import Streamlit: ${resolvedApp.relativePath}`));
			return;
		}

		const pythonCommand = await this.detectWorkspacePythonCommand(folder);
		const ready = await this.ensureStreamlitInstalled(folder, pythonCommand);
		if (!ready) {
			await this.refreshState();
			return;
		}

		const command = `${pythonCommand} -m streamlit run ${this.shellQuote(resolvedApp.relativePath)} --server.address 127.0.0.1 --server.headless true`;
		await this.startPreviewServer(folder, command, 'streamlit', `Start Streamlit app: ${resolvedApp.relativePath}`);
	}

	private async pickStreamlitApp(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
		const apps = await this.findStreamlitApps(folder.uri.fsPath);
		if (apps.length === 0) {
			return undefined;
		}
		if (apps.length === 1) {
			return apps[0].path;
		}

		const selection = await vscode.window.showQuickPick(
			apps.map((app) => ({
				label: path.basename(app.path),
				description: path.dirname(app.path) === '.' ? 'workspace root' : path.dirname(app.path),
				detail: [
					`${Math.max(1, Math.round(app.size / 1024))} KB`,
					`modified ${new Date(app.mtimeMs).toLocaleString()}`,
				].join(' • '),
				path: app.path,
			})),
			{
				title: 'Choose Streamlit app',
				placeHolder: 'Multiple Streamlit files found. Pick the app to run.',
			},
		);
		return selection?.path;
	}

	private async findStreamlitApps(root: string): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
		const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.build-by-you']);
		const candidates: Array<{ path: string; mtimeMs: number; size: number }> = [];

		const visit = async (dir: string, depth: number): Promise<void> => {
			if (depth > 6 || candidates.length > 500) {
				return;
			}

			let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}

			for (const entry of entries) {
				if (ignored.has(entry.name)) {
					continue;
				}

				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					await visit(fullPath, depth + 1);
					continue;
				}

				if (!entry.isFile() || !/\.py$/i.test(entry.name)) {
					continue;
				}

				try {
					const content = await fs.readFile(fullPath, 'utf8');
					if (!/^\s*(?:import\s+streamlit\b|from\s+streamlit\b)/m.test(content.slice(0, 50000))) {
						continue;
					}
					const stat = await fs.stat(fullPath);
					candidates.push({
						path: path.relative(root, fullPath).split(path.sep).join('/'),
						mtimeMs: stat.mtimeMs,
						size: stat.size,
					});
				} catch {
					// Ignore files that disappear or are not readable as text.
				}
			}
		};

		await visit(root, 0);
		candidates.sort((a, b) => this.streamlitAppRank(a.path) - this.streamlitAppRank(b.path) || b.mtimeMs - a.mtimeMs);
		return candidates;
	}

	private streamlitAppRank(relativePath: string): number {
		const basename = path.basename(relativePath).toLowerCase();
		if (basename === 'app.py' || basename === 'streamlit_app.py') {
			return 0;
		}
		if (/\bapp\b|_app\b|\blab\b|\bdashboard\b/i.test(basename)) {
			return 1;
		}
		return 2;
	}

	private async ensureStreamlitInstalled(folder: vscode.WorkspaceFolder, pythonCommand: string): Promise<boolean> {
		const importCheck = await this.commandExecutionService.run(folder, `${pythonCommand} -c "import streamlit"`, 30000);
		if (importCheck.exitCode === 0) {
			return true;
		}

		const requirementsPath = path.join(folder.uri.fsPath, 'requirements.txt');
		const requirements = await fs.readFile(requirementsPath, 'utf8').catch(() => '');
		const installCommand = /\bstreamlit\b/i.test(requirements)
			? `${pythonCommand} -m pip install -r requirements.txt`
			: `${pythonCommand} -m pip install streamlit`;
		this.forEachSurface((surface) => surface.postSystem(`Streamlit is not installed in this workspace Python environment. Running \`${installCommand}\`.`));
		const install = await this.commandExecutionService.run(folder, installCommand, 180000, (chunk) => {
			const text = summarizeTerminalOutput(sanitizeTerminalChunk(chunk), 1200);
			if (text) {
				this.appendTimeline({
					id: `streamlit-install-${Date.now()}-${Math.random()}`,
					turnId: `streamlit-install-${Date.now()}`,
					kind: 'command',
					title: 'Streamlit install output',
					detail: text,
					timestamp: new Date().toISOString(),
				});
			}
		});

		if (install.exitCode !== 0) {
			this.forEachSurface((surface) => surface.postSystem([
				`Could not install Streamlit automatically. Command: \`${installCommand}\``,
				install.stderr || install.stdout || 'No output captured.',
			].join('\n\n')));
			return false;
		}

		const verify = await this.commandExecutionService.run(folder, `${pythonCommand} -c "import streamlit"`, 30000);
		if (verify.exitCode !== 0) {
			this.forEachSurface((surface) => surface.postSystem('Streamlit install completed, but `import streamlit` still failed in the workspace Python environment.'));
			return false;
		}
		return true;
	}

	private async startPreviewServer(folder: vscode.WorkspaceFolder, command: string, label: string, detail?: string): Promise<void> {
		this.previewPanel = PreviewPanel.createOrShow({
			command,
			workspaceLabel: folder.name,
		});
		this.previewPanel.showWaiting(command, folder.name);
		this.terminalSessionService.clearPreviewUrl(folder);

		this.appendTimeline({
			id: `dev-${Date.now()}`,
			turnId: `dev-${Date.now()}`,
			kind: 'command',
			title: `Start dev server: ${command}`,
			detail,
			timestamp: new Date().toISOString(),
		});
		const taskId = this.startTaskRun('dev', label, command);
		let previewResolved = false;
		const resolvePreview = async (previewUrl: string): Promise<void> => {
			if (previewResolved) {
				return;
			}

			previewResolved = true;
			this.terminalSessionService.rememberPreviewUrl(folder, previewUrl);
			this.previewPanel ??= PreviewPanel.createOrShow({
				url: previewUrl,
				workspaceLabel: folder.name,
			});
			this.previewPanel.showPreview(previewUrl, folder.name);
			await this.finishTaskRun(taskId, 'passed', `Preview detected at ${previewUrl}.`, previewUrl);
			await this.refreshState();
		};

		await this.terminalSessionService.startPersistentCommand(
			folder,
			command,
			(chunk) => {
				const text = summarizeTerminalOutput(sanitizeTerminalChunk(chunk), 1200);
				if (text) {
					this.appendTimeline({
						id: `dev-output-${Date.now()}-${Math.random()}`,
						turnId: taskId,
						kind: 'command',
						title: 'Dev server output',
						detail: text,
						timestamp: new Date().toISOString(),
					});
				}
			},
			async (previewUrl) => resolvePreview(previewUrl),
			async () => {
				await this.refreshState();
			},
		);
		void this.detectPreviewUrlFallback(folder, command)
			.then(async (previewUrl) => {
				if (previewUrl) {
					await resolvePreview(previewUrl);
				}
			})
			.catch(() => undefined);
		await this.refreshState();
	}

	private async detectWorkspacePythonCommand(folder: vscode.WorkspaceFolder): Promise<string> {
		const root = folder.uri.fsPath;
		const venvPython = process.platform === 'win32'
			? path.join(root, '.venv', 'Scripts', 'python.exe')
			: path.join(root, '.venv', 'bin', 'python');
		try {
			await fs.access(venvPython);
			return this.shellQuote(venvPython);
		} catch {
			return process.platform === 'win32' ? 'python' : 'python3';
		}
	}

	private resolveWorkspaceRelativePath(folder: vscode.WorkspaceFolder, rawPath: string): { absolutePath: string; relativePath: string } | undefined {
		const root = path.resolve(folder.uri.fsPath);
		const absolutePath = path.resolve(root, rawPath);
		if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
			return undefined;
		}
		return {
			absolutePath,
			relativePath: path.relative(root, absolutePath).split(path.sep).join('/'),
		};
	}

	private shellQuote(value: string): string {
		if (process.platform === 'win32') {
			return `"${value.replace(/"/g, '""')}"`;
		}
		return `'${value.replace(/'/g, "'\\''")}'`;
	}

	private async selectPreviewPathIfNeeded(preset: { previewChoices?: Array<{ path: string; mtimeMs?: number; size?: number }> }): Promise<string | undefined> {
		const choices = preset.previewChoices ?? [];
		if (choices.length === 0) {
			return undefined;
		}
		if (choices.length === 1) {
			return choices[0].path;
		}

		const selection = await vscode.window.showQuickPick(
			choices.map((choice) => ({
				label: path.basename(choice.path),
				description: path.dirname(choice.path) === '.' ? 'workspace root' : path.dirname(choice.path),
				detail: [
					choice.size !== undefined ? `${Math.max(1, Math.round(choice.size / 1024))} KB` : '',
					choice.mtimeMs !== undefined ? `modified ${new Date(choice.mtimeMs).toLocaleString()}` : '',
				].filter(Boolean).join(' • '),
				path: choice.path,
			})),
			{
				title: 'Choose HTML file to preview',
				placeHolder: 'Multiple HTML files found. Pick the page to open.',
			},
		);
		return selection?.path;
	}

	public async handleOpenPreview(): Promise<void> {
		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!folder) {
			return;
		}

		const previewUrl = this.terminalSessionService.getLatestPreviewUrl(folder);
		if (!previewUrl) {
			this.previewPanel = PreviewPanel.createOrShow({
				command: this.terminalSessionService.getLatestDevCommand(folder),
				workspaceLabel: folder.name,
			});
			this.previewPanel.showWaiting(this.terminalSessionService.getLatestDevCommand(folder), folder.name);
			return;
		}

		this.previewPanel = PreviewPanel.createOrShow({
			url: previewUrl,
			workspaceLabel: folder.name,
		});
		this.previewPanel.showPreview(previewUrl, folder.name);
		this.appendTimeline({
			id: `preview-${Date.now()}`,
			turnId: `preview-${Date.now()}`,
			kind: 'note',
			title: `Opened preview panel for ${previewUrl}`,
			detail: previewUrl,
			timestamp: new Date().toISOString(),
		});
	}

	public async handleOpenSlideDeck(): Promise<void> {
		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!folder) {
			return;
		}

		const previewUrl = this.terminalSessionService.getLatestPreviewUrl(folder);
		if (previewUrl || this.terminalSessionService.isPersistentCommandRunning(folder)) {
			await this.handleOpenPreview();
			return;
		}

		if (await this.isSlideDeckWorkspace(folder)) {
			await this.handleStartDevServer();
			return;
		}

		this.forEachSurface((surface) => surface.postSystem('No Slidev slide deck detected in this workspace yet.'));
	}

	public async handleOpenTerminal(): Promise<void> {
		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!folder) {
			return;
		}

		this.terminalSessionService.getOrCreate(folder).show(true);
	}

	public async handleOpenSourceControl(): Promise<void> {
		await vscode.commands.executeCommand('workbench.view.scm');
	}

	public async handleOpenSettings(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.openSettings', 'buildbyyou');
	}

	public async handleResetConversation(): Promise<void> {
		this.session.messages = [];
		this.session.lastWorkflow = undefined;
		this.timeline.length = 0;
		this.taskHistory.length = 0;
		await this.persistSessionState();
		await this.persistSensitiveArtifacts();
		this.forEachSurface((surface) => {
			surface.clearAll();
			surface.postSystem('Conversation reset. The selected workspace folder is unchanged.');
		});
		await this.refreshState();
	}

	public async clearApiKey(): Promise<void> {
		await this.secretService.clearApiKey();
		void vscode.window.showInformationMessage('xAI API key cleared for Build by You.');
		await this.refreshState();
	}

	public async handleExecutionModeChange(mode: ExecutionMode): Promise<void> {
		this.session.executionMode = mode;
		if (mode !== 'autonomous') {
			this.sessionApprovedCommands.clear();
		}
		await this.persistSessionState();
		this.forEachSurface((surface) => surface.postSystem(
			mode === 'autonomous'
				? 'Execution mode set to Autonomous Changes. Grok will apply edits and run commands without per-action approval in this session.'
				: 'Execution mode set to Default. Low-risk edits and safe commands can run without prompts; critical files, deletes, sensitive reads, and higher-risk commands still require approval.',
		));
		await this.refreshState();
	}

	private async requestApproval(details: {
		kind: 'write' | 'command' | 'read';
		title: string;
		detail: string;
		command?: string;
		filePath?: string;
		originalContent?: string;
		updatedContent?: string;
	}): Promise<ApprovalResult> {
		if (this.session.executionMode === 'autonomous') {
			if (details.kind === 'command') {
				const config = this.configService.get();
				const blockedPattern = details.command ? matchesBlockedPattern(details.command, config.blockedCommandPatterns) : undefined;
				if (blockedPattern) {
					this.logSecurity(`Blocked autonomous command: ${details.command} [pattern: ${blockedPattern}]`);
					throw new Error(`Blocked command pattern matched: ${blockedPattern}`);
				}

				this.logSecurity(`Full-access auto-approved command: ${details.command}`);
				return { approved: true };
			}

			this.logSecurity(`Full-access auto-approved ${details.kind}: ${details.filePath ?? details.title}`);
			return {
				approved: true,
				updatedContent: details.updatedContent,
				stageFile: this.configService.get().autoStageApprovedChanges,
			};
		}

		if (this.canDefaultModeAutoApprove(details)) {
			this.logSecurity(`Default mode auto-approved ${details.kind}: ${details.command ?? details.filePath ?? details.title}`);
			return {
				approved: true,
				updatedContent: details.updatedContent,
				stageFile: this.configService.get().autoStageApprovedChanges,
			};
		}

		this.forEachSurface((surface) => surface.setStatus(`Waiting for approval: ${details.title}`));
		if (details.kind === 'write' && details.filePath !== undefined && details.originalContent !== undefined && details.updatedContent !== undefined) {
			return this.reviewPatch(details.filePath, details.originalContent, details.updatedContent);
		}

		const warningMessage = details.kind === 'read'
			? `Sensitive file access requested.\n\n${details.title}\n\n${details.detail}`
			: `${details.title}\n\n${details.detail}`;
		const approveLabel = details.kind === 'read' ? 'Allow Read' : 'Approve';
		const choice = await vscode.window.showWarningMessage(
			warningMessage,
			{ modal: true },
			approveLabel,
		);
		this.logSecurity(`${choice === approveLabel ? 'Approved' : 'Denied'} ${details.kind}: ${details.command ?? details.filePath ?? details.title}`);
		return { approved: choice === approveLabel };
	}

	private canDefaultModeAutoApprove(details: {
		kind: 'write' | 'command' | 'read';
		title: string;
		command?: string;
		filePath?: string;
	}): boolean {
		if (details.kind === 'read') {
			return false;
		}

		if (details.kind === 'command') {
			if (!details.command) {
				return false;
			}
			const config = this.configService.get();
			if (matchesBlockedPattern(details.command, config.blockedCommandPatterns)) {
				return false;
			}
			return canAutoApproveCommand(
				details.command,
				'safeOnly',
				config.autonomousAllowedCommands,
				config.safeCommandPrefixes,
			);
		}

		if (!details.filePath || /^delete file$/i.test(details.title)) {
			return false;
		}

		return !this.isCriticalWorkspaceFile(details.filePath);
	}

	private isCriticalWorkspaceFile(relativePath: string): boolean {
		const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
		const basename = path.basename(normalized);
		if (isSensitiveWorkspacePath(normalized)) {
			return true;
		}

		const criticalBasenames = new Set([
			'package.json',
			'package-lock.json',
			'pnpm-lock.yaml',
			'yarn.lock',
			'bun.lockb',
			'tsconfig.json',
			'jsconfig.json',
			'astro.config.mjs',
			'astro.config.js',
			'vite.config.ts',
			'vite.config.js',
			'next.config.js',
			'next.config.mjs',
			'webpack.config.js',
			'rollup.config.js',
			'tailwind.config.js',
			'postcss.config.js',
			'wrangler.toml',
			'vercel.json',
			'dockerfile',
			'docker-compose.yml',
		]);
		if (criticalBasenames.has(basename)) {
			return true;
		}

		return normalized.startsWith('.github/workflows/')
			|| normalized.startsWith('.vscode/')
			|| normalized.startsWith('scripts/')
			|| normalized.startsWith('bin/');
	}

	private async refreshState(): Promise<void> {
		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!this.session.selectedWorkspace && folder) {
			this.session.selectedWorkspace = folder.uri;
		}

		const config = this.configService.get();
		const state = {
			workspaceLabel: folder?.name ?? 'No workspace',
			extensionVersion: this.context.extension.packageJSON.version as string | undefined,
			apiKeyConfigured: await this.secretService.hasApiKey(),
			planModeEnabled: config.enablePlanner,
			executorModel: config.executorModel,
			plannerModel: config.plannerModel,
			recentPrompts: this.session.recentPrompts.slice(0, 3),
			recentConversations: this.sessionStoreService.loadRecentConversations(),
			executionMode: this.session.executionMode,
			persistSensitiveHistory: config.persistSensitiveHistory,
			autonomousCommandPolicy: config.autonomousCommandPolicy,
			previewUrl: folder ? this.terminalSessionService.getLatestPreviewUrl(folder) : undefined,
			lastDevCommand: folder ? this.terminalSessionService.getLatestDevCommand(folder) : undefined,
			devServerRunning: folder ? this.terminalSessionService.isPersistentCommandRunning(folder) : false,
			workflowTitle: this.session.lastWorkflow
				? `${this.workflowModeLabel(this.session.lastWorkflow.mode)} ${this.session.lastWorkflow.status.toUpperCase()}`
				: undefined,
			workflowDetail: this.session.lastWorkflow
				? `${this.session.lastWorkflow.label}: ${this.session.lastWorkflow.detail}`
				: undefined,
			workflowCommand: this.session.lastWorkflow?.command,
			workflowOutputPreview: this.session.lastWorkflow?.output
				? this.session.lastWorkflow.output.slice(0, 1200)
				: undefined,
			workflowStatus: this.session.lastWorkflow?.status,
		};
		this.panel?.setTitle(`Build by You${state.workspaceLabel ? ` - ${state.workspaceLabel}` : ''}`);
		this.forEachSurface((surface) => surface.setState(state));
	}

	private replayState(): void {
		this.forEachSurface((surface) => {
			surface.clearAll();
			if (this.session.messages.length === 0) {
				surface.postSystem('Build by You is ready. Set your xAI API key, then ask it to inspect, edit, or test the current workspace folder.');
			}

			for (const message of this.session.messages) {
				if (message.role === 'user') {
					surface.postUser(message.text);
				} else {
					if (message.trace) {
						const traceLines = message.trace.text
							.split('\n')
							.map((line) => line.trim())
							.filter(Boolean);
						surface.postAssistant(this.formatThinkingMessage(traceLines));
					}
					surface.postAssistant(message.text);
				}
			}
		});
	}

	private appendTimeline(entry: TimelineEntry): void {
		this.timeline.push(entry);
		this.timeline.splice(0, Math.max(0, this.timeline.length - 200));
		void this.persistSensitiveArtifacts();
	}

	private currentWorkspaceLabel(): string {
		return this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace)?.name ?? '';
	}

	private forEachSurface(fn: (surface: ChatSurface) => void): void {
		const surfaces: ChatSurface[] = [];
		if (this.panel) {
			surfaces.push(this.panel.getSurface());
		}

		const sidebarSurface = this.sidebarProvider.getSurface();
		if (sidebarSurface) {
			surfaces.push(sidebarSurface);
		}

		for (const surface of surfaces) {
			fn(surface);
		}
	}

	private async reviewPatch(filePath: string, originalContent: string, updatedContent: string): Promise<ApprovalResult> {
		const selectedContent = await this.selectApprovedHunks(filePath, originalContent, updatedContent);
		if (selectedContent === undefined) {
			return { approved: false };
		}

		const choice = await vscode.window.showWarningMessage(
			`Apply reviewed changes for ${filePath}?`,
			{ modal: true },
			'Apply',
			'Apply + Stage',
			'Cancel',
		);

		if (choice === 'Apply' || choice === 'Apply + Stage') {
			return {
				approved: true,
				updatedContent: selectedContent,
				stageFile: choice === 'Apply + Stage',
			};
		}

		return { approved: false };
	}

	private async selectApprovedHunks(filePath: string, originalContent: string, updatedContent: string): Promise<string | undefined> {
		const changes = diffLines(originalContent, updatedContent);
		const candidates = changes
			.map((part, index) => ({ part, index }))
			.filter(({ part }) => part.added || part.removed);

		if (candidates.length === 0) {
			return updatedContent;
		}

		const items = candidates.map(({ part, index }) => {
			const prefix = part.added ? '+' : '-';
			const lines = part.value.split('\n').filter(Boolean);
			const preview = lines.slice(0, 4).map((line) => `${prefix} ${line}`).join('\n');
			return {
				label: `Block ${index + 1}`,
				description: `${part.added ? 'added' : 'removed'} ${lines.length} line(s)`,
				detail: preview,
				picked: true,
				index,
			};
		});

		const selection = await vscode.window.showQuickPick(items, {
			canPickMany: true,
			title: `Select change blocks to apply for ${filePath}`,
			placeHolder: 'Selected blocks will be applied. Unselected blocks will be reverted.',
			ignoreFocusOut: true,
		});

		if (selection === undefined) {
			return undefined;
		}

		const selectedIndexes = new Set(selection.map((item) => item.index));
		let output = '';
		for (let index = 0; index < changes.length; index += 1) {
			const part = changes[index];
			if (part.added) {
				if (selectedIndexes.has(index)) {
					output += part.value;
				}
				continue;
			}

			if (part.removed) {
				if (!selectedIndexes.has(index)) {
					output += part.value;
				}
				continue;
			}

			output += part.value;
		}

		return output;
	}

	private async runVerificationWorkflow(withRepair: boolean): Promise<void> {
		if (this.isBusy) {
			return;
		}

		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!folder) {
			return;
		}

		const config = this.configService.get();
		if (withRepair && !await this.secretService.hasApiKey()) {
			this.forEachSurface((surface) => surface.postSystem('Set your xAI API key before running the automated repair loop.'));
			return;
		}
		const presets = await this.taskPresetService.getVerificationPresets(folder, config.taskPresets);
		if (presets.length === 0) {
			this.forEachSurface((surface) => surface.postSystem('No verification presets found. Add compile/build/lint/test scripts or configure `buildbyyou.taskPresets`.'));
			return;
		}

		this.isBusy = true;
		this.forEachSurface((surface) => surface.setBusy(true));
		const workflowTaskId = this.startTaskRun(
			withRepair ? 'repair' : 'verify',
			withRepair ? 'Repair workflow' : 'Verify workflow',
			presets.map((preset) => preset.command).join(' && '),
		);
		await this.updateWorkflowState({
			mode: withRepair ? 'repair' : 'verify',
			status: 'running',
			label: 'Preparing workflow',
			detail: `Queued ${presets.length} verification command${presets.length === 1 ? '' : 's'}.`,
		});
		try {
			for (const preset of presets) {
				const firstResult = await this.runVerificationCommand(
					folder,
					preset.name,
					preset.command,
					withRepair ? 'repair' : 'verify',
				);
				if (firstResult.succeeded) {
					continue;
				}

				if (withRepair) {
					const repaired = await this.runRepairLoopForPreset(folder, firstResult, config.maxRepairIterations);
					if (!repaired) {
						await this.finishTaskRun(workflowTaskId, 'failed', firstResult.diagnosis, firstResult.output);
						break;
					}
					continue;
				}

				const shouldRepair = await this.offerRepairAfterFailure(firstResult);
				if (shouldRepair) {
					const repaired = await this.runRepairLoopForPreset(folder, firstResult, config.maxRepairIterations);
					if (!repaired) {
						await this.finishTaskRun(workflowTaskId, 'failed', firstResult.diagnosis, firstResult.output);
						break;
					}
					continue;
				}

				if (!firstResult.succeeded) {
					await this.finishTaskRun(workflowTaskId, 'failed', firstResult.diagnosis, firstResult.output);
					break;
				}
			}

			if (this.session.lastWorkflow?.status === 'running') {
				await this.finishTaskRun(workflowTaskId, 'passed', 'All verification commands passed.', '');
				await this.updateWorkflowState({
					mode: withRepair ? 'repair' : 'verify',
					status: 'passed',
					label: 'Workflow complete',
					detail: 'All verification commands passed.',
				});
			}
		} finally {
			this.isBusy = false;
			this.forEachSurface((surface) => surface.setBusy(false));
			await this.refreshState();
		}
	}

	private async runSecurityAuditWorkflow(): Promise<void> {
		if (this.isBusy) {
			return;
		}

		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!folder) {
			return;
		}

		if (!await this.secretService.hasApiKey()) {
			this.forEachSurface((surface) => surface.postSystem('Set your xAI API key before running the security audit.'));
			return;
		}

		this.isBusy = true;
		this.forEachSurface((surface) => surface.setBusy(true));
		const taskId = this.startTaskRun('security', 'Security audit', 'AI-driven repository security audit');
		await this.updateWorkflowState({
			mode: 'security',
			status: 'running',
			label: 'Security audit',
			detail: 'Running AI security specialists against the current workspace.',
			command: 'AI-driven repository security audit',
		});

		try {
			const auditOutput = await this.runInternalAgentTurn(this.buildSecurityAuditPrompt(), `security-audit-${Date.now()}`, 'security');
			const summary = this.summarizeSecurityAudit(auditOutput);
			await this.finishTaskRun(taskId, 'passed', summary, auditOutput);
			await this.updateWorkflowState({
				mode: 'security',
				status: 'passed',
				label: 'Security audit complete',
				detail: summary,
				command: 'AI-driven repository security audit',
				output: auditOutput,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.finishTaskRun(taskId, 'failed', message, message);
			await this.updateWorkflowState({
				mode: 'security',
				status: 'failed',
				label: 'Security audit failed',
				detail: message,
				command: 'AI-driven repository security audit',
				output: message,
			});
			this.forEachSurface((surface) => surface.postSystem(`Security audit failed.\n\n${message}`));
		} finally {
			this.isBusy = false;
			this.forEachSurface((surface) => surface.setBusy(false));
			await this.refreshState();
		}
	}

	private async runVerificationCommand(
		folder: vscode.WorkspaceFolder,
		label: string,
		command: string,
		workflowMode: LastWorkflowState['mode'] = 'verify',
	): Promise<VerificationRunResult> {
		this.appendTimeline({
			id: `verify-${Date.now()}`,
			turnId: `verify-${Date.now()}`,
			kind: 'command',
			title: `Verify ${label}: ${command}`,
			timestamp: new Date().toISOString(),
		});
		this.forEachSurface((surface) => surface.setStatus(`Running ${label}...`));
		const result = await this.commandExecutionService.run(folder, command, this.configService.get().commandTimeoutMs, (chunk) => {
			const text = chunk.trim();
			if (text) {
				this.appendTimeline({
					id: `verify-output-${Date.now()}-${Math.random()}`,
					turnId: `verify-${Date.now()}`,
					kind: 'command',
					title: `${label} output`,
					detail: text,
					timestamp: new Date().toISOString(),
				});
			}
		});
		const output = result.stderr || result.stdout || 'No output captured.';
		const diagnosis = this.summarizeFailure(label, command, output, result.exitCode);

		if (result.exitCode === 0) {
			this.forEachSurface((surface) => surface.postSystem(`Verification passed: ${label}`));
			this.forEachSurface((surface) => surface.setStatus(`Passed: ${label}`));
			void this.updateWorkflowState({
				mode: workflowMode,
				status: 'passed',
				label,
				detail: `Passed: ${command}`,
				command,
				output,
			});
			return {
				label,
				command,
				exitCode: 0,
				output,
				diagnosis: 'Command passed.',
				succeeded: true,
			};
		}

		this.forEachSurface((surface) => surface.postSystem([
			`Verification failed: ${label}`,
			`Command: ${command}`,
			`Summary: ${diagnosis}`,
			output,
		].join('\n\n')));
		this.forEachSurface((surface) => surface.setStatus(`Failed: ${label}`));
		void this.updateWorkflowState({
			mode: workflowMode,
			status: 'failed',
			label,
			detail: diagnosis,
			command,
			output,
		});
		return {
			label,
			command,
			exitCode: result.exitCode,
			output,
			diagnosis,
			succeeded: false,
		};
	}

	private async runRepairLoopForPreset(folder: vscode.WorkspaceFolder, initialFailure: VerificationRunResult, maxAttempts: number): Promise<boolean> {
		let currentFailure = initialFailure;
		const seenFingerprints = new Set<string>();

		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			const fingerprint = this.failureFingerprint(currentFailure);
			if (seenFingerprints.has(fingerprint)) {
				this.forEachSurface((surface) => surface.postSystem(
					`Repair loop stopped early for ${currentFailure.label} because the failure repeated without changing.`,
				));
				await this.updateWorkflowState({
					mode: 'repair',
					status: 'failed',
					label: currentFailure.label,
					detail: `Repeated failure: ${currentFailure.diagnosis}`,
					command: currentFailure.command,
					output: currentFailure.output,
				});
				return false;
			}
			seenFingerprints.add(fingerprint);

			this.forEachSurface((surface) => surface.postSystem(`Repair attempt ${attempt} for ${currentFailure.label}...`));
			await this.updateWorkflowState({
				mode: 'repair',
				status: 'running',
				label: currentFailure.label,
				detail: `Attempt ${attempt} of ${maxAttempts}. ${currentFailure.diagnosis}`,
				command: currentFailure.command,
				output: currentFailure.output,
			});
			await this.runInternalAgentTurn(this.buildRepairPrompt(currentFailure, attempt, maxAttempts), `repair-${currentFailure.label}-${attempt}`);

			const rerunResult = await this.runVerificationCommand(folder, currentFailure.label, currentFailure.command, 'repair');
			if (rerunResult.succeeded) {
				await this.updateWorkflowState({
					mode: 'repair',
					status: 'passed',
					label: currentFailure.label,
					detail: `Recovered after attempt ${attempt}.`,
					command: currentFailure.command,
					output: rerunResult.output,
				});
				return true;
			}

			currentFailure = rerunResult;
		}

		this.forEachSurface((surface) => surface.postSystem(`Repair loop stopped after ${maxAttempts} attempt(s) for ${initialFailure.label}.`));
		await this.updateWorkflowState({
			mode: 'repair',
			status: 'failed',
			label: initialFailure.label,
			detail: `Stopped after ${maxAttempts} attempt(s). Last failure: ${currentFailure.diagnosis}`,
			command: currentFailure.command,
			output: currentFailure.output,
		});
		return false;
	}

	private async runInternalAgentTurn(prompt: string, turnLabel: string, agentMode: 'default' | 'security' = 'default'): Promise<string> {
		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!folder) {
			return '';
		}

		const apiKey = await this.secretService.getApiKey();
		if (!apiKey) {
			return '';
		}

		const config = this.configService.get();
		const client = new XaiClient(apiKey, config.baseUrl);
		const summary = await this.workspaceContextService.buildSummary(folder);
		const assistantMessageId = `assistant-${Date.now()}`;
		let assistantText = '';
		let reasoningText = '';
		let latestStatus = `Running ${turnLabel}...`;
		const renderAssistantProgress = (): void => {
			if (assistantText.trim()) {
				this.forEachSurface((surface) => surface.updateAssistant(assistantText, assistantMessageId));
				return;
			}

			const lines = ['Working on it...'];
			if (reasoningText.trim()) {
				lines.push('', ...this.buildReasoningPreviewLines(reasoningText));
			} else if (latestStatus.trim()) {
				lines.push('', latestStatus.trim());
			}
			this.forEachSurface((surface) => surface.updateAssistant(lines.join('\n'), assistantMessageId));
		};
		this.forEachSurface((surface) => {
			surface.postAssistant(`Working on it...\n\n${latestStatus}`, assistantMessageId);
			surface.setStatus(latestStatus);
		});
		this.lastLiveThought = '';
		assistantText = await this.grokAgentService.runTurn({
			client,
			config,
			folder,
			history: this.session.messages,
			userPrompt: prompt,
			agentMode,
			workspaceSummary: summary,
			onStatus: (message) => {
				latestStatus = message;
				this.forEachSurface((surface) => surface.setStatus(message));
				renderAssistantProgress();
			},
			onTextDelta: (delta) => {
				assistantText += delta;
				renderAssistantProgress();
			},
			onReasoningDelta: (delta) => {
				reasoningText += delta;
				renderAssistantProgress();
			},
			onEvent: (message) => {
				this.logSecurity(`Agent event: ${message}`);
				const liveThought = this.summarizeAgentEvent(message);
				if (liveThought && liveThought !== this.lastLiveThought) {
					this.lastLiveThought = liveThought;
					this.forEachSurface((surface) => surface.appendLog(liveThought));
				}
				this.appendTimeline({
					id: `${turnLabel}-${Date.now()}-${Math.random()}`,
					turnId: turnLabel,
					kind: message.startsWith('git ') ? 'git' : message.startsWith('terminal ') ? 'command' : 'tool',
					title: message.split('\n')[0],
					detail: message,
					timestamp: new Date().toISOString(),
				});
			},
			requestApproval: async (details) => this.requestApproval(details),
			terminalSessionService: this.terminalSessionService,
			gitService: this.gitService,
		});
		const finalAssistantText = await this.appendDiffReport(folder, assistantText);
		this.session.messages.push({ role: 'assistant', text: finalAssistantText });
		await this.persistSessionState();
		this.forEachSurface((surface) => surface.updateAssistant(finalAssistantText || 'No agent response returned.', assistantMessageId));
		return finalAssistantText;
	}

	private async offerRepairAfterFailure(result: VerificationRunResult): Promise<boolean> {
		if (!await this.secretService.hasApiKey()) {
			return false;
		}

		const choice = await vscode.window.showInformationMessage(
			`Verification failed for ${result.label}. Run Grok repair now?`,
			'Run Repair',
			'Not Now',
		);
		return choice === 'Run Repair';
	}

	private buildRepairPrompt(result: VerificationRunResult, attempt: number, maxAttempts: number): string {
		return [
			'The verification command failed and must be repaired.',
			`Verification target: ${result.label}`,
			`Command: ${result.command}`,
			`Attempt: ${attempt} of ${maxAttempts}`,
			`Exit code: ${result.exitCode}`,
			`Failure summary: ${result.diagnosis}`,
			'Fix the repository so this command succeeds when rerun.',
			'Inspect relevant files and make the direct fix.',
			'If the failure is environmental or cannot be fixed safely, explain the blocker clearly.',
			'',
			'Failure output:',
			result.output,
		].join('\n');
	}

	private buildSecurityAuditPrompt(): string {
		return [
			'Perform a security audit of the current repository.',
			'Act like a specialized application security review team, not a generic coding assistant.',
			'Focus on real risks with concrete evidence from the codebase.',
			'Prioritize findings by severity and exploitability.',
			'Inspect source code, package and dependency manifests, build/deploy config, CI/CD workflows, environment handling, API routes, serverless functions, frontend trust boundaries, file upload and media handling, database or storage access, CORS and security headers, logging and PII handling, and third-party integrations when those files exist.',
			'Check for authentication and authorization flaws, session and cookie weaknesses, token handling issues, input validation problems, injection risks, XSS, CSRF, SSRF, insecure deserialization, path traversal, secrets exposure, weak crypto, unsafe shell execution, permission model issues, dependency and supply-chain risks, missing rate limits, dangerous configuration defaults, and insecure deployment settings.',
			'Review extension-specific concerns too, including command execution, workspace trust boundaries, secret handling, webview CSP, URI handling, and persistence of sensitive data.',
			'State coverage gaps clearly when a category cannot be verified from the repository contents. Do not imply that uninspected systems were checked.',
			'Do not make code changes during this audit.',
			'Produce a concise audit report with these sections:',
			'1. Overall rating from 1-10.',
			'2. Findings ordered by severity with file references.',
			'3. Coverage checked and coverage gaps.',
			'4. Notable strengths.',
			'5. Recommended remediations.',
			'If there are no material findings in a category, say so instead of inventing issues.',
		].join('\n');
	}

	private summarizeSecurityAudit(output: string): string {
		const compact = output.replace(/\s+/g, ' ').trim();
		return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact || 'Security audit completed.';
	}

	private workflowModeLabel(mode: LastWorkflowState['mode']): string {
		switch (mode) {
			case 'repair':
				return 'Repair';
			case 'security':
				return 'Security Audit';
			default:
				return 'Verify';
		}
	}

	private failureFingerprint(result: VerificationRunResult): string {
		return [
			result.label,
			result.command,
			String(result.exitCode),
			result.output
				.toLowerCase()
				.replace(/\d{1,2}:\d{2}:\d{2}(?:\s?[ap]m)?/g, '<time>')
				.replace(/\b\d+\b/g, '<n>')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 1200),
		].join('::');
	}

	private parseSlideDeckRequest(arg: string): { prompt: string; format?: 'slidev' | 'marp'; deployTarget?: 'vercel' } {
		const trimmed = arg.trim();
		if (!trimmed) {
			return { prompt: '' };
		}

		const tokens = trimmed.split(/\s+/).filter(Boolean);
		let format: 'slidev' | 'marp' | undefined;
		let deployTarget: 'vercel' | undefined;
		let index = 0;

		while (index < tokens.length) {
			const token = tokens[index].toLowerCase();
			if (token === '--slidev' || token === 'slidev') {
				format = 'slidev';
				index += 1;
				continue;
			}
			if (token === '--marp' || token === 'marp') {
				format = 'marp';
				index += 1;
				continue;
			}
			if (token === '--vercel' || token === 'vercel') {
				deployTarget = 'vercel';
				index += 1;
				continue;
			}
			break;
		}

		const prompt = tokens.slice(index).join(' ').trim();
		return { prompt, format, deployTarget };
	}

	private async handleBabelFishImage(sceneHint: string): Promise<void> {
		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!folder) {
			void vscode.window.showWarningMessage('Open a folder or workspace before using this easter egg.');
			return;
		}

		const apiKey = await this.secretService.getApiKey();
		if (!apiKey) {
			void vscode.window.showWarningMessage('Set your xAI API key before using this easter egg.');
			await this.handleSetApiKey();
			return;
		}

		const config = this.configService.get();
		const client = new XaiClient(apiKey, config.baseUrl);
		const cleanedHint = sceneHint.trim().slice(0, 500);
		const prompt = [
			'Create one original, high-detail Milky Way galaxy reference image as a hidden easter egg for a coding extension.',
			'Use known real astronomy inspiration from our galaxy: dense star fields, nebula-like hydrogen clouds, dust lanes, globular clusters, bright blue-white young stars, red giant stars, exoplanet silhouettes, and a cinematic galactic-core glow.',
			'Include a believable foreground planet or moon silhouette, subtle orbital debris or a tiny distant probe, and layered parallax depth so it feels like a premium space observatory image.',
			'Style: realistic astrophotography meets cinematic sci-fi concept art, 16:9 composition, deep blacks, luminous blues, magentas, amber star glow, high contrast, no text, no logos, no copyrighted characters, no UI elements.',
			'The image should feel like a beautiful random discovery from somewhere inside the Milky Way, not a generic wallpaper.',
			cleanedHint ? `Optional extra user direction: ${cleanedHint}` : '',
		].filter(Boolean).join('\n');

		this.isBusy = true;
		this.activeClient = client;
		this.forEachSurface((surface) => {
			surface.setBusy(true);
			surface.postSystem('Easter egg: generating one original Milky Way image...');
			surface.setStatus('Generating easter egg image...');
		});

		try {
			const image = await client.generateImage({
				model: config.imageModel,
				prompt,
				aspectRatio: '16:9',
				resolution: '1k',
			});
			const extension = this.imageExtensionForBuffer(image);
			if (!extension) {
				throw new Error('Generated easter egg image was not a recognized PNG, JPEG, or WebP file.');
			}

			const outputDir = path.join(folder.uri.fsPath, '.build-by-you', 'images');
			const outputPath = path.join(outputDir, `milky-way-easter-egg-${Date.now()}${extension}`);
			await fs.mkdir(outputDir, { recursive: true });
			await fs.writeFile(outputPath, image);
			const relativePath = path.relative(folder.uri.fsPath, outputPath);
			this.logSecurity(`Generated hidden galaxy easter egg image: ${relativePath}`);
			this.forEachSurface((surface) => {
				surface.postSystem(`Easter egg image created: \`${relativePath}\``);
				surface.setStatus('Easter egg image created.');
			});
			await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(outputPath));
		} catch (error) {
			const message = this.cleanErrorForChat(error instanceof Error ? error.message : String(error));
			this.forEachSurface((surface) => {
				surface.postSystem(`Easter egg image failed: ${message}`);
				surface.setStatus('Easter egg image failed.');
			});
		} finally {
			if (this.activeClient === client) {
				this.activeClient = undefined;
			}
			this.isBusy = false;
			this.forEachSurface((surface) => surface.setBusy(false));
			await this.refreshState();
		}
	}

	private async handleImagineImage(imagePrompt: string, commandName: '/image' | '/imagine'): Promise<void> {
		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!folder) {
			void vscode.window.showWarningMessage('Open a folder or workspace before generating an image.');
			return;
		}

		const prompt = imagePrompt.trim();
		if (!prompt) {
			this.forEachSurface((surface) => surface.postSystem(`Usage: ${commandName} <image prompt>`));
			return;
		}

		const apiKey = await this.secretService.getApiKey();
		if (!apiKey) {
			void vscode.window.showWarningMessage('Set your xAI API key before generating an image.');
			await this.handleSetApiKey();
			return;
		}

		const config = this.configService.get();
		const client = new XaiClient(apiKey, config.baseUrl);

		this.isBusy = true;
		this.activeClient = client;
		this.forEachSurface((surface) => {
			surface.setBusy(true);
			surface.postSystem(`${commandName} rail: generating image with Grok Imagine...`);
			surface.setStatus('Generating image...');
		});

		try {
			const image = await client.generateImage({
				model: config.imageModel,
				prompt,
				aspectRatio: '16:9',
				resolution: '1k',
			});
			const extension = this.imageExtensionForBuffer(image);
			if (!extension) {
				throw new Error('Generated image was not a recognized PNG, JPEG, or WebP file.');
			}

			const outputDir = path.join(folder.uri.fsPath, '.build-by-you', 'images');
			const outputPath = path.join(outputDir, `grok-imagine-${Date.now()}${extension}`);
			await fs.mkdir(outputDir, { recursive: true });
			await fs.writeFile(outputPath, image);
			const relativePath = path.relative(folder.uri.fsPath, outputPath);
			this.logSecurity(`Generated Grok Imagine image: ${relativePath}`);
			this.forEachSurface((surface) => {
				surface.postSystem([
					`Image created: \`${relativePath}\``,
					`Prompt: ${prompt}`,
				].join('\n'));
				surface.setStatus('Image created.');
			});
			await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(outputPath));
		} catch (error) {
			const message = this.cleanErrorForChat(error instanceof Error ? error.message : String(error));
			this.forEachSurface((surface) => {
				surface.postSystem(`${commandName} image failed: ${message}`);
				surface.setStatus('Image generation failed.');
			});
		} finally {
			if (this.activeClient === client) {
				this.activeClient = undefined;
			}
			this.isBusy = false;
			this.forEachSurface((surface) => surface.setBusy(false));
			await this.refreshState();
		}
	}

	private imageExtensionForBuffer(buffer: Buffer): '.png' | '.jpg' | '.webp' | undefined {
		if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
			return '.png';
		}
		if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
			return '.jpg';
		}
		if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
			return '.webp';
		}
		return undefined;
	}

	private parseMultiAgentRequest(arg: string): { prompt: string; effort: ExtensionConfig['plannerEffort']; label: string } {
		const tokens = arg.trim().split(/\s+/).filter(Boolean);
		let effort: ExtensionConfig['plannerEffort'] = 'low';
		let label = 'default';
		let index = 0;

		while (index < tokens.length) {
			const token = tokens[index].toLowerCase();
			if (['--default', '-default', 'default', '--4', '-4', '4', '--low', '-low', 'low'].includes(token)) {
				effort = 'low';
				label = 'default';
				index += 1;
				continue;
			}
			if (['--medium', '-medium', 'medium'].includes(token)) {
				effort = 'medium';
				label = 'medium';
				index += 1;
				continue;
			}
			if (['--8', '-8', '8', '--high', '-high', 'high'].includes(token)) {
				effort = 'high';
				label = 'expanded';
				index += 1;
				continue;
			}
			if (['--12', '-12', '12', '--max', '-max', 'max', '--xhigh', '-xhigh', 'xhigh'].includes(token)) {
				effort = 'xhigh';
				label = 'maximum';
				index += 1;
				continue;
			}
			break;
		}

		return {
			effort,
			label,
			prompt: tokens.slice(index).join(' ').trim(),
		};
	}

	private stripOuterQuotes(value: string): string {
		const trimmed = value.trim();
		if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
			return trimmed.slice(1, -1).trim();
		}
		return trimmed;
	}

	private async handleSlashCommand(text: string): Promise<boolean> {
		if (!text.startsWith('/')) {
			return false;
		}

		const [command, ...rest] = text.trim().split(/\s+/);
		const arg = rest.join(' ').trim();

		switch (command) {
			case '/help':
				this.forEachSurface((surface) => surface.postSystem([
					'Available slash commands:',
					'/help',
					'/reset',
					'/settings',
					'/workspace',
					'/verify',
					'/repair',
					'/find <prompt>',
					'/locate <prompt>',
					'/search <prompt>',
					'/astro <prompt>',
					'/imagine <image prompt>',
					'/image <image prompt>',
					'/security',
					'/audit',
					'/rerun',
					'/failure',
					'/sidebar',
					'/panel',
					'/dev',
					'/preview',
					'/streamlit <path>',
					'/st <path>',
					'/run <command>',
					'/cf help',
					'/cf login',
					'/cf update',
					'/cf deploy  (Workers deploy)',
					'/cf pages create <name>',
					'/cf pages deploy <dir> [--project-name <name>]',
					'/cf worker init <name>',
					'/cf db create <name>',
					'/cf table <db> --file schema.sql',
					'/cf kv create <name>',
					'/cf r2 create <name>',
					'/vc help',
					'/vc login',
					'/vc whoami',
					'/vc link',
					'/vc deploy',
					'/vc deploy prod',
					'/vc dev',
					'/vc logs',
					'/vc inspect',
					'/vc open',
					'/ma [--default|--4|--8|--12|--low|--medium|--high|--xhigh] <prompt>',
					'/multi-agent [--default|--4|--8|--12] <prompt>',
					'/slide-deck [--slidev|--marp] [--vercel] <prompt>',
					'/slide [--slidev|--marp] [--vercel] <prompt>',
					'/sd [--slidev|--marp] [--vercel] <prompt>',
					'/python <prompt>',
					'/py <prompt>',
					'/py deps basic',
					'/py deps science',
					'/py run <path>',
					'/py check <path>',
					'/terminal',
					'/history',
					'/planner on|off',
					'/tasks',
					'/task <name>',
					'/git status',
					'/git diff [path]',
					'/git diff-staged [path]',
					'/git stage <path>',
					'/git stage-all',
					'/git unstage <path>',
					'/git unstage-all',
					'/git login',
					'/git whoami',
					'/git start',
					'/git init',
					'/git branch',
					'/git checkout <branch>',
					'/git checkout-new <branch>',
					'/git commit <message>',
					'/git acp <message>',
					'/git remote',
					'/git remote add <url>',
					'/git remote add <name> <url>',
					'/git remote set <name> <url>',
					'/git push [remote] [branch]',
					'/git pull [remote] [branch]',
					'/git sync',
					'/git publish github <repo> [--public|--private]',
					'/git pr create [title]',
					'/scm',
				].join('\n')));
				return true;
			case '/reset':
				await this.handleResetConversation();
				return true;
			case '/settings':
				await this.handleOpenSettings();
				return true;
			case '/workspace':
				await this.handleSelectWorkspace();
				return true;
			case '/verify':
				await this.handleVerifyWorkspace();
				return true;
			case '/repair':
				await this.handleRepairWorkspace();
				return true;
			case '/find':
			case '/locate':
			case '/search':
				if (!arg) {
					this.forEachSurface((surface) => surface.postSystem('Usage: /find <what you want to locate in this repo>'));
					return true;
				}
				await this.runPrompt(arg, [], 'find');
				return true;
			case '/astro':
				if (!arg) {
					this.forEachSurface((surface) => surface.postSystem('Usage: /astro <Astro build, fix, debug, or optimization request>'));
					return true;
				}
				await this.runPrompt(arg, [], 'astro');
				return true;
			case '/imagine':
				await this.handleImagineImage(arg, '/imagine');
				return true;
			case '/image':
				await this.handleImagineImage(arg, '/image');
				return true;
			case '/ma':
			case '/multi-agent':
			case '/multiagent':
			case '/muti-agent':
			case '/mutiagent':
				{
					const request = this.parseMultiAgentRequest(arg);
					if (!request.prompt) {
						this.forEachSurface((surface) => surface.postSystem('Usage: /ma [--default|--4|--8|--12|--low|--medium|--high|--xhigh] <problem or task>'));
						return true;
					}
					this.forEachSurface((surface) => surface.postSystem(`Multi-agent planner forced for this turn (${request.label}, effort: ${request.effort}).`));
					await this.runPrompt(request.prompt, [], 'default', {
						forcePlanner: true,
						plannerEffort: request.effort,
					});
				}
				return true;
			case '/babelfish':
			case '/bf':
				await this.handleBabelFishImage(arg);
				return true;
			case '/slide-deck':
			case '/slide':
			case '/sd':
				if (!arg) {
					this.forEachSurface((surface) => surface.postSystem('Usage: /slide-deck [--slidev|--marp] [--vercel] <what you want in the slide deck>'));
					return true;
				}
					{
						const request = this.parseSlideDeckRequest(arg);
						if (!request.prompt) {
							this.forEachSurface((surface) => surface.postSystem('Usage: /slide-deck [--slidev|--marp] [--vercel] <what you want in the slide deck>'));
							return true;
						}
						await this.runPrompt(request.prompt, [], 'slide');
					}
				return true;
			case '/python':
			case '/py':
				if (!arg) {
					this.forEachSurface((surface) => surface.postSystem('Usage: /python <prompt> | /py deps basic | /py deps science | /py run <path> | /py check <path>'));
					return true;
				}
				{
					const [pythonSubcommand, ...pythonRest] = arg.split(/\s+/).filter(Boolean);
					const pythonSubarg = pythonRest.join(' ').trim();
					if (pythonSubcommand === 'deps') {
						if (pythonSubarg === 'basic') {
							await this.runPrompt([
								'Python dependency setup task.',
								'Create or update requirements.txt for a basic young-scientist lab Python project.',
								'Include pinned or compatible versions for numpy, pandas, matplotlib, and seaborn.',
								'Do not remove existing unrelated dependencies.',
								'If the workspace already uses pyproject.toml instead, update that file consistently.',
								'Verify the dependency file content after editing.',
							].join('\n'), [], 'python');
							return true;
						}
						if (pythonSubarg === 'science') {
							await this.runPrompt([
								'Python dependency setup task.',
								'Create or update requirements.txt for a scientific Python lab project.',
								'Include pinned or compatible versions for numpy, pandas, matplotlib, seaborn, scipy, statsmodels, and sympy.',
								'Do not remove existing unrelated dependencies.',
								'If the workspace already uses pyproject.toml instead, update that file consistently.',
								'Verify the dependency file content after editing.',
							].join('\n'), [], 'python');
							return true;
						}
						this.forEachSurface((surface) => surface.postSystem('Usage: /py deps basic | /py deps science'));
						return true;
					}
					if (pythonSubcommand === 'run') {
						if (!pythonSubarg) {
							this.forEachSurface((surface) => surface.postSystem('Usage: /py run <path>'));
							return true;
						}
						await this.runPrompt([
							'Python run task.',
							`Run this script with python3 and summarize stdout/stderr: ${pythonSubarg}`,
							'If it fails because dependencies are missing, identify the missing dependency, update the dependency file if appropriate, install only when allowed, then rerun.',
							'Do not report success unless the command succeeds or the blocker is clearly stated.',
						].join('\n'), [], 'python');
						return true;
					}
					if (pythonSubcommand === 'check') {
						if (!pythonSubarg) {
							this.forEachSurface((surface) => surface.postSystem('Usage: /py check <path>'));
							return true;
						}
						await this.runPrompt([
							'Python verification task.',
							`Run python3 -m py_compile on this file: ${pythonSubarg}`,
							'If compile fails, inspect and fix the Python file, then rerun the compile check.',
							'Report the exact command and result.',
						].join('\n'), [], 'python');
						return true;
					}
				}
				await this.runPrompt(arg, [], 'python');
				return true;
			case '/security':
			case '/audit':
				await this.handleSecurityAudit();
				return true;
			case '/rerun':
				await this.handleRerunLastWorkflow();
				return true;
			case '/failure':
				await this.handleShowLastFailure();
				return true;
			case '/sidebar':
				await vscode.commands.executeCommand('workbench.view.extension.buildbyyou');
				return true;
			case '/panel':
				await this.openPanel();
				return true;
			case '/dev':
			case '/serve':
				await this.handleStartDevServer();
				return true;
			case '/preview':
			case '/open':
				await this.handleOpenPreview();
				return true;
			case '/streamlit':
			case '/st':
				await this.handleStreamlitSlashCommand(arg);
				return true;
			case '/terminal': {
				const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
				if (folder) {
					this.terminalSessionService.getOrCreate(folder).show(true);
				}
				return true;
			}
			case '/scm':
				await this.handleOpenSourceControl();
				return true;
			case '/history': {
				const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
				const terminalHistory = folder ? this.terminalSessionService.getHistory(folder) : [];
				const recentTasks = this.taskHistory.slice(-8).reverse();
				this.forEachSurface((surface) => surface.postSystem([
					'Recent task runs:',
					recentTasks.length > 0
						? recentTasks.map((entry) => `${entry.startedAt} ${entry.kind.toUpperCase()} ${entry.label} [${entry.status}]${entry.summary ? ` - ${entry.summary}` : ''}`).join('\n')
						: 'No task history yet.',
					'',
					'Terminal history:',
					terminalHistory.length > 0
						? terminalHistory.map((entry) => `${entry.startedAt} ${entry.command}${entry.exitCode !== undefined ? ` [${entry.exitCode}]` : ''}`).join('\n')
						: 'No terminal history for this workspace yet.',
				].join('\n')));
				return true;
			}
			case '/tasks': {
				const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
				if (folder) {
					const presets = await this.taskPresetService.getPresets(folder, this.configService.get().taskPresets);
					this.forEachSurface((surface) => surface.postSystem(
						presets.length > 0
							? presets.map((preset) => `${preset.name}: ${preset.command}${preset.description ? ` - ${preset.description}` : ''}`).join('\n')
							: 'No task presets available for this workspace.',
					));
				}
				return true;
			}
			case '/task': {
				const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
				if (!folder) {
					return true;
				}
				const presets = await this.taskPresetService.getPresets(folder, this.configService.get().taskPresets);
				if (!arg) {
					this.forEachSurface((surface) => surface.postSystem('Usage: /task <name>'));
					return true;
				}
				const preset = presets.find((item) => item.name === arg);
				if (!preset) {
					this.forEachSurface((surface) => surface.postSystem(`Unknown task preset: ${arg}`));
					return true;
				}
				await this.handlePrompt(`Run this preset command and summarize the result:\n\n${preset.command}`);
				return true;
			}
			case '/git': {
				const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
				if (!folder) {
					return true;
				}
				const [subcommand, ...subrest] = arg.split(/\s+/).filter(Boolean);
				const subarg = subrest.join(' ').trim();
				if (subcommand === 'login') {
					try {
						const result = await this.gitService.loginGithub();
						this.forEachSurface((surface) => surface.postSystem(result));
					} catch (error) {
						this.forEachSurface((surface) => surface.postSystem(error instanceof Error ? error.message : String(error)));
					}
					return true;
				}
				if (subcommand === 'whoami') {
					try {
						const result = await this.gitService.githubWhoami();
						this.forEachSurface((surface) => surface.postSystem(result));
					} catch (error) {
						this.forEachSurface((surface) => surface.postSystem(error instanceof Error ? error.message : String(error)));
					}
					return true;
				}
				if (subcommand === 'init') {
					const result = await this.gitService.init(folder);
					this.forEachSurface((surface) => surface.postSystem(result));
					return true;
				}
				if (subcommand === 'start' || subcommand === 'bootstrap') {
					const result = await this.gitService.start(folder);
					this.forEachSurface((surface) => surface.postSystem(result));
					return true;
				}
				if (subcommand === 'publish' && subrest[0]?.toLowerCase() === 'github') {
					const repo = subrest.find((item) => !item.startsWith('--') && item.toLowerCase() !== 'github');
					const visibility = subrest.includes('--public') ? 'public' : 'private';
					if (!repo) {
						this.forEachSurface((surface) => surface.postSystem('Usage: /git publish github <repo> [--public|--private]'));
						return true;
					}
					try {
						const result = await this.gitService.publishGithub(folder, repo, visibility);
						this.forEachSurface((surface) => surface.postSystem(result));
					} catch (error) {
						this.forEachSurface((surface) => surface.postSystem(error instanceof Error ? error.message : String(error)));
					}
					return true;
				}
				if (subcommand !== 'acp' && !(await this.gitService.isGitRepo(folder))) {
					this.forEachSurface((surface) => surface.postSystem('This workspace is not a git repository. Run `/git init` first, or use `/git publish github <repo>` to initialize and publish with GitHub CLI.'));
					return true;
				}

				switch (subcommand) {
					case 'status': {
						const status = await this.gitService.status(folder);
						this.forEachSurface((surface) => surface.postSystem(status));
						return true;
					}
					case 'diff': {
						const diff = await this.gitService.diff(folder, subarg || undefined);
						this.forEachSurface((surface) => surface.postSystem(diff));
						return true;
					}
					case 'diff-staged': {
						const diff = await this.gitService.diffStaged(folder, subarg || undefined);
						this.forEachSurface((surface) => surface.postSystem(diff));
						return true;
					}
					case 'stage':
						if (!subarg) {
							this.forEachSurface((surface) => surface.postSystem('Usage: /git stage <path>'));
							return true;
						}
						{
							const stageResult = await this.gitService.stage(folder, subarg);
							this.forEachSurface((surface) => surface.postSystem(stageResult));
						}
						return true;
					case 'stage-all': {
						const stageResult = await this.gitService.stageAll(folder);
						this.forEachSurface((surface) => surface.postSystem(stageResult));
						return true;
					}
					case 'unstage':
						if (!subarg) {
							this.forEachSurface((surface) => surface.postSystem('Usage: /git unstage <path>'));
							return true;
						}
						{
							const unstageResult = await this.gitService.unstage(folder, subarg);
							this.forEachSurface((surface) => surface.postSystem(unstageResult));
						}
						return true;
					case 'unstage-all': {
						const unstageAllResult = await this.gitService.unstageAll(folder);
						this.forEachSurface((surface) => surface.postSystem(unstageAllResult));
						return true;
					}
					case 'branch': {
						const result = await this.gitService.branch(folder);
						this.forEachSurface((surface) => surface.postSystem(result));
						return true;
					}
					case 'checkout':
						if (!subarg) {
							this.forEachSurface((surface) => surface.postSystem('Usage: /git checkout <branch>'));
							return true;
						}
						{
							const result = await this.gitService.checkout(folder, subarg);
							this.forEachSurface((surface) => surface.postSystem(result));
						}
						return true;
					case 'checkout-new':
						if (!subarg) {
							this.forEachSurface((surface) => surface.postSystem('Usage: /git checkout-new <branch>'));
							return true;
						}
						{
							const result = await this.gitService.checkout(folder, subarg, true);
							this.forEachSurface((surface) => surface.postSystem(result));
						}
						return true;
					case 'commit':
						{
							const result = await this.gitService.commit(folder, this.stripOuterQuotes(subarg) || 'Initial commit');
							this.forEachSurface((surface) => surface.postSystem(result));
						}
						return true;
					case 'acp': {
						const message = this.stripOuterQuotes(subarg);
						if (!message) {
							this.forEachSurface((surface) => surface.postSystem('Usage: /git acp <commit message>'));
							return true;
						}
						try {
							const result = await this.gitService.addCommitPush(folder, message);
							this.forEachSurface((surface) => surface.postSystem(result));
						} catch (error) {
							this.forEachSurface((surface) => surface.postSystem(error instanceof Error ? error.message : String(error)));
						}
						return true;
					}
					case 'remote': {
						const [remoteAction, remoteName, ...remoteRest] = subrest;
						if (!remoteAction) {
							const result = await this.gitService.remotes(folder);
							this.forEachSurface((surface) => surface.postSystem(result));
							return true;
						}
						const isAdd = remoteAction === 'add';
						const inferredRemoteName = isAdd && remoteName && /^https?:\/\/|^git@/i.test(remoteName)
							? 'origin'
							: remoteName;
						const inferredRemoteUrl = isAdd && remoteName && /^https?:\/\/|^git@/i.test(remoteName)
							? remoteName
							: remoteRest.join(' ').trim();
						if (isAdd && inferredRemoteName && inferredRemoteUrl) {
							const result = await this.gitService.addRemote(folder, inferredRemoteName, inferredRemoteUrl);
							this.forEachSurface((surface) => surface.postSystem(result));
							return true;
						}
						const remoteUrl = remoteRest.join(' ').trim();
						if (remoteAction === 'set' && remoteName && remoteUrl) {
							const result = await this.gitService.setRemote(folder, remoteName, remoteUrl);
							this.forEachSurface((surface) => surface.postSystem(result));
							return true;
						}
						this.forEachSurface((surface) => surface.postSystem('Usage: /git remote | /git remote add <url> | /git remote add <name> <url> | /git remote set <name> <url>'));
						return true;
					}
					case 'push': {
						const [remote, branch] = subrest;
						try {
							const result = await this.gitService.pushWithGithubAuth(folder, remote || 'origin', branch);
							this.forEachSurface((surface) => surface.postSystem(result));
						} catch (error) {
							this.forEachSurface((surface) => surface.postSystem(error instanceof Error ? error.message : String(error)));
						}
						return true;
					}
					case 'pull': {
						const [remote, branch] = subrest;
						try {
							const result = await this.gitService.pull(folder, remote || 'origin', branch);
							this.forEachSurface((surface) => surface.postSystem(result));
						} catch (error) {
							this.forEachSurface((surface) => surface.postSystem(error instanceof Error ? error.message : String(error)));
						}
						return true;
					}
					case 'sync': {
						try {
							const result = await this.gitService.sync(folder);
							this.forEachSurface((surface) => surface.postSystem(result));
						} catch (error) {
							this.forEachSurface((surface) => surface.postSystem(error instanceof Error ? error.message : String(error)));
						}
						return true;
					}
					case 'pr': {
						const [prAction, ...prRest] = subrest;
						if (prAction !== 'create') {
							this.forEachSurface((surface) => surface.postSystem('Usage: /git pr create [title]'));
							return true;
						}
						try {
							const result = await this.gitService.createPullRequest(folder, this.stripOuterQuotes(prRest.join(' ').trim()) || undefined);
							this.forEachSurface((surface) => surface.postSystem(result));
						} catch (error) {
							this.forEachSurface((surface) => surface.postSystem(error instanceof Error ? error.message : String(error)));
						}
						return true;
					}
					default:
						this.forEachSurface((surface) => surface.postSystem('Usage: /git status | /git diff [path] | /git diff-staged [path] | /git stage <path> | /git stage-all | /git unstage <path> | /git unstage-all | /git login | /git whoami | /git start | /git init | /git branch | /git checkout <branch> | /git checkout-new <branch> | /git commit <message> | /git acp <message> | /git remote | /git remote add <url> | /git remote add <name> <url> | /git remote set <name> <url> | /git push [remote] [branch] | /git pull [remote] [branch] | /git sync | /git publish github <repo> [--public|--private] | /git pr create [title]'));
						return true;
				}
			}
			case '/run':
				if (!arg) {
					this.forEachSurface((surface) => surface.postSystem('Usage: /run <command>'));
					return true;
				}
				await this.handlePrompt(`Run this command and summarize the result:\n\n${arg}`);
				return true;
			case '/cf':
			case '/cloudflare':
				await this.handleCloudflareSlashCommand(arg);
				return true;
			case '/vc':
			case '/vercel':
				await this.handleVercelSlashCommand(arg);
				return true;
			case '/planner':
				if (!arg || !['on', 'off'].includes(arg)) {
					this.forEachSurface((surface) => surface.postSystem('Usage: /planner on|off'));
					return true;
				}
				await vscode.workspace.getConfiguration('buildbyyou').update(
					'enablePlanner',
					arg === 'on',
					vscode.ConfigurationTarget.Workspace,
				);
				this.forEachSurface((surface) => surface.postSystem(`Planner ${arg === 'on' ? 'enabled' : 'disabled'} for this workspace.`));
				await this.refreshState();
				return true;
			default:
				this.forEachSurface((surface) => surface.postSystem(`Unknown slash command: ${command}. Use /help.`));
				return true;
		}
	}

	private async handleCloudflareSlashCommand(arg: string): Promise<void> {
		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!folder) {
			this.forEachSurface((surface) => surface.postSystem('Open a workspace folder before using Cloudflare commands.'));
			return;
		}

		if (!arg) {
			this.forEachSurface((surface) => surface.postSystem([
				'Cloudflare slash commands:',
				'/cf login',
				'/cf logout',
				'/cf whoami',
				'/cf update',
				'/cf deploy  (Workers deploy)',
				'/cf pages create <name>',
				'/cf pages deploy <dir> [--project-name <name>]',
				'/cf worker init <name>',
				'/cf db create <name>',
				'/cf table <db> --file schema.sql',
				'/cf kv create <name>',
				'/cf r2 create <name>',
				'/cf wrangler <any other wrangler subcommand>',
				'',
				'For static sites, use `/cf pages deploy dist --project-name <name>`.',
			].join('\n')));
			return;
		}

		const command = await this.buildCloudflareCommand(folder, arg);
		await this.handlePrompt([
			'Run this Cloudflare Wrangler command and summarize the result.',
			'If the command requires interactive login or browser auth, explain what happened clearly.',
			'',
			command,
		].join('\n\n'));
	}

	private async handleVercelSlashCommand(arg: string): Promise<void> {
		const folder = this.workspaceContextService.resolveWorkspaceFolder(this.session.selectedWorkspace);
		if (!folder) {
			this.forEachSurface((surface) => surface.postSystem('Open a workspace folder before using Vercel commands.'));
			return;
		}

		const state = await this.detectVercelProjectState(folder);
		if (!arg || arg === 'help') {
			const linkedLine = state.linked
				? `Linked project: yes${state.projectName ? ` (${state.projectName})` : ''}`
				: 'Linked project: no';
			this.forEachSurface((surface) => surface.postSystem([
				'Vercel slash commands:',
				'/vc login',
				'/vc logout',
				'/vc whoami',
				'/vc link',
				'/vc deploy',
				'/vc deploy prod',
				'/vc dev',
				'/vc logs',
				'/vc inspect',
				'/vc open',
				'/vc vercel <any other vercel subcommand>',
				'',
				linkedLine,
				state.projectId ? `Project id: ${state.projectId}` : '',
				'`/vc deploy` creates a preview deployment. Use `/vc deploy prod` for production.',
			].filter(Boolean).join('\n')));
			return;
		}

		const command = this.buildVercelCommand(arg);
		await this.handlePrompt([
			'Run this Vercel CLI command and summarize the result.',
			'If the command requires interactive login, browser auth, linking, or project selection, explain what happened clearly.',
			'',
			'Current Vercel project state:',
			`- Linked project: ${state.linked ? 'yes' : 'no'}`,
			state.projectName ? `- Project name: ${state.projectName}` : '',
			state.projectId ? `- Project id: ${state.projectId}` : '',
			'',
			command,
		].filter(Boolean).join('\n'));
	}

	private async buildCloudflareCommand(folder: vscode.WorkspaceFolder, arg: string): Promise<string> {
		const tokens = arg.split(/\s+/).filter(Boolean);
		const normalized = tokens.map((token) => token.toLowerCase());
		const wranglerBase = 'npx wrangler';
		if (tokens.length === 0) {
			return `${wranglerBase} --help`;
		}

		if (normalized[0] === 'wrangler') {
			if (normalized[1] === 'update') {
				return await this.buildWranglerUpdateCommand(folder);
			}

			return `${wranglerBase} ${tokens.slice(1).join(' ')}`.trim();
		}

		switch (normalized[0]) {
			case 'help':
				return `${wranglerBase} --help`;
			case 'login':
			case 'logout':
			case 'whoami':
			case 'deploy':
			case 'dev':
			case 'publish':
				return `${wranglerBase} ${tokens.join(' ')}`;
			case 'update':
				return await this.buildWranglerUpdateCommand(folder);
			case 'page':
			case 'pages':
				if (normalized[1] === 'create' && tokens[2]) {
					return `${wranglerBase} pages project create ${tokens.slice(2).join(' ')}`;
				}
				if (normalized[1] === 'deploy') {
					return `${wranglerBase} pages deploy ${tokens.slice(2).join(' ')}`.trim();
				}
				return `${wranglerBase} pages ${tokens.slice(1).join(' ')}`.trim();
			case 'worker':
			case 'workers':
				if (normalized[1] === 'init' && tokens[2]) {
					return `${wranglerBase} init ${tokens.slice(2).join(' ')}`;
				}
				return `${wranglerBase} ${tokens.slice(1).join(' ')}`.trim();
			case 'db':
			case 'd1':
				if (normalized[1] === 'create' && tokens[2]) {
					return `${wranglerBase} d1 create ${tokens.slice(2).join(' ')}`;
				}
				if (normalized[1] === 'table' && tokens[2]) {
					return `${wranglerBase} d1 execute ${tokens[2]} ${tokens.slice(3).join(' ')}`.trim();
				}
				return `${wranglerBase} d1 ${tokens.slice(1).join(' ')}`.trim();
			case 'table':
				if (tokens[1]) {
					return `${wranglerBase} d1 execute ${tokens[1]} ${tokens.slice(2).join(' ')}`.trim();
				}
				return `${wranglerBase} d1 execute`;
			case 'kv':
				if (normalized[1] === 'create' && tokens[2]) {
					return `${wranglerBase} kv namespace create ${tokens.slice(2).join(' ')}`;
				}
				return `${wranglerBase} kv ${tokens.slice(1).join(' ')}`.trim();
			case 'r2':
				if (normalized[1] === 'create' && tokens[2]) {
					return `${wranglerBase} r2 bucket create ${tokens.slice(2).join(' ')}`;
				}
				return `${wranglerBase} r2 ${tokens.slice(1).join(' ')}`.trim();
			default:
				return `${wranglerBase} ${tokens.join(' ')}`.trim();
		}
	}

	private buildVercelCommand(arg: string): string {
		const tokens = arg.split(/\s+/).filter(Boolean);
		const normalized = tokens.map((token) => token.toLowerCase());
		const vercelBase = 'npx vercel';
		if (tokens.length === 0) {
			return `${vercelBase} --help`;
		}

		if (normalized[0] === 'vercel') {
			return `${vercelBase} ${tokens.slice(1).join(' ')}`.trim();
		}

		switch (normalized[0]) {
			case 'help':
				return `${vercelBase} --help`;
			case 'login':
			case 'logout':
			case 'whoami':
			case 'link':
			case 'dev':
			case 'logs':
			case 'inspect':
			case 'open':
				return `${vercelBase} ${tokens.join(' ')}`.trim();
			case 'deploy':
				if (normalized[1] === 'prod' || normalized[1] === 'production') {
					return `${vercelBase} deploy --prod ${tokens.slice(2).join(' ')}`.trim();
				}
				return `${vercelBase} deploy ${tokens.slice(1).join(' ')}`.trim();
			default:
				return `${vercelBase} ${tokens.join(' ')}`.trim();
		}
	}

	private async buildWranglerUpdateCommand(folder: vscode.WorkspaceFolder): Promise<string> {
		const packageManager = await this.detectPackageManager(folder);
		switch (packageManager) {
			case 'pnpm':
				return 'pnpm add -D wrangler@latest';
			case 'yarn':
				return 'yarn add -D wrangler@latest';
			case 'bun':
				return 'bun add -d wrangler@latest';
			default:
				return 'npm install -D wrangler@latest';
		}
	}

	private async detectPackageManager(folder: vscode.WorkspaceFolder): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> {
		const root = folder.uri.fsPath;
		const checks: Array<{ file: string; manager: 'npm' | 'pnpm' | 'yarn' | 'bun' }> = [
			{ file: 'pnpm-lock.yaml', manager: 'pnpm' },
			{ file: 'pnpm-workspace.yaml', manager: 'pnpm' },
			{ file: 'yarn.lock', manager: 'yarn' },
			{ file: 'bun.lockb', manager: 'bun' },
			{ file: 'bun.lock', manager: 'bun' },
			{ file: 'package-lock.json', manager: 'npm' },
		];

		for (const check of checks) {
			try {
				await fs.access(path.join(root, check.file));
				return check.manager;
			} catch {
				// Continue checking.
			}
		}

		return 'npm';
	}

	private async ensureDevPresetDependencies(folder: vscode.WorkspaceFolder, command: string): Promise<boolean> {
		const root = folder.uri.fsPath;
		const packageJsonPath = path.join(root, 'package.json');
		let parsed: {
			scripts?: Record<string, string>;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		try {
			parsed = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as typeof parsed;
		} catch {
			return true;
		}

		const scriptName = command.match(/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([a-z0-9:_-]+)$/i)?.[1];
		const script = scriptName ? parsed.scripts?.[scriptName] : command;
		if (!script || !/\bslidev\b/i.test(script)) {
			return true;
		}

		const deps = {
			...(parsed.dependencies ?? {}),
			...(parsed.devDependencies ?? {}),
		};
		const manager = await this.detectPackageManager(folder);
		const hasSlidevDependency = '@slidev/cli' in deps || 'slidev' in deps;
		const slidevBinInstalled = await this.pathExists(path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'slidev.cmd' : 'slidev'));
		const missingPackages: string[] = [];
		if (!slidevBinInstalled && !hasSlidevDependency) {
			missingPackages.push('@slidev/cli', 'playwright-chromium');
		}

		const themePackage = await this.detectSlidevThemePackage(folder);
		if (themePackage && !(themePackage in deps) && !await this.pathExists(path.join(root, 'node_modules', ...themePackage.split('/')))) {
			missingPackages.push(themePackage);
		}

		if (slidevBinInstalled && missingPackages.length === 0) {
			return true;
		}

		const installCommand = missingPackages.length > 0
			? this.addPackagesCommandForPackageManager(manager, missingPackages)
			: this.installCommandForPackageManager(manager);

		this.forEachSurface((surface) => surface.postSystem(`Slidev dependencies are not installed yet. Running \`${installCommand}\` before starting the server.`));
		const result = await this.commandExecutionService.run(folder, installCommand, 180000, (chunk) => {
			const text = summarizeTerminalOutput(sanitizeTerminalChunk(chunk), 1200);
			if (text) {
				this.appendTimeline({
					id: `slidev-install-${Date.now()}-${Math.random()}`,
					turnId: `slidev-install-${Date.now()}`,
					kind: 'command',
					title: 'Slidev dependency install output',
					detail: text,
					timestamp: new Date().toISOString(),
				});
			}
		});

		if (result.exitCode !== 0) {
			this.forEachSurface((surface) => surface.postSystem([
				`Could not install Slidev dependencies automatically. Command: \`${installCommand}\``,
				result.stderr || result.stdout || 'No output captured.',
			].join('\n\n')));
			return false;
		}

		return true;
	}

	private installCommandForPackageManager(manager: 'npm' | 'pnpm' | 'yarn' | 'bun'): string {
		switch (manager) {
			case 'pnpm':
				return 'pnpm install';
			case 'yarn':
				return 'yarn install';
			case 'bun':
				return 'bun install';
			default:
				return 'npm install';
		}
	}

	private addSlidevCommandForPackageManager(manager: 'npm' | 'pnpm' | 'yarn' | 'bun'): string {
		return this.addPackagesCommandForPackageManager(manager, ['@slidev/cli', 'playwright-chromium']);
	}

	private addPackagesCommandForPackageManager(manager: 'npm' | 'pnpm' | 'yarn' | 'bun', packages: string[]): string {
		const packageList = [...new Set(packages)].join(' ');
		switch (manager) {
			case 'pnpm':
				return `pnpm add -D ${packageList}`;
			case 'yarn':
				return `yarn add -D ${packageList}`;
			case 'bun':
				return `bun add -d ${packageList}`;
			default:
				return `npm install -D ${packageList}`;
		}
	}

	private async detectSlidevThemePackage(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
		const slidesPath = path.join(folder.uri.fsPath, 'slides.md');
		const content = await fs.readFile(slidesPath, 'utf8').catch(() => undefined);
		const theme = content?.match(/^theme:\s*['"]?([^'"\s#]+)['"]?/m)?.[1]?.trim();
		if (!theme || theme === 'none') {
			return undefined;
		}
		if (theme.startsWith('@')) {
			return theme;
		}
		return theme.startsWith('slidev-theme-') ? theme : `@slidev/theme-${theme}`;
	}

	private async pathExists(targetPath: string): Promise<boolean> {
		try {
			await fs.access(targetPath);
			return true;
		} catch {
			return false;
		}
	}

	private async isSlideDeckWorkspace(folder: vscode.WorkspaceFolder): Promise<boolean> {
		try {
			await fs.access(path.join(folder.uri.fsPath, 'slides.md'));
			return true;
		} catch {
			// Continue checking package metadata.
		}

		const packageJsonPath = path.join(folder.uri.fsPath, 'package.json');
		try {
			const content = await fs.readFile(packageJsonPath, 'utf8');
			const parsed = JSON.parse(content) as {
				scripts?: Record<string, string>;
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
			};
			const scripts = Object.values(parsed.scripts ?? {}).join(' ').toLowerCase();
			const deps = {
				...(parsed.dependencies ?? {}),
				...(parsed.devDependencies ?? {}),
			};
			if ('@slidev/cli' in deps || 'slidev' in deps) {
				return true;
			}
			return /\bslidev\b/.test(scripts);
		} catch {
			return false;
		}
	}

	private async detectVercelProjectState(folder: vscode.WorkspaceFolder): Promise<{
		linked: boolean;
		projectId?: string;
		projectName?: string;
	}> {
		const root = folder.uri.fsPath;
		const projectFile = path.join(root, '.vercel', 'project.json');
		try {
			const raw = await fs.readFile(projectFile, 'utf8');
			const data = JSON.parse(raw) as Record<string, unknown>;
			const projectId = typeof data.projectId === 'string' ? data.projectId : undefined;
			const projectName = typeof data.projectName === 'string'
				? data.projectName
				: typeof data.name === 'string'
					? data.name
					: undefined;
			return {
				linked: true,
				projectId,
				projectName,
			};
		} catch {
			return { linked: false };
		}
	}

	private languageFromPath(filePath: string): string | undefined {
		const ext = filePath.split('.').pop()?.toLowerCase();
		switch (ext) {
			case 'ts':
				return 'typescript';
			case 'js':
				return 'javascript';
			case 'json':
				return 'json';
			case 'md':
				return 'markdown';
			case 'css':
				return 'css';
			case 'html':
				return 'html';
			default:
				return undefined;
		}
	}

	private async persistSessionState(): Promise<void> {
		if (this.configService.get().persistSensitiveHistory) {
			await this.sessionStoreService.save(this.session);
			return;
		}

		await this.sessionStoreService.save({
			...this.session,
			messages: [],
			lastWorkflow: this.session.lastWorkflow
				? {
					...this.session.lastWorkflow,
					detail: 'History persistence is disabled.',
					command: undefined,
					output: undefined,
				}
				: undefined,
		});
	}

	private async persistRecentConversation(folder: vscode.WorkspaceFolder): Promise<void> {
		if (!this.configService.get().persistSensitiveHistory || this.session.messages.length === 0) {
			return;
		}

		await this.sessionStoreService.upsertRecentConversation({
			id: this.conversationIdForFolder(folder),
			title: this.conversationTitle(this.session.messages, folder.name),
			workspaceLabel: folder.name,
			workspaceUri: folder.uri.toString(),
			workspacePath: folder.uri.fsPath,
			updatedAt: new Date().toISOString(),
			messages: this.session.messages,
		});
		await this.refreshState();
	}

	private conversationIdForFolder(folder: vscode.WorkspaceFolder): string {
		return folder.uri.toString();
	}

	private conversationTitle(messages: ChatMessage[], fallback: string): string {
		const firstUserMessage = messages.find((message) => message.role === 'user' && message.text.trim());
		if (!firstUserMessage) {
			return fallback;
		}

		const firstLine = firstUserMessage.text.replace(/\s+/g, ' ').trim();
		return firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine;
	}

	private async persistSensitiveArtifacts(): Promise<void> {
		if (this.configService.get().persistSensitiveHistory) {
			await this.sessionStoreService.saveTimeline(this.timeline);
			await this.sessionStoreService.saveTaskHistory(this.taskHistory);
			await this.sessionStoreService.saveTerminalHistory(this.terminalSessionService.exportHistory());
			return;
		}

		await this.sessionStoreService.saveTimeline([]);
		await this.sessionStoreService.saveTaskHistory([]);
		await this.sessionStoreService.saveTerminalHistory({});
	}

	private discloseOutboundContext(
		summary: { keyFiles: Array<{ path: string; preview: string }>; topLevelEntries: string[] },
		prompt: string,
		attachments: ChatImageAttachment[],
	): void {
		const disclosure = `Remote send: prompt (${prompt.length} chars), ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}, workspace summary (${summary.keyFiles.length} key files, ${summary.topLevelEntries.length} top-level entries). Additional file contents may be sent later if the agent reads them.`;
		this.forEachSurface((surface) => surface.postSystem(disclosure));
		this.logSecurity(disclosure);
	}

	private logSecurity(message: string): void {
		this.securityOutputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	}

	private normalizeCommand(command: string): string {
		return command.trim().replace(/\s+/g, ' ').toLowerCase();
	}

	private formatTimelineEntry(entry: TimelineEntry): string {
		if (entry.kind === 'turn') {
			return '';
		}

		const time = new Date(entry.timestamp).toLocaleTimeString([], {
			hour: 'numeric',
			minute: '2-digit',
		});
		const detail = entry.detail && entry.detail !== entry.title
			? `\n${entry.detail}`
			: '';
		return `Thought ${time}: ${entry.title}${detail}`;
	}

	private summarizeFailure(label: string, command: string, output: string, exitCode: number): string {
		const compact = output.replace(/\s+/g, ' ').trim();
		const lowered = compact.toLowerCase();
		const excerpt = compact.slice(0, 220) || `Command exited with code ${exitCode}.`;

		if (/ts\d{4}/i.test(output) || lowered.includes('typescript')) {
			return `TypeScript/compiler failure in ${label}. ${excerpt}`;
		}
		if (lowered.includes('eslint') || lowered.includes('prettier') || lowered.includes('lint')) {
			return `Lint or formatting failure in ${label}. ${excerpt}`;
		}
		if (lowered.includes('jest') || lowered.includes('vitest') || lowered.includes('failing test') || lowered.includes('expected') && lowered.includes('received')) {
			return `Test failure in ${label}. ${excerpt}`;
		}
		if (lowered.includes('cannot find module') || lowered.includes('module not found')) {
			return `Missing module or import resolution failure in ${label}. ${excerpt}`;
		}
		if (lowered.includes('syntaxerror') || lowered.includes('unexpected token')) {
			return `Syntax failure in ${label}. ${excerpt}`;
		}
		if (lowered.includes('command not found') || lowered.includes('is not recognized as an internal or external command')) {
			return `Environment or missing command failure in ${label}. ${excerpt}`;
		}
		if (lowered.includes('timed out')) {
			return `Timeout while running ${label}. ${excerpt}`;
		}
		return `Verification failure in ${label} with exit code ${exitCode}. ${excerpt}`;
	}

	private startTaskRun(kind: TaskRunRecord['kind'], label: string, command: string): string {
		const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.taskHistory.push({
			id,
			kind,
			label,
			command,
			status: 'running',
			startedAt: new Date().toISOString(),
		});
		this.taskHistory.splice(0, Math.max(0, this.taskHistory.length - 100));
		void this.persistSensitiveArtifacts();
		return id;
	}

	private async finishTaskRun(id: string, status: TaskRunRecord['status'], summary: string, outputPreview: string): Promise<void> {
		const task = this.taskHistory.find((entry) => entry.id === id);
		if (!task) {
			return;
		}

		task.status = status;
		task.finishedAt = new Date().toISOString();
		task.summary = summary;
		task.outputPreview = outputPreview.slice(0, 1200);
		await this.persistSensitiveArtifacts();
	}

	private async updateWorkflowState(state: {
		mode: LastWorkflowState['mode'];
		status: LastWorkflowState['status'];
		label: string;
		detail: string;
		command?: string;
		output?: string;
	}): Promise<void> {
		this.session.lastWorkflow = {
			...state,
			updatedAt: new Date().toISOString(),
		};
		await this.persistSessionState();
		await this.refreshState();
	}

	private async detectPreviewUrlFallback(folder: vscode.WorkspaceFolder, command: string, previewPath?: string, timeoutMs = 30000): Promise<string | undefined> {
		const startedAt = Date.now();
		const candidates = this.previewCandidatesForCommand(command);
		while (Date.now() - startedAt < timeoutMs) {
			const existing = this.terminalSessionService.getLatestPreviewUrl(folder);
			if (existing) {
				return this.previewUrlWithPath(existing, previewPath);
			}

			for (const candidate of candidates) {
				if (await this.isPreviewReachable(candidate)) {
					return this.previewUrlWithPath(candidate, previewPath);
				}
			}

			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		return undefined;
	}

	private previewUrlWithPath(baseUrl: string, previewPath?: string): string {
		if (!previewPath) {
			return baseUrl;
		}

		try {
			const parsed = new URL(baseUrl);
			const normalizedPath = previewPath.split(path.sep).join('/');
			parsed.pathname = `/${normalizedPath.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
			parsed.search = '';
			parsed.hash = '';
			return parsed.toString();
		} catch {
			return baseUrl;
		}
	}

	private previewCandidatesForCommand(command: string): string[] {
		const lowered = command.toLowerCase();
		const orderedPorts: number[] = [];
		const add = (port: number): void => {
			if (!orderedPorts.includes(port)) {
				orderedPorts.push(port);
			}
		};

		if (lowered.includes('astro')) {
			add(4321);
		}
		if (lowered.includes('vite')) {
			add(5173);
			add(4173);
		}
		if (lowered.includes('next') || lowered.includes('nuxt')) {
			add(3000);
		}
		if (lowered.includes('slidev')) {
			add(3030);
		}
		if (lowered.includes('streamlit')) {
			add(8501);
		}
		if (lowered.includes('python -m http.server')) {
			add(8000);
		}

		for (const port of [3030, 3000, 4173, 4321, 5000, 5173, 8000, 8080, 8081, 8501, 8787]) {
			add(port);
		}

		return orderedPorts.map((port) => `http://localhost:${port}/`);
	}

	private async isPreviewReachable(url: string): Promise<boolean> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 800);
		try {
			const response = await fetch(url, {
				method: 'GET',
				signal: controller.signal,
			});
			return response.status > 0;
		} catch {
			return false;
		} finally {
			clearTimeout(timeout);
		}
	}

	private summarizeAgentEvent(message: string): string {
		const trimmed = message.trim();
		if (!trimmed) {
			return '';
		}

		if (trimmed.startsWith('tool requested:')) {
			const toolName = trimmed.replace(/^tool requested:\s*/i, '').trim().toLowerCase();
			switch (toolName) {
				case 'list_files':
					return 'Tool: list_files - checking workspace structure.';
				case 'search_text':
					return 'Tool: search_text - locating relevant code.';
				case 'read_file':
					return 'Tool: read_file - reading target file context.';
				case 'inspect_media_file':
					return 'Tool: inspect_media_file - verifying image asset.';
				case 'image_build':
					return 'Tool: image_build - generating and verifying local image asset.';
				case 'replace_in_file':
					return 'Tool: replace_in_file - editing project file.';
				case 'write_file':
					return 'Tool: write_file - writing project file.';
				case 'delete_file':
					return 'Tool: delete_file - deleting project file.';
				case 'run_command':
					return 'Tool: run_command - running workspace command in terminal.';
				case 'create_directory':
					return 'Tool: create_directory - creating project folder.';
				default:
					return `Tool: ${toolName}.`;
			}
		}

		if (trimmed.startsWith('tool result:')) {
			return this.summarizeToolResultEvent(trimmed);
		}

		if (trimmed.startsWith('terminal output')) {
			return '';
		}

		if (trimmed.startsWith('terminal ')) {
			return '';
		}

		if (trimmed.startsWith('preview detected:')) {
			return 'Preview is ready.';
		}

		if (trimmed.startsWith('note:')) {
			const note = trimmed.replace(/^note:\s*/i, '');
			if (/validation failed/i.test(note)) {
				return 'Self-check found issues. Fixing them now...';
			}
			return note;
		}

		return '';
	}

	private summarizeToolResultEvent(trimmed: string): string {
		const body = trimmed.replace(/^tool result:\s*/i, '');
		const [rawToolName, ...rawDetails] = body.split(/\r?\n/);
		const toolName = rawToolName.trim();
		if (!toolName) {
			return '';
		}

		if (toolName === 'run_command') {
			const command = body.match(/command:\s*([^\n]+)/i)?.[1]?.trim();
			return command ? `Result: run_command - ${command}` : 'Result: run_command completed.';
		}

		if (toolName === 'read_file') {
			const lineCount = rawDetails.filter((line) => /^\d+:/u.test(line.trim())).length;
			return lineCount > 0 ? `Result: read_file - ${lineCount} line${lineCount === 1 ? '' : 's'} returned.` : 'Result: read_file completed.';
		}

		if (toolName === 'list_files') {
			const entries = rawDetails.filter((line) => /^(dir|file)\s+/u.test(line.trim())).length;
			return entries > 0 ? `Result: list_files - ${entries} item${entries === 1 ? '' : 's'} found.` : 'Result: list_files completed.';
		}

		if (toolName === 'image_build') {
			const generated = body.match(/Image built:\s*([^\s]+)/i)?.[1];
			const verified = body.match(/Verified:\s*([^\n]+)/i)?.[1];
			return generated
				? `Result: image_build - ${generated}${verified ? ` verified as ${verified.trim()}` : ''}.`
				: 'Result: image_build completed.';
		}

		const detail = rawDetails.join(' ').replace(/\s+/g, ' ').trim();
		return detail
			? `Result: ${toolName} - ${detail}`
			: `Result: ${toolName} completed.`;
	}
}
