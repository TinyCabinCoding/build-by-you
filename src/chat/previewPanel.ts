import * as vscode from 'vscode';

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function normalizePreviewUrl(value?: string): string | undefined {
	if (!value) {
		return undefined;
	}

	try {
		const parsed = new URL(value);
		const hostname = parsed.hostname.toLowerCase();
		if (!['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname)) {
			return undefined;
		}

		if (!['http:', 'https:'].includes(parsed.protocol)) {
			return undefined;
		}

		return parsed.toString();
	} catch {
		return undefined;
	}
}

function withCacheBust(value: string): string {
	try {
		const parsed = new URL(value);
		parsed.searchParams.set('_grok_preview', String(Date.now()));
		return parsed.toString();
	} catch {
		return value;
	}
}

type PreviewPanelMode = 'preview' | 'voice';

interface PreviewPanelState {
	mode?: PreviewPanelMode;
	url?: string;
	command?: string;
	workspaceLabel?: string;
}

interface VoiceCaptureHandlers {
	transcribe(dataUrl: string, mimeType: string): Promise<string>;
	openExternalCapture(): Promise<void>;
	onTranscript(text: string): void;
	onStatus(text: string): void;
}

function buildHtml(webview: vscode.Webview, state: PreviewPanelState): string {
	const nonce = String(Date.now());
	const csp = [
		"default-src 'none'",
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
		'img-src https: data:',
		'media-src blob: data:',
		'frame-src http://localhost:* http://127.0.0.1:* http://0.0.0.0:* https://localhost:* https://127.0.0.1:* https://0.0.0.0:*',
	].join('; ');

	if (state.mode === 'voice') {
		return buildVoiceHtml(nonce, csp);
	}

	const safeUrl = normalizePreviewUrl(state.url);
	const frameUrl = safeUrl ? withCacheBust(safeUrl) : undefined;
	const title = safeUrl ? safeUrl : 'Waiting for local preview';
	const subtitle = safeUrl
		? `Showing the detected local preview for ${state.workspaceLabel ?? 'the current workspace'}.`
		: [
			'Start Dev launched a server command.',
			state.command ? `Command: ${state.command}` : '',
			'This panel will update when a localhost preview URL is detected.',
		].filter(Boolean).join(' ');

	const iframe = safeUrl
		? `<div class="frame-shell">
			<div id="loading" class="loading">
				<div class="badge">Loading Preview</div>
				<h2>Opening local preview</h2>
				<p>If this stays blank, use the button below to open the preview externally.</p>
				<button id="openExternal" class="action-button" type="button">Open In Browser</button>
			</div>
			<iframe id="previewFrame" src="${escapeHtml(frameUrl ?? safeUrl)}" title="Local preview"></iframe>
		</div>`
		: `<div class="empty">
			<div class="badge">Preview Pending</div>
			<h2>Waiting for a local web server</h2>
			<p>${escapeHtml(subtitle)}</p>
		</div>`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Grok Preview</title>
	<style>
		:root {
			color-scheme: light dark;
			--bg: var(--vscode-editor-background);
			--fg: var(--vscode-editor-foreground);
			--muted: var(--vscode-descriptionForeground);
			--border: var(--vscode-panel-border);
			--accent: var(--vscode-button-background);
			--accent-fg: var(--vscode-button-foreground);
		}

		body {
			margin: 0;
			background: radial-gradient(circle at top, rgba(38, 120, 219, 0.1), transparent 30%), var(--bg);
			color: var(--fg);
			font: 13px/1.5 var(--vscode-font-family);
			height: 100vh;
			display: grid;
			grid-template-rows: auto 1fr;
		}

		.header {
			padding: 12px 14px;
			border-bottom: 1px solid var(--border);
			display: grid;
			gap: 4px;
		}

		.header strong {
			font-size: 12px;
			text-transform: uppercase;
			letter-spacing: 0.04em;
			color: var(--muted);
		}

		.header span {
			font-size: 13px;
		}

		.stage {
			padding: 14px;
			height: calc(100vh - 58px);
			box-sizing: border-box;
		}

		.frame-shell {
			position: relative;
			height: 100%;
		}

		.empty {
			height: 100%;
			border: 1px dashed var(--border);
			border-radius: 18px;
			display: grid;
			place-content: center;
			gap: 10px;
			text-align: center;
			padding: 24px;
		}

		.empty h2 {
			margin: 0;
			font-size: 20px;
			font-weight: 600;
		}

		.empty p {
			margin: 0;
			color: var(--muted);
			max-width: 560px;
		}

		.badge {
			justify-self: center;
			padding: 6px 10px;
			border-radius: 999px;
			background: var(--accent);
			color: var(--accent-fg);
			font-size: 12px;
		}

		iframe {
			width: 100%;
			height: 100%;
			border: 1px solid var(--border);
			border-radius: 18px;
			background: white;
		}

		.loading {
			position: absolute;
			inset: 0;
			border: 1px solid var(--border);
			border-radius: 18px;
			background: color-mix(in srgb, var(--bg) 94%, white 6%);
			display: grid;
			place-content: center;
			gap: 10px;
			text-align: center;
			padding: 24px;
			z-index: 1;
		}

		.loading.is-hidden {
			display: none;
		}

		.action-button {
			justify-self: center;
			height: 36px;
			border-radius: 999px;
			border: 1px solid var(--border);
			background: var(--accent);
			color: var(--accent-fg);
			padding: 0 14px;
			font: inherit;
			cursor: pointer;
		}
	</style>
</head>
<body>
	<div class="header">
		<strong>Grok Preview</strong>
		<span>${escapeHtml(title)}</span>
	</div>
	<div class="stage">
		${iframe}
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const frame = document.getElementById('previewFrame');
		const loading = document.getElementById('loading');
		const openExternal = document.getElementById('openExternal');
		let loaded = false;

		if (frame && loading) {
			frame.addEventListener('load', () => {
				loaded = true;
				loading.classList.add('is-hidden');
			});

			setTimeout(() => {
				if (!loaded) {
					loading.classList.remove('is-hidden');
				}
			}, 2500);
		}

		if (openExternal) {
			openExternal.addEventListener('click', () => {
				vscode.postMessage({ type: 'openExternalPreview' });
			});
		}
	</script>
</body>
</html>`;
}

function buildVoiceHtml(nonce: string, csp: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Build by Grok Voice Capture</title>
	<style>
		:root {
			color-scheme: dark;
			--bg: var(--vscode-editor-background);
			--fg: var(--vscode-editor-foreground);
			--muted: var(--vscode-descriptionForeground);
			--border: var(--vscode-panel-border);
			--accent: #39a9dc;
			--accent-2: #ffb000;
			--surface: color-mix(in srgb, var(--bg) 84%, white 16%);
		}

		* { box-sizing: border-box; }

		body {
			margin: 0;
			height: 100vh;
			display: grid;
			grid-template-rows: auto 1fr;
			background:
				radial-gradient(circle at 50% 18%, rgba(57, 169, 220, 0.25), transparent 28%),
				radial-gradient(circle at 70% 78%, rgba(255, 176, 0, 0.13), transparent 24%),
				var(--bg);
			color: var(--fg);
			font: 14px/1.5 var(--vscode-font-family);
		}

		.header {
			padding: 14px 16px;
			border-bottom: 1px solid var(--border);
			display: grid;
			gap: 3px;
		}

		.header strong {
			font-size: 12px;
			text-transform: uppercase;
			letter-spacing: 0.09em;
			color: var(--muted);
		}

		.stage {
			display: grid;
			place-items: center;
			padding: 28px;
			min-height: 0;
		}

		.card {
			width: min(720px, 100%);
			min-height: min(620px, calc(100vh - 120px));
			border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
			border-radius: 34px;
			background: linear-gradient(145deg, color-mix(in srgb, var(--surface) 92%, transparent), color-mix(in srgb, var(--bg) 70%, black 30%));
			box-shadow: 0 30px 90px rgba(0, 0, 0, 0.38);
			display: grid;
			place-items: center;
			text-align: center;
			padding: 44px 28px;
			position: relative;
			overflow: hidden;
		}

		.card::before {
			content: '';
			position: absolute;
			inset: -40%;
			background: conic-gradient(from 120deg, transparent, rgba(57, 169, 220, 0.16), transparent, rgba(255, 176, 0, 0.12), transparent);
			animation: rotate 12s linear infinite;
			opacity: 0.8;
		}

		.inner {
			position: relative;
			z-index: 1;
			display: grid;
			justify-items: center;
			gap: 18px;
			width: 100%;
		}

		.mic {
			width: min(270px, 56vw);
			aspect-ratio: 1;
			border: 0;
			border-radius: 50%;
			background:
				radial-gradient(circle at 35% 28%, rgba(255,255,255,0.95), rgba(255,255,255,0.2) 16%, transparent 22%),
				linear-gradient(145deg, var(--accent), #1d6282 56%, #132d3d);
			box-shadow:
				0 0 0 16px rgba(57, 169, 220, 0.11),
				0 0 0 34px rgba(57, 169, 220, 0.055),
				0 34px 70px rgba(0, 0, 0, 0.45);
			color: white;
			font-size: clamp(5rem, 16vw, 9rem);
			cursor: pointer;
			display: grid;
			place-items: center;
			transition: transform 180ms ease, box-shadow 180ms ease, filter 180ms ease;
		}

		.mic:hover {
			transform: translateY(-2px) scale(1.02);
			filter: brightness(1.08);
		}

		.mic.recording {
			background:
				radial-gradient(circle at 35% 28%, rgba(255,255,255,0.95), rgba(255,255,255,0.2) 16%, transparent 22%),
				linear-gradient(145deg, #ff4d4d, #962b42 56%, #25131b);
			animation: pulse 1.15s ease-in-out infinite;
		}

		.mic.busy {
			cursor: wait;
			filter: grayscale(0.2) brightness(0.85);
		}

		h1 {
			margin: 18px 0 0;
			font-size: clamp(1.9rem, 4vw, 3.4rem);
			line-height: 1.05;
			letter-spacing: -0.04em;
		}

		p {
			margin: 0;
			max-width: 560px;
			color: var(--muted);
			font-size: 1rem;
		}

		.status {
			min-height: 24px;
			color: var(--fg);
			font-weight: 600;
		}

		.timer {
			font-size: 2rem;
			font-variant-numeric: tabular-nums;
			color: var(--accent-2);
			min-height: 44px;
		}

		.hint {
			padding: 10px 14px;
			border-radius: 999px;
			background: rgba(255, 255, 255, 0.06);
			border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
		}

		@keyframes pulse {
			0%, 100% { box-shadow: 0 0 0 16px rgba(255, 77, 77, 0.13), 0 0 0 34px rgba(255, 77, 77, 0.06), 0 34px 70px rgba(0,0,0,0.45); }
			50% { box-shadow: 0 0 0 22px rgba(255, 77, 77, 0.18), 0 0 0 52px rgba(255, 77, 77, 0.07), 0 34px 70px rgba(0,0,0,0.45); }
		}

		@keyframes rotate {
			to { transform: rotate(360deg); }
		}
	</style>
</head>
<body>
	<div class="header">
		<strong>Build by Grok Voice Capture</strong>
		<span>Click the microphone to record. Click again to stop and transcribe into the chat prompt.</span>
	</div>
	<main class="stage">
		<section class="card">
			<div class="inner">
				<button class="mic" id="mic" type="button" aria-label="Start recording">🎙</button>
				<h1>Voice Mode</h1>
				<p class="hint">Your xAI key stays in the extension host. Audio is temporary and is only sent for transcription after you stop recording.</p>
				<div class="timer" id="timer">00:00</div>
				<div class="status" id="status">Ready to record.</div>
			</div>
		</section>
	</main>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const mic = document.getElementById('mic');
		const status = document.getElementById('status');
		const timer = document.getElementById('timer');
		let stream = null;
		let recorder = null;
		let chunks = [];
		let startedAt = 0;
		let ticker = 0;
		let transcribing = false;
		let microphonePrimed = false;

		function setStatus(text) {
			status.textContent = text || 'Ready.';
			vscode.postMessage({ type: 'voiceStatus', text: status.textContent });
		}

		function preferredAudioMimeType() {
			const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];
			return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
		}

		function setRecording(recording) {
			mic.classList.toggle('recording', recording);
			mic.textContent = recording ? '■' : '🎙';
			mic.setAttribute('aria-label', recording ? 'Stop recording' : 'Start recording');
		}

		function setBusy(busy) {
			transcribing = busy;
			mic.disabled = busy;
			mic.classList.toggle('busy', busy);
			if (busy) {
				mic.textContent = '…';
			} else if (!recorder) {
				mic.textContent = '🎙';
			}
		}

		function updateTimer() {
			const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
			const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
			const seconds = String(elapsed % 60).padStart(2, '0');
			timer.textContent = minutes + ':' + seconds;
		}

		function stopStream() {
			if (ticker) {
				clearInterval(ticker);
				ticker = 0;
			}
			stream?.getTracks().forEach((track) => track.stop());
			stream = null;
		}

		function blobToDataUrl(blob) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result || ''));
				reader.onerror = () => reject(reader.error || new Error('Unable to read recorded audio.'));
				reader.readAsDataURL(blob);
			});
		}

		async function primeMicrophone() {
			if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
				setStatus('Microphone recording is not available in this VS Code window.');
				return false;
			}
			try {
				setBusy(true);
				setStatus('Requesting microphone permission...');
				const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
				permissionStream.getTracks().forEach((track) => track.stop());
				microphonePrimed = true;
				timer.textContent = '00:00';
				setStatus('Microphone permission is ready. Click the mic again to start recording.');
				return true;
			} catch {
				microphonePrimed = false;
				setStatus('Microphone permission was denied or unavailable.');
				vscode.postMessage({ type: 'openExternalVoiceCapture' });
				return false;
			} finally {
				setBusy(false);
			}
		}

		async function start() {
			if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
				setStatus('Microphone recording is not available in this VS Code window.');
				return;
			}
			try {
				chunks = [];
				stream = await navigator.mediaDevices.getUserMedia({ audio: true });
				const mimeType = preferredAudioMimeType();
				recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
				recorder.ondataavailable = (event) => {
					if (event.data?.size > 0) {
						chunks.push(event.data);
					}
				};
				recorder.onerror = () => {
					setStatus('Voice recording failed.');
					setRecording(false);
					stopStream();
					recorder = null;
				};
				recorder.onstop = async () => {
					const recordedMimeType = recorder?.mimeType || mimeType || 'audio/webm';
					recorder = null;
					setRecording(false);
					stopStream();
					if (chunks.length === 0) {
						setStatus('No audio captured.');
						return;
					}
					setBusy(true);
					setStatus('Transcribing...');
					try {
						const dataUrl = await blobToDataUrl(new Blob(chunks, { type: recordedMimeType }));
						vscode.postMessage({ type: 'transcribeVoice', dataUrl, mimeType: recordedMimeType });
					} catch (error) {
						setBusy(false);
						setStatus('Could not prepare voice audio.');
					}
				};
				recorder.start();
				startedAt = Date.now();
				updateTimer();
				ticker = setInterval(updateTimer, 500);
				setRecording(true);
				setStatus('Recording... click the mic again to stop.');
			} catch {
				setRecording(false);
				stopStream();
				recorder = null;
				setStatus('Microphone permission was denied or unavailable.');
				vscode.postMessage({ type: 'openExternalVoiceCapture' });
			}
		}

		function stop() {
			if (!recorder || recorder.state === 'inactive') {
				return;
			}
			setStatus('Stopping recording...');
			recorder.stop();
		}

		mic.addEventListener('click', () => {
			if (transcribing) {
				return;
			}
			if (recorder && recorder.state !== 'inactive') {
				stop();
			} else if (!microphonePrimed) {
				void primeMicrophone();
			} else {
				void start();
			}
		});

		window.addEventListener('message', (event) => {
			const message = event.data || {};
			if (message.type === 'voiceTranscriptionComplete') {
				setBusy(false);
				setStatus('Transcribed into the chat prompt.');
				timer.textContent = '00:00';
			}
			if (message.type === 'voiceTranscriptionError') {
				setBusy(false);
				setStatus(message.text || 'Voice transcription failed.');
			}
		});
	</script>
</body>
</html>`;
}

export class PreviewPanel {
	private static current: PreviewPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private state: PreviewPanelState = {};
	private voiceHandlers: VoiceCaptureHandlers | undefined;

	public static createOrShow(initialState: PreviewPanelState): PreviewPanel {
		if (PreviewPanel.current) {
			PreviewPanel.current.state = initialState;
			PreviewPanel.current.voiceHandlers = undefined;
			PreviewPanel.current.panel.title = initialState.url ? 'Grok Preview' : 'Grok Preview: Waiting';
			PreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside, false);
			PreviewPanel.current.render();
			return PreviewPanel.current;
		}

		const panel = vscode.window.createWebviewPanel(
			'grokRepoPreview',
			initialState.url ? 'Grok Preview' : 'Grok Preview: Waiting',
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: false,
			},
		);

		PreviewPanel.current = new PreviewPanel(panel, initialState);
		return PreviewPanel.current;
	}

	public static createOrShowVoiceCapture(handlers: VoiceCaptureHandlers): PreviewPanel {
		const panel = PreviewPanel.createOrShow({ mode: 'voice' });
		panel.voiceHandlers = handlers;
		panel.state = { mode: 'voice' };
		panel.panel.title = 'Build by Grok Voice';
		panel.panel.reveal(vscode.ViewColumn.Beside, false);
		panel.render();
		return panel;
	}

	private constructor(panel: vscode.WebviewPanel, initialState: PreviewPanelState) {
		this.panel = panel;
		this.state = initialState;
		this.panel.webview.onDidReceiveMessage(async (message) => {
			if (message.type === 'openExternalPreview') {
				const safeUrl = normalizePreviewUrl(this.state.url);
				if (safeUrl) {
					await vscode.env.openExternal(vscode.Uri.parse(safeUrl));
				}
				return;
			}

			if (message.type === 'voiceStatus') {
				this.voiceHandlers?.onStatus(String(message.text ?? ''));
				return;
			}

			if (message.type === 'openExternalVoiceCapture') {
				await this.voiceHandlers?.openExternalCapture();
				return;
			}

			if (message.type === 'transcribeVoice') {
				try {
					const text = await this.voiceHandlers?.transcribe(String(message.dataUrl ?? ''), String(message.mimeType ?? 'audio/webm'));
					if (text) {
						this.voiceHandlers?.onTranscript(text);
					}
					await this.panel.webview.postMessage({ type: 'voiceTranscriptionComplete' });
				} catch (error) {
					await this.panel.webview.postMessage({ type: 'voiceTranscriptionError', text: error instanceof Error ? error.message : String(error) });
				}
			}
		});
		this.panel.onDidDispose(() => {
			PreviewPanel.current = undefined;
		});
		this.render();
	}

	public showWaiting(command?: string, workspaceLabel?: string): void {
		this.state = { command, workspaceLabel };
		this.voiceHandlers = undefined;
		this.panel.title = 'Grok Preview: Waiting';
		this.panel.reveal(vscode.ViewColumn.Beside, false);
		this.render();
	}

	public showPreview(url: string, workspaceLabel?: string): void {
		this.state = { url, workspaceLabel };
		this.voiceHandlers = undefined;
		this.panel.title = 'Grok Preview';
		this.panel.reveal(vscode.ViewColumn.Beside, false);
		this.render();
	}

	private render(): void {
		this.panel.webview.html = buildHtml(this.panel.webview, this.state);
	}
}
