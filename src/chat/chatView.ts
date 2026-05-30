import * as vscode from 'vscode';
import { ChatImageAttachment, ChatTraceRecord, ExecutionMode, RecentConversationRecord } from '../core/types';

export interface ChatPanelHost {
	handlePrompt(text: string, attachments?: ChatImageAttachment[]): Promise<void>;
	handleTranscribeVoice(dataUrl: string, mimeType: string): Promise<string>;
	handleOpenVoiceCapture(): Promise<void>;
	handleWebviewReady(): Promise<void>;
	handleInterruptTurn(): Promise<void>;
	handleSetApiKey(): Promise<void>;
	handleStartDevServer(): Promise<void>;
	handleStopDevServer(): Promise<void>;
	handleExecutionModeChange(mode: ExecutionMode): Promise<void>;
	handleToggleMemoryMode(): Promise<void>;
	handleOpenRecentConversation(id: string): Promise<void>;
	handleDeleteRecentConversation(id: string): Promise<void>;
}

export interface ChatPanelState {
	workspaceLabel: string;
	extensionVersion?: string;
	apiKeyConfigured: boolean;
	executorModel: string;
	devServerRunning?: boolean;
	executionMode?: ExecutionMode;
	persistSensitiveHistory?: boolean;
	recentConversations?: RecentConversationRecord[];
}

export interface ChatSurface {
	postSystem(text: string): void;
	postUser(text: string): void;
	postAssistant(text: string, messageId?: string): void;
	updateAssistant(text: string, messageId: string): void;
	postTrace(trace: ChatTraceRecord): void;
	appendLog(text: string): void;
	finishWorkTrace(meta?: { tokenCount?: number }): void;
	appendPromptText(text: string): void;
	clearAll(): void;
	setBusy(isBusy: boolean): void;
	setStatus(text: string): void;
	setState(state: ChatPanelState): void;
}

function buildHtml(webview: vscode.Webview): string {
	const nonce = String(Date.now());
	const csp = [
		"default-src 'none'",
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
		'media-src blob: data:',
	].join('; ');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Build by Grok</title>
	<style>
		:root {
			color-scheme: light dark;
			--bg: var(--vscode-editor-background);
			--fg: var(--vscode-editor-foreground);
			--muted: var(--vscode-descriptionForeground);
			--border: var(--vscode-panel-border);
			--button: var(--vscode-button-background);
			--button-fg: var(--vscode-button-foreground);
			--surface: color-mix(in srgb, var(--bg) 90%, white 10%);
			--surface-strong: color-mix(in srgb, var(--bg) 82%, white 18%);
			--input-fg: var(--vscode-input-foreground);
			--focus: var(--vscode-focusBorder);
		}

		* {
			box-sizing: border-box;
		}

		body {
			margin: 0;
			height: 100vh;
			min-width: 0;
			display: grid;
			grid-template-rows: auto minmax(0, 1fr) auto;
			background: var(--bg);
			color: var(--fg);
			font-family: var(--vscode-font-family, "Segoe UI", sans-serif);
			font-size: var(--vscode-font-size, 13px);
		}

		.header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			padding: 14px 16px 10px;
			border-bottom: 1px solid var(--border);
			min-width: 0;
		}

		.title {
			font-size: 12px;
			font-weight: 700;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--muted);
			white-space: nowrap;
		}

		.meta {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			color: var(--muted);
			font-size: 12px;
			text-align: right;
		}

		.messages {
			min-width: 0;
			overflow-y: auto;
			display: grid;
			align-content: start;
			gap: 14px;
			padding: 18px 16px;
		}

		.tasks {
			display: none;
			gap: 4px;
			padding: 0 0 12px;
			border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
		}

		.tasks.has-items {
			display: grid;
		}

		.tasks-title {
			color: var(--muted);
			font-size: 12px;
			padding: 0 2px 5px;
		}

		.task-row {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto auto;
			align-items: center;
			gap: 8px;
			width: 100%;
			height: auto;
			padding: 7px 8px;
			border: 0;
			border-radius: 8px;
			background: transparent;
			text-align: left;
		}

		.task-row:hover {
			background: color-mix(in srgb, var(--surface) 82%, white 18%);
		}

		.task-main {
			min-width: 0;
			display: grid;
			gap: 2px;
		}

		.task-title {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			color: var(--fg);
		}

		.task-path,
		.task-age {
			color: var(--muted);
			font-size: 12px;
		}

		.task-path {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.task-delete {
			width: 26px;
			height: 26px;
			padding: 0;
			border: 0;
			background: transparent;
			color: var(--muted);
		}

		.message {
			width: fit-content;
			max-width: min(100%, 78ch);
			min-width: 0;
			padding: 13px 15px;
			border-radius: 18px;
			border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
			background: var(--surface);
			line-height: 1.55;
		}

		.message.user {
			justify-self: end;
			background: color-mix(in srgb, var(--button) 20%, var(--surface-strong) 80%);
		}

		.message.assistant,
		.message.system {
			justify-self: start;
		}

		.message.system {
			background: transparent;
			border: 0;
			padding: 0;
			color: var(--muted);
			font-size: 12px;
		}

		.message-body {
			white-space: pre-wrap;
			overflow-wrap: anywhere;
		}

			.work-trace {
				justify-self: start;
				display: block;
				width: min(100%, 78ch);
				max-width: min(100%, 78ch);
				border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
				border-radius: 14px;
				background: color-mix(in srgb, var(--surface) 84%, transparent);
			color: var(--muted);
			font-size: 12px;
			overflow: hidden;
		}

			.work-trace summary {
				display: block;
				cursor: pointer;
				user-select: none;
				padding: 9px 12px;
				color: var(--fg);
				list-style: none;
				min-height: 34px;
			}

		.work-trace summary::-webkit-details-marker {
			display: none;
		}

		.work-trace summary::before {
			content: ">";
			display: inline-block;
			margin-right: 8px;
			color: var(--muted);
			transition: transform 120ms ease;
		}

		.work-trace[open] summary::before {
			transform: rotate(90deg);
		}

		.work-trace-body {
			display: grid;
			gap: 5px;
			padding: 0 12px 11px;
			white-space: pre-wrap;
		}

		.work-trace-line {
			overflow-wrap: anywhere;
		}

		.stage {
			padding: 0 16px 16px;
			min-width: 0;
		}

		.composer {
			display: grid;
			gap: 12px;
			min-width: 0;
			padding: 14px;
			border-radius: 22px;
			border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
			background: var(--surface);
		}

		textarea {
			width: 100%;
			min-width: 0;
			min-height: 110px;
			max-height: 320px;
			resize: vertical;
			border: 0;
			outline: none;
			background: transparent;
			color: var(--input-fg);
			font: inherit;
			line-height: 1.55;
		}

		textarea:focus {
			outline: 1px solid transparent;
		}

		.actions {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: center;
			gap: 10px;
			min-width: 0;
		}

		.left-actions,
		.right-actions {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			min-width: 0;
		}

		.left-actions {
			flex-wrap: wrap;
		}

		button {
			height: 34px;
			border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
			border-radius: 999px;
			background: color-mix(in srgb, var(--bg) 92%, white 8%);
			color: var(--fg);
			font: inherit;
			cursor: pointer;
		}

		button:hover {
			border-color: var(--focus);
		}

		.add-file {
			width: 34px;
			padding: 0;
			font-size: 20px;
			line-height: 1;
		}

		.plus-wrap {
			position: relative;
			display: inline-flex;
		}

		.plus-menu {
			position: absolute;
			left: 0;
			bottom: 42px;
			width: min(280px, 78vw);
			display: none;
			padding: 8px;
			border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
			border-radius: 16px;
			background: var(--surface-strong);
			box-shadow: 0 14px 36px rgba(0, 0, 0, 0.24);
			z-index: 10;
		}

		.plus-menu.open {
			display: grid;
			gap: 6px;
		}

		.menu-row {
			width: 100%;
			min-height: 38px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			padding: 8px 10px;
			border: 0;
			border-radius: 12px;
			background: transparent;
			color: var(--fg);
			text-align: left;
		}

		.menu-row:hover {
			background: color-mix(in srgb, var(--bg) 82%, white 18%);
		}

		.menu-row.disabled {
			cursor: not-allowed;
			opacity: 0.48;
		}

		.menu-row.disabled:hover {
			background: transparent;
			border-color: transparent;
		}

		.menu-text {
			display: grid;
			gap: 2px;
			min-width: 0;
		}

		.menu-title {
			font-size: 13px;
			white-space: nowrap;
		}

		.menu-detail {
			color: var(--muted);
			font-size: 11px;
			white-space: normal;
		}

		.toggle {
			position: relative;
			width: 42px;
			height: 24px;
			flex: 0 0 auto;
			border-radius: 999px;
			background: color-mix(in srgb, var(--bg) 70%, white 30%);
			border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
		}

		.toggle::after {
			content: '';
			position: absolute;
			top: 3px;
			left: 3px;
			width: 16px;
			height: 16px;
			border-radius: 999px;
			background: var(--muted);
			transition: transform 120ms ease, background 120ms ease;
		}

		.toggle.on {
			background: color-mix(in srgb, var(--button) 78%, var(--bg) 22%);
		}

		.toggle.on::after {
			transform: translateX(18px);
			background: var(--button-fg);
		}

		.api-key {
			padding: 0 14px;
			white-space: nowrap;
		}

		.server {
			padding: 0 14px;
			white-space: nowrap;
		}

			.send,
			.voice-record {
				width: 48px;
				min-width: 48px;
				padding: 0;
				border-color: transparent;
				font-size: 18px;
				font-weight: 600;
				line-height: 1;
			}

			.send {
				background: var(--button);
				color: var(--button-fg);
			}

			.voice-record {
				display: none;
				background: color-mix(in srgb, var(--button) 72%, #1a9fcb 28%);
				color: var(--button-fg);
			}

			.voice-record.visible {
				display: inline-block;
			}

		.attachments {
			display: none;
			flex-wrap: wrap;
			gap: 8px;
			min-width: 0;
		}

		.attachments.has-items {
			display: flex;
		}

		.attachment-chip {
			display: inline-flex;
			align-items: center;
			gap: 7px;
			max-width: 100%;
			height: 28px;
			padding: 0 10px;
			border-radius: 999px;
			border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
			background: color-mix(in srgb, var(--bg) 92%, white 8%);
			color: var(--muted);
			font-size: 12px;
		}

		.attachment-chip span {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.remove-attachment {
			width: 18px;
			height: 18px;
			padding: 0;
			border: 0;
			background: transparent;
			color: var(--muted);
			font-size: 14px;
			line-height: 18px;
		}

		.send.busy {
			background: color-mix(in srgb, var(--button) 70%, #cc3333 30%);
		}

			.voice-record.voice {
				background: color-mix(in srgb, var(--button) 72%, #1a9fcb 28%);
			}

			.voice-record.listening {
				background: color-mix(in srgb, var(--button) 45%, #d24b4b 55%);
				box-shadow: 0 0 0 4px color-mix(in srgb, #d24b4b 22%, transparent);
			}

		.status {
			padding: 0 16px 12px;
			color: var(--muted);
			font-size: 12px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
	</style>
</head>
<body>
	<header class="header">
		<div class="title">Build by Grok</div>
		<div class="meta" id="meta">Loading...</div>
	</header>
	<main class="messages" id="messages" aria-live="polite">
		<section class="tasks" id="tasks">
			<div class="tasks-title">Recent chats</div>
			<div id="taskList"></div>
		</section>
	</main>
	<section class="stage">
		<div class="composer">
			<textarea id="prompt" placeholder="Ask Grok to inspect, edit, or test the current repo."></textarea>
			<div class="attachments" id="attachments"></div>
			<div class="actions">
				<div class="left-actions">
					<div class="plus-wrap">
						<button class="add-file" id="addFile" type="button" aria-label="Open actions menu">+</button>
						<div class="plus-menu" id="plusMenu">
							<button class="menu-row" id="addAttachment" type="button">
								<span class="menu-text">
									<span class="menu-title">Add image/file</span>
									<span class="menu-detail">Attach screenshots, images, or text files.</span>
								</span>
							</button>
							<button class="menu-row" id="accessToggle" type="button">
								<span class="menu-text">
									<span class="menu-title">Full access</span>
									<span class="menu-detail">Autonomous file edits and commands.</span>
								</span>
								<span class="toggle" id="accessToggleVisual"></span>
							</button>
							<button class="menu-row" id="memoryToggle" type="button">
								<span class="menu-text">
									<span class="menu-title">Chat memory</span>
									<span class="menu-detail">Save recent chats locally in VS Code.</span>
								</span>
								<span class="toggle" id="memoryToggleVisual"></span>
							</button>
							<button class="menu-row" id="voiceToggle" type="button">
								<span class="menu-text">
									<span class="menu-title">Voice mode</span>
											<span class="menu-detail">Use mic to add text, Enter or rocket to send.</span>
								</span>
								<span class="toggle" id="voiceToggleVisual"></span>
							</button>
						</div>
					</div>
					<button class="api-key" id="apiKey" type="button">xAI API key</button>
					<button class="server" id="server" type="button">Start Server</button>
					</div>
					<div class="right-actions">
						<button class="voice-record" id="voiceRecord" type="button" aria-label="Start voice dictation">🎤</button>
						<button class="send" id="send" type="button" aria-label="Send prompt">🚀</button>
					</div>
			</div>
			<input id="fileInput" type="file" multiple hidden />
		</div>
	</section>
	<div class="status" id="status">Ready.</div>

	<script nonce="${nonce}">
		(() => {
			const vscode = acquireVsCodeApi();
			const messages = document.getElementById('messages');
			const tasks = document.getElementById('tasks');
			const taskList = document.getElementById('taskList');
				const prompt = document.getElementById('prompt');
				const send = document.getElementById('send');
				const voiceRecord = document.getElementById('voiceRecord');
			const apiKey = document.getElementById('apiKey');
			const server = document.getElementById('server');
			const addFile = document.getElementById('addFile');
			const plusMenu = document.getElementById('plusMenu');
			const addAttachment = document.getElementById('addAttachment');
			const accessToggle = document.getElementById('accessToggle');
			const accessToggleVisual = document.getElementById('accessToggleVisual');
			const memoryToggle = document.getElementById('memoryToggle');
			const memoryToggleVisual = document.getElementById('memoryToggleVisual');
			const voiceToggle = document.getElementById('voiceToggle');
			const voiceToggleVisual = document.getElementById('voiceToggleVisual');
			const fileInput = document.getElementById('fileInput');
			const attachmentsEl = document.getElementById('attachments');
			const status = document.getElementById('status');
			const meta = document.getElementById('meta');
			const assistantMessages = new Map();
			const selectedFiles = [];
			let busy = false;
			let devServerRunning = false;
			let fullAccessEnabled = false;
			let memoryEnabled = false;
			let voiceModeEnabled = false;
			let voiceSupported = true;
			let currentWorkTrace = null;
			let workTraceStartedAt = 0;
			let workTraceCount = 0;
			let workTraceTokenCount = 0;

			function reportError(error) {
				const text = error && error.stack ? error.stack : String(error);
				vscode.postMessage({ type: 'webviewError', text });
			}

			window.addEventListener('error', (event) => reportError(event.error || event.message));
			window.addEventListener('unhandledrejection', (event) => reportError(event.reason));

			function scrollToEnd() {
				messages.scrollTop = messages.scrollHeight;
			}

			function setStatus(text) {
				status.textContent = text || 'Ready.';
			}

			function formatDuration(ms) {
				if (!Number.isFinite(ms) || ms < 0) {
					return '0s';
				}
				const seconds = Math.max(1, Math.round(ms / 1000));
				if (seconds < 60) {
					return seconds + 's';
				}
				const minutes = Math.floor(seconds / 60);
				const rest = seconds % 60;
				return minutes + 'm ' + String(rest).padStart(2, '0') + 's';
			}

			function updateWorkTraceSummary() {
				if (!currentWorkTrace) {
					return;
				}
				const elapsed = workTraceStartedAt ? formatDuration(Date.now() - workTraceStartedAt) : '0s';
				const tokenPart = workTraceTokenCount > 0 ? ' · ' + workTraceTokenCount.toLocaleString() + ' tokens' : '';
				currentWorkTrace.summary.textContent = 'Worked for ' + elapsed + tokenPart;
			}

			function renderWorkTrace(trace) {
				if (!trace || !String(trace.text || '').trim()) {
					return;
				}
				const details = document.createElement('details');
				details.className = 'work-trace';
				details.open = false;
				const summary = document.createElement('summary');
				const elapsed = Number.isFinite(trace.elapsedMs) ? formatDuration(Number(trace.elapsedMs)) : '0s';
				const tokenPart = Number.isFinite(trace.tokenCount) && Number(trace.tokenCount) > 0
					? ' · ' + Math.round(Number(trace.tokenCount)).toLocaleString() + ' tokens'
					: '';
				summary.textContent = 'Worked for ' + elapsed + tokenPart;
				const body = document.createElement('div');
				body.className = 'work-trace-body';
				for (const rawLine of String(trace.text || '').split('\\n')) {
					const cleanLine = rawLine.trim();
					if (!cleanLine) {
						continue;
					}
					const line = document.createElement('div');
					line.className = 'work-trace-line';
					line.textContent = cleanLine;
					body.appendChild(line);
				}
				details.appendChild(summary);
				details.appendChild(body);
				messages.appendChild(details);
				scrollToEnd();
			}

			function beginWorkTrace() {
				workTraceStartedAt = Date.now();
				workTraceCount = 0;
				workTraceTokenCount = 0;
				const details = document.createElement('details');
				details.className = 'work-trace';
				details.open = true;
				const summary = document.createElement('summary');
				const body = document.createElement('div');
				body.className = 'work-trace-body';
				details.appendChild(summary);
				details.appendChild(body);
				messages.appendChild(details);
				currentWorkTrace = { details, summary, body };
				updateWorkTraceSummary();
				scrollToEnd();
			}

			function appendWorkTrace(text) {
				if (!text) {
					return;
				}
				if (!currentWorkTrace) {
					beginWorkTrace();
				}
				const line = document.createElement('div');
				line.className = 'work-trace-line';
				line.textContent = text;
				currentWorkTrace.body.appendChild(line);
				workTraceCount += 1;
				updateWorkTraceSummary();
				scrollToEnd();
			}

			function finishWorkTrace(meta) {
				if (!currentWorkTrace) {
					return;
				}
				if (meta && Number.isFinite(meta.tokenCount) && meta.tokenCount > 0) {
					workTraceTokenCount = Math.round(meta.tokenCount);
				}
				if (workTraceCount === 0) {
					currentWorkTrace.details.remove();
					currentWorkTrace = null;
					workTraceStartedAt = 0;
					workTraceTokenCount = 0;
					return;
				}
				updateWorkTraceSummary();
				currentWorkTrace.details.open = false;
				currentWorkTrace = null;
			}

			function appendMessage(role, text, id) {
				const item = document.createElement('article');
				item.className = 'message ' + role;
				if (id) {
					item.dataset.messageId = id;
				}

				const body = document.createElement('div');
				body.className = 'message-body';
				body.textContent = text || '';
				item.appendChild(body);
				messages.appendChild(item);

				if (id && role === 'assistant') {
					assistantMessages.set(id, body);
				}

				scrollToEnd();
			}

			function formatAge(iso) {
				const elapsed = Date.now() - Date.parse(iso || '');
				if (!Number.isFinite(elapsed) || elapsed < 0) {
					return '';
				}
				const minute = 60 * 1000;
				const hour = 60 * minute;
				const day = 24 * hour;
				const week = 7 * day;
				if (elapsed < minute) {
					return 'now';
				}
				if (elapsed < hour) {
					return Math.floor(elapsed / minute) + 'm';
				}
				if (elapsed < day) {
					return Math.floor(elapsed / hour) + 'h';
				}
				if (elapsed < week) {
					return Math.floor(elapsed / day) + 'd';
				}
				return Math.floor(elapsed / week) + 'w';
			}

			function renderRecentConversations(conversations) {
				taskList.textContent = '';
				const entries = Array.isArray(conversations) ? conversations.slice(0, 5) : [];
				tasks.classList.toggle('has-items', entries.length > 0);
				for (const entry of entries) {
					const row = document.createElement('button');
					row.className = 'task-row';
					row.type = 'button';
					row.addEventListener('click', () => {
						vscode.postMessage({ type: 'openRecentConversation', id: entry.id });
					});

					const main = document.createElement('span');
					main.className = 'task-main';
					const title = document.createElement('span');
					title.className = 'task-title';
					title.textContent = entry.title || entry.workspaceLabel || 'Untitled conversation';
					const path = document.createElement('span');
					path.className = 'task-path';
					path.textContent = entry.workspacePath || entry.workspaceLabel || '';
					main.appendChild(title);
					main.appendChild(path);

					const age = document.createElement('span');
					age.className = 'task-age';
					age.textContent = formatAge(entry.updatedAt);

					const del = document.createElement('button');
					del.className = 'task-delete';
					del.type = 'button';
					del.title = 'Delete conversation';
					del.textContent = '×';
					del.addEventListener('click', (event) => {
						event.stopPropagation();
						vscode.postMessage({ type: 'deleteRecentConversation', id: entry.id });
					});

					row.appendChild(main);
					row.appendChild(age);
					row.appendChild(del);
					taskList.appendChild(row);
				}
			}

			function updateAssistant(text, id) {
				if (!id) {
					appendMessage('assistant', text);
					return;
				}

				let body = assistantMessages.get(id);
				if (!body) {
					appendMessage('assistant', text, id);
					return;
				}

				body.textContent = text || '';
				scrollToEnd();
			}

			function setBusy(nextBusy) {
				const wasBusy = busy;
				busy = Boolean(nextBusy);
				if (!busy && wasBusy) {
					finishWorkTrace();
				}
				updateSendControl();
			}

			function updateServerButton() {
				server.textContent = devServerRunning ? 'Stop Server' : 'Start Server';
			}

			function closePlusMenu() {
				plusMenu.classList.remove('open');
			}

			function togglePlusMenu() {
				plusMenu.classList.toggle('open');
			}

			function updateAccessToggle() {
				accessToggleVisual.classList.toggle('on', fullAccessEnabled);
				accessToggle.setAttribute('aria-pressed', String(fullAccessEnabled));
			}

			function updateMemoryToggle() {
				memoryToggleVisual.classList.toggle('on', memoryEnabled);
				memoryToggle.setAttribute('aria-pressed', String(memoryEnabled));
			}

			function updateVoiceToggle() {
				voiceToggle.classList.toggle('disabled', !voiceSupported);
				voiceToggle.disabled = !voiceSupported;
				voiceToggle.title = voiceSupported
					? 'Open the voice capture panel.'
					: 'Voice mode is not supported in this VS Code runtime.';
				voiceToggleVisual.classList.toggle('on', voiceModeEnabled);
				voiceToggleVisual.classList.toggle('disabled', !voiceSupported);
				voiceToggle.setAttribute('aria-pressed', String(voiceModeEnabled));
				updateSendControl();
			}

			function checkVoiceSupport() {
				voiceSupported = true;
				updateVoiceToggle();
				return voiceSupported;
			}

			function updateSendControl() {
				send.classList.toggle('busy', busy);
				voiceRecord.classList.toggle('visible', voiceModeEnabled);
				voiceRecord.classList.toggle('voice', voiceModeEnabled && !busy);
				voiceRecord.classList.remove('listening');
				voiceRecord.disabled = busy;
				voiceRecord.textContent = '🎤';
				voiceRecord.setAttribute('aria-label', 'Open voice capture');
				if (busy) {
					send.disabled = false;
					send.textContent = '■';
					send.setAttribute('aria-label', 'Stop current run');
					return;
				}
				send.disabled = false;
				send.textContent = '🚀';
				send.setAttribute('aria-label', 'Send prompt');
			}

			function isTextLike(file) {
				const name = file.name.toLowerCase();
				return file.type.startsWith('text/')
					|| /\\.(txt|md|mdx|json|jsonc|js|jsx|ts|tsx|css|scss|html|astro|vue|svelte|xml|yaml|yml|toml|env|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|sh|bash|zsh|sql)$/i.test(name);
			}

			function readFile(file, mode) {
				return new Promise((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => resolve(String(reader.result || ''));
					reader.onerror = () => reject(reader.error || new Error('Unable to read file.'));
					if (mode === 'dataUrl') {
						reader.readAsDataURL(file);
					} else {
						reader.readAsText(file);
					}
				});
			}

			function renderAttachments() {
				attachmentsEl.textContent = '';
				attachmentsEl.classList.toggle('has-items', selectedFiles.length > 0);
				for (const file of selectedFiles) {
					const chip = document.createElement('div');
					chip.className = 'attachment-chip';

					const label = document.createElement('span');
					label.textContent = file.name;
					chip.appendChild(label);

					const remove = document.createElement('button');
					remove.className = 'remove-attachment';
					remove.type = 'button';
					remove.setAttribute('aria-label', 'Remove ' + file.name);
					remove.textContent = 'x';
					remove.addEventListener('click', () => {
						const index = selectedFiles.indexOf(file);
						if (index >= 0) {
							selectedFiles.splice(index, 1);
							renderAttachments();
							setStatus(selectedFiles.length ? selectedFiles.length + ' attachment(s) ready.' : 'Ready.');
						}
					});
					chip.appendChild(remove);
					attachmentsEl.appendChild(chip);
				}
			}

			async function addSelectedFiles(files) {
				for (const file of files) {
					try {
						if (file.type.startsWith('image/')) {
							selectedFiles.push({
								kind: 'image',
								name: file.name,
								mimeType: file.type || 'application/octet-stream',
								dataUrl: await readFile(file, 'dataUrl')
							});
						} else if (isTextLike(file)) {
							const text = await readFile(file, 'text');
							selectedFiles.push({
								kind: 'text',
								name: file.name,
								mimeType: file.type || 'text/plain',
								text: text.slice(0, 80000),
								truncated: text.length > 80000
							});
						} else {
							selectedFiles.push({
								kind: 'note',
								name: file.name,
								mimeType: file.type || 'application/octet-stream',
								text: 'Binary file selected but not embedded: ' + file.name
							});
						}
					} catch (error) {
						reportError(error);
						setStatus('Could not attach ' + file.name + '.');
					}
				}
				renderAttachments();
				setStatus(selectedFiles.length ? selectedFiles.length + ' attachment(s) ready.' : 'Ready.');
			}

			async function addClipboardImages(event) {
				const items = Array.from((event.clipboardData && event.clipboardData.items) || []);
				const imageFiles = items
					.filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
					.map((item, index) => {
						const file = item.getAsFile();
						if (!file) {
							return undefined;
						}
						const extension = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9.+-]/gi, '') || 'png';
						const name = file.name && file.name !== 'image.png'
							? file.name
							: 'pasted-screenshot-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + (index + 1) + '.' + extension;
						return new File([file], name, { type: file.type || 'image/png' });
					})
					.filter(Boolean);

				if (imageFiles.length === 0) {
					return;
				}

				event.preventDefault();
				await addSelectedFiles(imageFiles);
				setStatus(imageFiles.length + ' pasted screenshot/image attachment(s) ready.');
			}

			function buildFilePromptText(baseText) {
				const textFiles = selectedFiles.filter((file) => file.kind !== 'image');
				if (textFiles.length === 0) {
					return baseText;
				}

				const sections = textFiles.map((file) => {
					const suffix = file.truncated ? '\\n[File truncated to first 80000 characters]' : '';
					return 'Attached file: ' + file.name + ' (' + file.mimeType + ')\\n~~~\\n' + (file.text || '') + suffix + '\\n~~~';
				});
				return [baseText, ...sections].filter(Boolean).join('\\n\\n');
			}

			function sendPrompt() {
				if (busy) {
					vscode.postMessage({ type: 'interruptTurn' });
					return;
				}

				const text = buildFilePromptText(prompt.value.trim()).trim();
				const imageAttachments = selectedFiles
					.filter((file) => file.kind === 'image')
					.map((file) => ({
						name: file.name,
						mimeType: file.mimeType,
						dataUrl: file.dataUrl
					}));
				if (!text && imageAttachments.length === 0) {
					prompt.focus();
					return;
				}

				prompt.value = '';
				selectedFiles.length = 0;
				renderAttachments();
				vscode.postMessage({ type: 'prompt', text, attachments: imageAttachments });
			}

			async function startVoiceDictation() {
				if (busy) {
					vscode.postMessage({ type: 'interruptTurn' });
					return;
				}

				setStatus('Opening voice capture panel...');
				vscode.postMessage({ type: 'openVoiceCapture' });
			}

			send.addEventListener('click', () => {
				sendPrompt();
			});
			voiceRecord.addEventListener('click', () => {
				void startVoiceDictation();
			});
			apiKey.addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
			server.addEventListener('click', () => {
				vscode.postMessage({ type: devServerRunning ? 'stopDevServer' : 'startDevServer' });
			});
			addFile.addEventListener('click', (event) => {
				event.stopPropagation();
				togglePlusMenu();
			});
			addAttachment.addEventListener('click', () => {
				closePlusMenu();
				fileInput.click();
			});
			accessToggle.addEventListener('click', () => {
				const nextMode = fullAccessEnabled ? 'verify' : 'autonomous';
				closePlusMenu();
				vscode.postMessage({ type: 'setExecutionMode', mode: nextMode });
			});
			memoryToggle.addEventListener('click', () => {
				closePlusMenu();
				vscode.postMessage({ type: 'toggleMemoryMode' });
			});
			voiceToggle.addEventListener('click', () => {
				if (!checkVoiceSupport()) {
					closePlusMenu();
					appendMessage('system', 'Voice mode is not supported in this VS Code runtime. No project package install is available for this voice path.');
					setStatus('Voice mode unavailable.');
					return;
				}
				voiceModeEnabled = !voiceModeEnabled;
				closePlusMenu();
					updateVoiceToggle();
					const message = voiceModeEnabled
						? 'Voice mode is now on. Use the mic to add text, then press Enter or click the rocket when ready to send.'
						: 'Voice mode is now off.';
				appendMessage('system', message);
				setStatus(message);
			});
			document.addEventListener('click', (event) => {
				if (!plusMenu.contains(event.target) && event.target !== addFile) {
					closePlusMenu();
				}
			});
			fileInput.addEventListener('change', () => {
				const files = Array.from(fileInput.files || []);
				fileInput.value = '';
				void addSelectedFiles(files);
			});
			prompt.addEventListener('keydown', (event) => {
				if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
					event.preventDefault();
					sendPrompt();
				}
			});
			prompt.addEventListener('paste', (event) => {
				void addClipboardImages(event);
			});

			window.addEventListener('message', (event) => {
				try {
					const message = event.data || {};
					switch (message.type) {
						case 'appendMessage':
							appendMessage(message.role || 'assistant', message.text || '', message.id);
							break;
						case 'updateAssistant':
							updateAssistant(message.text || '', message.id);
							break;
						case 'appendLog':
							appendWorkTrace(message.text || '');
							break;
						case 'appendTrace':
							renderWorkTrace(message.trace);
							break;
						case 'finishWorkTrace':
							finishWorkTrace({ tokenCount: Number(message.tokenCount || 0) });
							break;
						case 'appendSystem':
							appendMessage('system', message.text || '');
							break;
						case 'clearAll':
							for (const child of Array.from(messages.children)) {
								if (child !== tasks) {
									child.remove();
								}
							}
							assistantMessages.clear();
							currentWorkTrace = null;
							workTraceStartedAt = 0;
							workTraceCount = 0;
							workTraceTokenCount = 0;
							break;
						case 'setBusy':
							setBusy(message.isBusy);
							break;
						case 'setStatus':
							setStatus(message.text);
							break;
						case 'voiceTranscription': {
							const text = String(message.text || '').trim();
							if (!text) {
								setStatus('No voice text captured.');
								break;
							}
							prompt.value = [prompt.value.trim(), text].filter(Boolean).join(' ').trimStart();
							setStatus('Voice transcribed. Review, then press Enter or click the rocket to send.');
							prompt.focus();
							break;
						}
						case 'voiceTranscriptionError':
							appendMessage('system', message.text || 'Voice transcription failed.');
							setStatus('Voice transcription failed.');
							break;
						case 'appendPromptText': {
							const text = String(message.text || '').trim();
							if (text) {
								prompt.value = [prompt.value.trim(), text].filter(Boolean).join(' ').trimStart();
								setStatus('Voice transcribed. Review, then press Enter or click the rocket to send.');
								prompt.focus();
							}
							break;
						}
						case 'setState': {
							const state = message.state || {};
							const parts = [];
							if (state.workspaceLabel) {
								parts.push(state.workspaceLabel);
							}
							if (state.executorModel) {
								parts.push(state.executorModel);
							}
							if (state.extensionVersion) {
								parts.push('v' + state.extensionVersion);
							}
							devServerRunning = Boolean(state.devServerRunning);
							updateServerButton();
							fullAccessEnabled = state.executionMode === 'autonomous';
							updateAccessToggle();
							memoryEnabled = Boolean(state.persistSensitiveHistory);
							updateMemoryToggle();
							renderRecentConversations(state.recentConversations);
							parts.push(state.apiKeyConfigured ? 'API key set' : 'API key needed');
							meta.textContent = parts.join(' | ');
							break;
						}
					}
				} catch (error) {
					reportError(error);
				}
			});

			setStatus('Ready.');
			updateServerButton();
			updateAccessToggle();
			updateMemoryToggle();
			checkVoiceSupport();
			vscode.postMessage({ type: 'webviewReady' });
			prompt.focus();
		})();
	</script>
</body>
</html>`;
}

class ChatWebviewSurface implements ChatSurface {
	private disposed = false;

	public constructor(
		private readonly webview: vscode.Webview,
		private readonly host: ChatPanelHost,
	) {
		this.webview.html = buildHtml(webview);
		this.webview.onDidReceiveMessage((message) => {
			void this.handleMessage(message);
		});
	}

	public dispose(): void {
		this.disposed = true;
	}

	public postSystem(text: string): void {
		this.post({ type: 'appendSystem', text });
	}

	public postUser(text: string): void {
		this.post({ type: 'appendMessage', role: 'user', text });
	}

	public postAssistant(text: string, messageId?: string): void {
		this.post({ type: 'appendMessage', role: 'assistant', text, id: messageId });
	}

	public updateAssistant(text: string, messageId: string): void {
		this.post({ type: 'updateAssistant', text, id: messageId });
	}

	public postTrace(trace: ChatTraceRecord): void {
		this.post({ type: 'appendTrace', trace });
	}

	public appendLog(text: string): void {
		this.post({ type: 'appendLog', text });
	}

	public finishWorkTrace(meta?: { tokenCount?: number }): void {
		this.post({ type: 'finishWorkTrace', tokenCount: meta?.tokenCount });
	}

	public appendPromptText(text: string): void {
		this.post({ type: 'appendPromptText', text });
	}

	public clearAll(): void {
		this.post({ type: 'clearAll' });
	}

	public setBusy(isBusy: boolean): void {
		this.post({ type: 'setBusy', isBusy });
	}

	public setStatus(text: string): void {
		this.post({ type: 'setStatus', text });
	}

	public setState(state: ChatPanelState): void {
		this.post({ type: 'setState', state });
	}

	private post(message: unknown): void {
		if (!this.disposed) {
			void this.webview.postMessage(message);
		}
	}

	private async handleMessage(message: { type?: string; text?: string; id?: string; attachments?: ChatImageAttachment[]; mode?: ExecutionMode; dataUrl?: string; mimeType?: string }): Promise<void> {
		switch (message.type) {
			case 'webviewReady':
				await this.host.handleWebviewReady();
				break;
			case 'prompt':
				await this.host.handlePrompt(message.text ?? '', message.attachments ?? []);
				break;
			case 'transcribeVoice':
				try {
					const text = await this.host.handleTranscribeVoice(message.dataUrl ?? '', message.mimeType ?? 'audio/webm');
					this.post({ type: 'voiceTranscription', text });
				} catch (error) {
					this.post({ type: 'voiceTranscriptionError', text: error instanceof Error ? error.message : String(error) });
				}
				break;
			case 'openVoiceCapture':
				await this.host.handleOpenVoiceCapture();
				break;
			case 'interruptTurn':
				await this.host.handleInterruptTurn();
				break;
			case 'setApiKey':
				await this.host.handleSetApiKey();
				break;
			case 'startDevServer':
				await this.host.handleStartDevServer();
				break;
			case 'stopDevServer':
				await this.host.handleStopDevServer();
				break;
			case 'setExecutionMode':
				await this.host.handleExecutionModeChange(message.mode === 'autonomous' ? 'autonomous' : 'verify');
				break;
			case 'toggleMemoryMode':
				await this.host.handleToggleMemoryMode();
				break;
			case 'openRecentConversation':
				await this.host.handleOpenRecentConversation(message.id ?? '');
				break;
			case 'deleteRecentConversation':
				await this.host.handleDeleteRecentConversation(message.id ?? '');
				break;
			case 'webviewError':
				void vscode.window.showErrorMessage(`Build by Grok chat error: ${message.text ?? 'Unknown webview error'}`);
				break;
		}
	}
}

export class ChatPanel {
	private static current: ChatPanel | undefined;
	private readonly surface: ChatWebviewSurface;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		host: ChatPanelHost,
	) {
		this.panel.webview.options = {
			enableScripts: true,
		};
		this.surface = new ChatWebviewSurface(this.panel.webview, host);
		this.panel.onDidDispose(() => {
			this.surface.dispose();
			ChatPanel.current = undefined;
		});
	}

	public static createOrShow(context: vscode.ExtensionContext, host: ChatPanelHost): ChatPanel {
		if (ChatPanel.current) {
			ChatPanel.current.panel.reveal(vscode.ViewColumn.Beside);
			return ChatPanel.current;
		}

		const panel = vscode.window.createWebviewPanel(
			'grokrepchat.chat',
			'Build by Grok',
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [context.extensionUri],
			},
		);
		ChatPanel.current = new ChatPanel(panel, host);
		return ChatPanel.current;
	}

	public getSurface(): ChatSurface {
		return this.surface;
	}

	public setTitle(title: string): void {
		this.panel.title = title;
	}
}

export class ChatSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'grokrepchat.sidebar';
	private surface: ChatWebviewSurface | undefined;

	public constructor(
		private readonly host: ChatPanelHost,
		private readonly onResolve?: () => Promise<void> | void,
	) {}

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		webviewView.webview.options = {
			enableScripts: true,
		};
		this.surface = new ChatWebviewSurface(webviewView.webview, this.host);
		webviewView.onDidDispose(() => {
			this.surface?.dispose();
			this.surface = undefined;
		});
		void this.onResolve?.();
	}

	public getSurface(): ChatSurface | undefined {
		return this.surface;
	}

	public reveal(): void {
		void vscode.commands.executeCommand('grokrepchat.sidebar.focus');
	}
}
