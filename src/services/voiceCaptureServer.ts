import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';

interface VoiceCaptureServerOptions {
	transcribe(audio: Buffer, mimeType: string): Promise<string>;
	onTranscript(text: string): void;
	onStatus(text: string): void;
}

const MAX_VOICE_CAPTURE_BYTES = 100 * 1024 * 1024;

export class VoiceCaptureServer {
	private server: http.Server | undefined;
	private timeout: NodeJS.Timeout | undefined;

	public async open(options: VoiceCaptureServerOptions): Promise<void> {
		this.dispose();

		const token = crypto.randomBytes(24).toString('hex');
		this.server = http.createServer(async (request, response) => {
			try {
				const host = request.headers.host ?? '127.0.0.1';
				const url = new URL(request.url ?? '/', `http://${host}`);
				if (url.searchParams.get('token') !== token) {
					this.writeText(response, 403, 'Forbidden');
					return;
				}

				if (request.method === 'GET' && url.pathname === '/') {
					this.writeHtml(response, this.buildHtml(token));
					return;
				}

				if (request.method === 'POST' && url.pathname === '/transcribe') {
					const mimeType = String(request.headers['content-type'] ?? 'audio/webm').split(';')[0] || 'audio/webm';
					if (!mimeType.startsWith('audio/')) {
						this.writeJson(response, 415, { error: `Unsupported content type: ${mimeType}` });
						return;
					}

					const audio = await this.readRequestBody(request, MAX_VOICE_CAPTURE_BYTES);
					if (audio.length === 0) {
						this.writeJson(response, 400, { error: 'No audio captured.' });
						return;
					}

					options.onStatus('Transcribing browser voice capture...');
					const transcript = await options.transcribe(audio, mimeType);
					options.onTranscript(transcript);
					this.writeJson(response, 200, { transcript });
					return;
				}

				if (request.method === 'POST' && url.pathname === '/close') {
					options.onStatus('Voice capture session ended.');
					this.writeJson(response, 200, { closed: true });
					setTimeout(() => this.dispose(), 250);
					return;
				}

				this.writeText(response, 404, 'Not found');
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				options.onStatus(`Voice capture failed: ${message}`);
				this.writeJson(response, 500, { error: message });
			}
		});

		const port = await new Promise<number>((resolve, reject) => {
			this.server?.once('error', reject);
			this.server?.listen(0, '127.0.0.1', () => {
				const address = this.server?.address();
				if (address && typeof address === 'object') {
					resolve(address.port);
				} else {
					reject(new Error('Unable to start local voice capture server.'));
				}
			});
		});

		const url = vscode.Uri.parse(`http://127.0.0.1:${port}/?token=${token}`);
		options.onStatus('Opening browser voice capture. Session stays open until you end it.');
		await vscode.env.openExternal(url);
	}

	public dispose(): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = undefined;
		}
		const server = this.server;
		this.server = undefined;
		server?.close();
	}

	private readRequestBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let total = 0;
			request.on('data', (chunk: Buffer) => {
				total += chunk.length;
				if (total > maxBytes) {
					reject(new Error('Voice recording is too large. Stop and send shorter dictation segments.'));
					request.destroy();
					return;
				}
				chunks.push(chunk);
			});
			request.on('end', () => resolve(Buffer.concat(chunks)));
			request.on('error', reject);
		});
	}

	private writeHtml(response: http.ServerResponse, html: string): void {
		response.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
		});
		response.end(html);
	}

	private writeJson(response: http.ServerResponse, status: number, body: unknown): void {
		response.writeHead(status, {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			'Access-Control-Allow-Origin': 'null',
		});
		response.end(JSON.stringify(body));
	}

	private writeText(response: http.ServerResponse, status: number, text: string): void {
		response.writeHead(status, {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
		});
		response.end(text);
	}

	private buildHtml(token: string): string {
		const escapedToken = token.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Build by Grok Voice Capture</title>
	<style>
		:root {
			color-scheme: dark;
			--bg: #090d12;
			--fg: #f2f6fb;
			--muted: #a9b7c4;
			--accent: #38bdf8;
			--gold: #f8b31f;
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			min-height: 100vh;
			display: grid;
			place-items: center;
			background:
				radial-gradient(circle at 50% 14%, rgba(56, 189, 248, 0.28), transparent 28%),
				radial-gradient(circle at 78% 78%, rgba(248, 179, 31, 0.14), transparent 25%),
				linear-gradient(135deg, #05070a, var(--bg));
			color: var(--fg);
			font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			padding: 28px;
		}
		.card {
			width: min(720px, 100%);
			min-height: min(680px, calc(100vh - 56px));
			border: 1px solid rgba(255,255,255,0.12);
			border-radius: 34px;
			background: linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.025));
			box-shadow: 0 38px 110px rgba(0,0,0,0.48);
			display: grid;
			place-items: center;
			text-align: center;
			padding: 46px 28px;
			overflow: hidden;
			position: relative;
		}
		.card::before {
			content: '';
			position: absolute;
			inset: -45%;
			background: conic-gradient(from 120deg, transparent, rgba(56,189,248,0.18), transparent, rgba(248,179,31,0.16), transparent);
			animation: rotate 12s linear infinite;
		}
		.inner {
			position: relative;
			z-index: 1;
			display: grid;
			justify-items: center;
			gap: 18px;
		}
		button {
			font: inherit;
		}
		.mic {
			width: min(310px, 66vw);
			aspect-ratio: 1;
			border: 0;
			border-radius: 50%;
			background:
				radial-gradient(circle at 34% 27%, rgba(255,255,255,0.96), rgba(255,255,255,0.24) 16%, transparent 22%),
				linear-gradient(145deg, var(--accent), #1d6689 56%, #132e3e);
			box-shadow: 0 0 0 18px rgba(56,189,248,0.13), 0 0 0 42px rgba(56,189,248,0.06), 0 36px 74px rgba(0,0,0,0.48);
			color: #fff;
			font-size: clamp(6rem, 18vw, 10rem);
			cursor: pointer;
			display: grid;
			place-items: center;
			transition: transform 180ms ease, filter 180ms ease;
		}
		.mic:hover {
			transform: translateY(-2px) scale(1.02);
			filter: brightness(1.08);
		}
		.mic.recording {
			background:
				radial-gradient(circle at 34% 27%, rgba(255,255,255,0.96), rgba(255,255,255,0.24) 16%, transparent 22%),
				linear-gradient(145deg, #ff4d4d, #98263f 58%, #25131b);
			animation: pulse 1.15s ease-in-out infinite;
		}
		.mic.busy {
			cursor: wait;
			filter: grayscale(0.25) brightness(0.82);
		}
		h1 {
			margin: 14px 0 0;
			font-size: clamp(2rem, 5vw, 4.2rem);
			letter-spacing: -0.055em;
			line-height: 1;
		}
		p {
			margin: 0;
			color: var(--muted);
			max-width: 560px;
			font-size: 1rem;
			line-height: 1.55;
		}
		.timer {
			font-size: 2.2rem;
			font-variant-numeric: tabular-nums;
			color: var(--gold);
			min-height: 48px;
		}
		.status {
			min-height: 26px;
			font-weight: 700;
		}
		.result {
			max-width: 620px;
			color: var(--fg);
			background: rgba(255,255,255,0.07);
			border: 1px solid rgba(255,255,255,0.1);
			border-radius: 18px;
			padding: 14px 16px;
			display: none;
		}
		.result.visible {
			display: block;
		}
		.mode {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 8px 13px;
			border-radius: 999px;
			background: rgba(255,255,255,0.07);
			border: 1px solid rgba(255,255,255,0.1);
			color: var(--muted);
			font-weight: 700;
		}
		.mode::before {
			content: '';
			width: 9px;
			height: 9px;
			border-radius: 50%;
			background: #7c8794;
		}
		.mode.live {
			color: #c6f6d5;
		}
		.mode.live::before {
			background: #28d17c;
			box-shadow: 0 0 18px rgba(40, 209, 124, 0.85);
		}
		.controls {
			display: flex;
			justify-content: center;
			gap: 10px;
			flex-wrap: wrap;
		}
		.end {
			border: 1px solid rgba(255,255,255,0.14);
			border-radius: 999px;
			background: rgba(255,255,255,0.07);
			color: var(--fg);
			padding: 10px 15px;
			cursor: pointer;
		}
		.end:hover {
			background: rgba(255,255,255,0.12);
		}
		@keyframes pulse {
			0%, 100% { box-shadow: 0 0 0 18px rgba(255,77,77,0.14), 0 0 0 42px rgba(255,77,77,0.06), 0 36px 74px rgba(0,0,0,0.48); }
			50% { box-shadow: 0 0 0 26px rgba(255,77,77,0.2), 0 0 0 60px rgba(255,77,77,0.08), 0 36px 74px rgba(0,0,0,0.48); }
		}
		@keyframes rotate { to { transform: rotate(360deg); } }
	</style>
</head>
<body>
	<main class="card">
		<section class="inner">
			<button class="mic" id="mic" type="button" aria-label="Start recording">🎙</button>
			<h1>Build by Grok Voice</h1>
			<p>This browser window handles mic permission more reliably than VS Code webviews. It stays open until you end the session. Click once to record, click again to stop and send the transcript back to the chat prompt.</p>
			<div class="mode" id="mode">Mic off</div>
			<div class="timer" id="timer">00:00</div>
			<div class="status" id="status">Ready to record.</div>
			<div class="result" id="result"></div>
			<div class="controls">
				<button class="end" id="endSession" type="button">End Voice Session</button>
			</div>
		</section>
	</main>
	<script>
		const token = '${escapedToken}';
		const mic = document.getElementById('mic');
		const status = document.getElementById('status');
		const timer = document.getElementById('timer');
		const result = document.getElementById('result');
		const mode = document.getElementById('mode');
		const endSession = document.getElementById('endSession');
		let stream = null;
		let recorder = null;
		let chunks = [];
		let startedAt = 0;
		let ticker = 0;
		let busy = false;
		let endingSession = false;
		let microphonePrimed = false;

		function setStatus(text) {
			status.textContent = text || 'Ready.';
		}

		function preferredAudioMimeType() {
			const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];
			return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
		}

		function setRecording(recording) {
			mic.classList.toggle('recording', recording);
			mic.textContent = recording ? '■' : '🎙';
			mic.setAttribute('aria-label', recording ? 'Stop recording' : 'Start recording');
			mode.classList.toggle('live', recording);
			mode.textContent = recording ? 'Mic live' : 'Mic off';
		}

		function setBusy(nextBusy) {
			busy = nextBusy;
			mic.disabled = nextBusy;
			mic.classList.toggle('busy', nextBusy);
			if (nextBusy) {
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

		async function primeMicrophone() {
			if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
				setStatus('This browser does not support microphone recording.');
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
				return false;
			} finally {
				setBusy(false);
			}
		}

		async function start() {
			if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
				setStatus('This browser does not support microphone recording.');
				return;
			}
			try {
				result.classList.remove('visible');
				result.textContent = '';
				chunks = [];
				stream = await navigator.mediaDevices.getUserMedia({ audio: true });
				const mimeType = preferredAudioMimeType();
				recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
				recorder.ondataavailable = (event) => {
					if (event.data?.size > 0) {
						chunks.push(event.data);
					}
				};
				recorder.onstop = async () => {
					const recordedMimeType = recorder?.mimeType || mimeType || 'audio/webm';
					recorder = null;
					setRecording(false);
					stopStream();
					if (endingSession) {
						return;
					}
					if (chunks.length === 0) {
						setStatus('No audio captured.');
						return;
					}
					setBusy(true);
					setStatus('Transcribing...');
					try {
						const response = await fetch('/transcribe?token=' + encodeURIComponent(token), {
							method: 'POST',
							headers: { 'Content-Type': recordedMimeType },
							body: new Blob(chunks, { type: recordedMimeType })
						});
						const body = await response.json();
						if (!response.ok) {
							throw new Error(body.error || 'Voice transcription failed.');
						}
						result.textContent = body.transcript || '';
						result.classList.add('visible');
						setStatus('Transcript sent to Build by Grok. You can close this window.');
						timer.textContent = '00:00';
					} catch (error) {
						setStatus(error instanceof Error ? error.message : String(error));
					} finally {
						setBusy(false);
					}
				};
				recorder.onerror = () => {
					setStatus('Voice recording failed.');
					setRecording(false);
					stopStream();
					recorder = null;
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
			}
		}

		function stop() {
			if (!recorder || recorder.state === 'inactive') {
				return;
			}
			setStatus('Stopping recording... mic is turning off.');
			recorder.stop();
		}

		async function closeSession() {
			try {
				endingSession = true;
				if (recorder && recorder.state !== 'inactive') {
					recorder.stop();
				}
				setRecording(false);
				stopStream();
				setBusy(true);
				setStatus('Ending voice session...');
				await fetch('/close?token=' + encodeURIComponent(token), { method: 'POST' });
				setStatus('Voice session ended. Open Voice Mode again to start a new live session.');
				window.close();
			} catch {
				setStatus('Voice session ended locally. You can close this window.');
			} finally {
				setBusy(false);
			}
		}

		mic.addEventListener('click', () => {
			if (busy) {
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
		endSession.addEventListener('click', () => {
			void closeSession();
		});
	</script>
</body>
</html>`;
	}
}
