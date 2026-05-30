import { ToolDefinition, XaiResponse } from '../core/types';

interface CreateResponseRequest {
	model: string;
	input: unknown[];
	tools?: ToolDefinition[];
	tool_choice?: 'auto' | 'required' | 'none';
	reasoning?: {
		effort: 'low' | 'medium' | 'high' | 'xhigh';
	};
	previous_response_id?: string;
}

export interface StreamResponseHandlers {
	onTextDelta?: (delta: string) => void;
	onReasoningDelta?: (delta: string) => void;
	onFunctionCall?: (call: { name: string; callId: string; arguments: string }) => void;
}

export interface GenerateImageRequest {
	model: string;
	prompt: string;
	aspectRatio?: string;
	resolution?: '1k' | '2k';
}

interface ImageGenerationResponse {
	data?: Array<{
		b64_json?: string;
		url?: string;
	}>;
	error?: {
		message?: string;
	};
}

interface SpeechToTextResponse {
	text?: string;
	error?: {
		message?: string;
	};
}

export class XaiClient {
	private activeController: AbortController | undefined;
	private tokenUsageTotal = 0;

	public constructor(
		private readonly apiKey: string,
		private readonly baseUrl: string,
	) {}

	public fork(): XaiClient {
		return new XaiClient(this.apiKey, this.baseUrl);
	}

	public abortActiveRequest(): void {
		this.activeController?.abort();
	}

	public getTokenUsageTotal(): number {
		return this.tokenUsageTotal;
	}

	public async createResponse(request: CreateResponseRequest): Promise<XaiResponse> {
		const controller = new AbortController();
		this.activeController = controller;
		const timeout = setTimeout(() => controller.abort(), 1000 * 60 * 20);

		try {
			const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/responses`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					...request,
					stream: false,
				}),
				signal: controller.signal,
			});

			const json = await this.parseJsonResponse<XaiResponse>(response);
			if (!response.ok) {
				throw new Error(json.error?.message ?? `xAI API request failed with status ${response.status}.`);
			}

			this.recordUsage(json.usage);
			return json;
		} finally {
			if (this.activeController === controller) {
				this.activeController = undefined;
			}
			clearTimeout(timeout);
		}
	}

	public async streamResponse(request: CreateResponseRequest, handlers: StreamResponseHandlers): Promise<XaiResponse> {
		const controller = new AbortController();
		this.activeController = controller;
		const timeout = setTimeout(() => controller.abort(), 1000 * 60 * 20);
		const functionCalls = new Map<string, { type: string; name?: string; call_id?: string; arguments?: string }>();
		let responseId = '';
		try {
			const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/responses`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					...request,
					stream: true,
				}),
				signal: controller.signal,
			});

			if (!response.ok || !response.body) {
				const text = await response.text();
				throw new Error(this.formatUnexpectedResponse(response, text));
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let finalResponse: XaiResponse | undefined;
			let responseUsageTokens = 0;

			const processEvent = (payload: string): void => {
				if (!payload || payload === '[DONE]') {
					return;
				}

				const event = JSON.parse(payload) as Record<string, unknown>;
				const type = String(event.type ?? '');
				responseUsageTokens = Math.max(responseUsageTokens, this.extractTotalTokens(event.usage));
				const eventResponse = event.response;
				if (eventResponse && typeof eventResponse === 'object') {
					responseUsageTokens = Math.max(responseUsageTokens, this.extractTotalTokens((eventResponse as XaiResponse).usage));
				}
				if (type === 'response.created') {
					const created = eventResponse;
					if (created && typeof created === 'object' && typeof (created as { id?: unknown }).id === 'string') {
						responseId = String((created as { id?: unknown }).id ?? '');
					}
					return;
				}

				if (type === 'response.output_text.delta' || type === 'response.text.delta') {
					handlers.onTextDelta?.(String(event.delta ?? ''));
					return;
				}

				if (type === 'response.reasoning_summary_text.delta') {
					handlers.onReasoningDelta?.(String(event.delta ?? ''));
					return;
				}

				if (type === 'response.output_item.added' || type === 'response.output_item.done') {
					const item = event.item;
					if (item && typeof item === 'object') {
						const typedItem = item as { type?: unknown; name?: unknown; call_id?: unknown; arguments?: unknown };
						if (String(typedItem.type ?? '') === 'function_call') {
							const callId = String(typedItem.call_id ?? '');
							if (callId) {
								const existing = functionCalls.get(callId) ?? { type: 'function_call' };
								functionCalls.set(callId, {
									type: 'function_call',
									name: String(typedItem.name ?? existing.name ?? ''),
									call_id: callId,
									arguments: String(typedItem.arguments ?? existing.arguments ?? '{}'),
								});
							}
						}
					}
					return;
				}

				if (type === 'response.function_call_arguments.done') {
					const existing = functionCalls.get(String(event.call_id ?? '')) ?? { type: 'function_call' };
					const call = {
						name: String(event.name ?? existing.name ?? ''),
						callId: String(event.call_id ?? ''),
						arguments: String(event.arguments ?? existing.arguments ?? '{}'),
					};
					if (this.isMeaningfulFunctionCall(call)) {
						handlers.onFunctionCall?.(call);
						functionCalls.set(call.callId, {
							type: 'function_call',
							name: call.name,
							call_id: call.callId,
							arguments: call.arguments,
						});
					}
					return;
				}

				if (type === 'response.done' || type === 'response.completed') {
					const responsePayload = eventResponse;
					if (responsePayload && typeof responsePayload === 'object') {
						finalResponse = responsePayload as XaiResponse;
						responseId = finalResponse.id || responseId;
					}
				}
			};

			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const chunks = buffer.split('\n\n');
				buffer = chunks.pop() ?? '';
				for (const chunk of chunks) {
					const dataLines = chunk
						.split('\n')
						.filter((line) => line.startsWith('data:'))
						.map((line) => line.slice(5).trimStart());
					if (dataLines.length > 0) {
						processEvent(dataLines.join('\n'));
					}
				}
			}

			if (buffer.trim()) {
				const dataLines = buffer
					.split('\n')
					.filter((line) => line.startsWith('data:'))
					.map((line) => line.slice(5).trimStart());
				if (dataLines.length > 0) {
					processEvent(dataLines.join('\n'));
				}
			}

			if (!finalResponse) {
				finalResponse = {
					id: responseId || `local-stream-${Date.now()}`,
					output: Array.from(functionCalls.values()),
				};
			}

			if ((!finalResponse.output || finalResponse.output.length === 0) && functionCalls.size > 0) {
				finalResponse.output = Array.from(functionCalls.values());
			}

			if (finalResponse.output) {
				finalResponse.output = finalResponse.output.filter((item) => {
					if (item.type !== 'function_call') {
						return true;
					}

					return this.isMeaningfulFunctionCall({
						name: String(item.name ?? ''),
						callId: String(item.call_id ?? ''),
						arguments: String(item.arguments ?? '{}'),
					});
				});
			}

			if (!finalResponse.id && responseId) {
				finalResponse.id = responseId;
			}

			const finalUsageTokens = Math.max(responseUsageTokens, this.extractTotalTokens(finalResponse.usage));
			this.recordTokenTotal(finalUsageTokens);
			return finalResponse;
		} finally {
			if (this.activeController === controller) {
				this.activeController = undefined;
			}
			clearTimeout(timeout);
		}
	}

	public async generateImage(request: GenerateImageRequest): Promise<Buffer> {
		const controller = new AbortController();
		this.activeController = controller;
		const timeout = setTimeout(() => controller.abort(), 1000 * 60 * 10);

		try {
			const body = XaiClient.buildImageGenerationBody(request);
			const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/images/generations`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});

			const json = await this.parseJsonResponse<ImageGenerationResponse>(response);
			if (!response.ok) {
				throw new Error([
					json.error?.message ?? `xAI image request failed with status ${response.status}.`,
					`HTTP status: ${response.status}`,
					`Response: ${JSON.stringify(json).slice(0, 1200)}`,
				].join('\n'));
			}

			const encoded = json.data?.[0]?.b64_json;
			if (encoded) {
				return Buffer.from(encoded.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, ''), 'base64');
			}

			const imageUrl = json.data?.[0]?.url;
			if (imageUrl) {
				return this.downloadImageUrl(imageUrl);
			}

			throw new Error('xAI image response did not include base64 image data or an image URL.');
		} finally {
			if (this.activeController === controller) {
				this.activeController = undefined;
			}
			clearTimeout(timeout);
		}
	}

	public static buildImageGenerationBody(request: GenerateImageRequest): Record<string, string> {
		return {
			model: request.model,
			prompt: request.prompt,
			response_format: 'b64_json',
			...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
			...(request.resolution ? { resolution: request.resolution } : {}),
		};
	}

	public async transcribeAudio(audio: Buffer, mimeType: string, filename: string): Promise<string> {
		const controller = new AbortController();
		this.activeController = controller;
		const timeout = setTimeout(() => controller.abort(), 1000 * 60 * 60);

		try {
			const formData = new FormData();
			formData.append('format', 'true');
			formData.append('language', 'en');
			formData.append('file', new Blob([audio], { type: mimeType || 'audio/webm' }), filename);

			const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/stt`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: formData,
				signal: controller.signal,
			});

			const json = await this.parseJsonResponse<SpeechToTextResponse>(response);
			if (!response.ok) {
				throw new Error(json.error?.message ?? `xAI speech-to-text request failed with status ${response.status}.`);
			}

			const text = json.text?.trim();
			if (!text) {
				throw new Error('xAI speech-to-text returned an empty transcript.');
			}

			return text;
		} finally {
			if (this.activeController === controller) {
				this.activeController = undefined;
			}
			clearTimeout(timeout);
		}
	}

	private async downloadImageUrl(url: string): Promise<Buffer> {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`xAI image URL download failed with status ${response.status}.`);
		}

		const contentType = response.headers.get('content-type') ?? '';
		const bytes = Buffer.from(await response.arrayBuffer());
		const head = bytes.subarray(0, Math.min(bytes.length, 128)).toString('utf8').trimStart().toLowerCase();
		if (!contentType.startsWith('image/') || head.startsWith('<!doctype html') || head.startsWith('<html')) {
			throw new Error(`xAI image URL did not return a renderable image. Content-Type: ${contentType || 'unknown'}.`);
		}

		return bytes;
	}

	private async parseJsonResponse<T>(response: Response): Promise<T> {
		const text = await response.text();
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new Error(this.formatUnexpectedResponse(response, text));
		}
	}

	private recordUsage(usage: unknown): void {
		this.recordTokenTotal(this.extractTotalTokens(usage));
	}

	private recordTokenTotal(total: number): void {
		if (Number.isFinite(total) && total > 0) {
			this.tokenUsageTotal += total;
		}
	}

	private extractTotalTokens(usage: unknown): number {
		if (!usage || typeof usage !== 'object') {
			return 0;
		}

		const record = usage as Record<string, unknown>;
		const direct = this.numberValue(record.total_tokens)
			|| this.numberValue(record.totalTokens);
		if (direct > 0) {
			return direct;
		}

		const input = this.numberValue(record.input_tokens)
			|| this.numberValue(record.prompt_tokens)
			|| this.numberValue(record.inputTokens)
			|| this.numberValue(record.promptTokens);
		const output = this.numberValue(record.output_tokens)
			|| this.numberValue(record.completion_tokens)
			|| this.numberValue(record.outputTokens)
			|| this.numberValue(record.completionTokens);
		return input + output;
	}

	private numberValue(value: unknown): number {
		return typeof value === 'number' && Number.isFinite(value) ? value : 0;
	}

	private formatUnexpectedResponse(response: Response, text: string): string {
		const contentType = response.headers.get('content-type') ?? 'unknown';
		const cleaned = text.trim();
		const lower = cleaned.slice(0, 300).toLowerCase();
		const isHtml = lower.startsWith('<!doctype html') || lower.startsWith('<html') || /<body[\s>]/i.test(cleaned);
		if (isHtml) {
			const title = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
				?.replace(/\s+/g, ' ')
				.trim();
			const heading = cleaned.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
				?.replace(/\s+/g, ' ')
				.trim();
			const summary = [title, heading].filter(Boolean).join(' - ');
			return [
				`xAI API returned an HTML error page instead of JSON/status events. HTTP ${response.status}.`,
				`Content-Type: ${contentType}.`,
				summary ? `Page summary: ${summary}.` : '',
				'This is usually an upstream URL, proxy, auth, or challenge-page problem; raw HTML was suppressed.',
			].filter(Boolean).join(' ');
		}

		const compact = cleaned.replace(/\s+/g, ' ').slice(0, 800);
		return compact
			? `xAI API returned an unexpected response. HTTP ${response.status}. Content-Type: ${contentType}. Body: ${compact}`
			: `xAI API returned an unexpected empty response. HTTP ${response.status}. Content-Type: ${contentType}.`;
	}

	public extractText(response: XaiResponse): string {
		if (typeof response.output_text === 'string' && response.output_text.trim()) {
			return response.output_text;
		}

		const message = response.output?.find((item) => item.type === 'message');
		const text = message?.content
			?.filter((part) => part.type === 'output_text' && typeof part.text === 'string')
			.map((part) => part.text ?? '')
			.join('');

		return text?.trim() ?? '';
	}

	private isMeaningfulFunctionCall(call: { name: string; callId: string; arguments: string }): boolean {
		return Boolean(call.callId.trim() && call.name.trim());
	}
}
