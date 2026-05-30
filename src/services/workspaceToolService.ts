import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as util from 'util';
import * as vscode from 'vscode';
import { ApprovalRequest, ApprovalResult, ExtensionConfig, ToolDefinition, ToolExecutionResult } from '../core/types';
import { GitService } from './gitService';
import { TerminalSessionService } from './terminalSessionService';
import { XaiClient } from './xaiClient';
import { matchesBlockedPattern } from '../util/commandPolicy';
import { ensureSubPath, normalizeRelativePath, truncateText } from '../util/pathUtils';
import { isSensitiveWorkspacePath } from '../util/sensitivePaths';
import { redactSecretsForRemote } from '../util/secretScan';
import { sanitizeTerminalChunk, summarizeTerminalOutput } from '../util/terminalText';
import { AgentMode } from '../core/types';

const execAsync = util.promisify(cp.exec);

const listDescendSkips = new Set([
	'.astro',
	'.git',
	'.next',
	'.turbo',
	'.vercel',
	'.wrangler',
	'coverage',
	'dist',
	'node_modules',
	'out',
]);

export class WorkspaceToolService {
	public constructor(
		private readonly folder: vscode.WorkspaceFolder,
		private readonly config: ExtensionConfig,
		private readonly requestApproval: (details: ApprovalRequest) => Promise<ApprovalResult>,
		private readonly terminalSessionService: TerminalSessionService,
		private readonly gitService: GitService,
		private readonly logEvent: (text: string) => void,
		private readonly xaiClient: XaiClient,
		private readonly agentMode: AgentMode = 'default',
	) {}

	public getToolDefinitions(): ToolDefinition[] {
		const tools: ToolDefinition[] = [
			{
				type: 'function',
				name: 'list_files',
				description: 'List files and directories under a path inside the selected workspace folder.',
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Relative path inside the workspace folder.', default: '' },
						maxDepth: { type: 'number', description: 'Recursion depth from the starting path.', default: 4 },
						limit: { type: 'number', description: 'Maximum number of entries to return.', default: 2000 },
					},
				},
			},
			{
				type: 'function',
				name: 'read_file',
				description: 'Read the complete text file from the workspace folder. This tool returns the full file by default; do not request line ranges unless the user explicitly asks for a specific line range.',
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Relative file path inside the workspace folder.' },
					},
					required: ['path'],
				},
			},
			{
				type: 'function',
				name: 'search_text',
				description: 'Search broadly across files in the workspace folder. Defaults to case-insensitive natural-language keyword search with ranked partial matches; can also do exact text or regex search.',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Plain text, natural-language description, keyword list, or regular expression to search for.' },
						glob: { type: 'string', description: 'Optional glob filter such as **/*.ts.' },
						limit: { type: 'number', description: 'Maximum number of matches.', default: 100 },
						matchMode: { type: 'string', enum: ['auto', 'exact', 'any', 'all', 'regex'], description: 'Search mode. auto extracts useful keywords from natural language and ranks likely matches.', default: 'auto' },
						caseSensitive: { type: 'boolean', description: 'Whether matching should be case-sensitive.', default: false },
					},
					required: ['query'],
				},
			},
			{
				type: 'function',
				name: 'inspect_media_file',
				description: 'Inspect an image or media file inside the workspace folder and report whether it appears to be a valid renderable asset.',
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Relative file path inside the workspace folder.' },
					},
					required: ['path'],
				},
			},
			{
				type: 'function',
				name: 'run_command',
				description: 'Run a shell command inside the selected workspace folder.',
				parameters: {
					type: 'object',
					properties: {
						command: { type: 'string', description: 'Shell command to run inside the workspace folder.' },
						timeoutMs: { type: 'number', description: 'Optional command timeout override in milliseconds.' },
					},
					required: ['command'],
				},
			},
		];

		if (this.agentMode !== 'security' && this.agentMode !== 'find') {
			tools.splice(3, 0,
				{
					type: 'function',
					name: 'image_build',
					description: 'Generate exactly one required raster image asset with Grok Imagine/xAI using the same image API as /image and /imagine, save it into .build-by-grok/images, verify the saved file exists and has a valid image signature, and return the created path.',
					parameters: {
						type: 'object',
						properties: {
							prompt: { 
								type: 'string', 
								description: 'Clean visual description ONLY. Extract the core request. Do NOT include meta text like "generate an image of", "create a picture showing", or tool instructions.' 
							},
							fileName: { 
								type: 'string', 
								description: 'Optional image file name without path. Use kebab-case and .jpg/.jpeg/.png/.webp if provided.' 
							},
						},
						required: ['prompt'],
					},
				},
				{
					type: 'function',
					name: 'write_file',
					description: 'Create or replace a file in the workspace folder.',
					parameters: {
						type: 'object',
						properties: {
							path: { type: 'string', description: 'Relative file path inside the workspace folder.' },
							content: { type: 'string', description: 'Complete UTF-8 file contents to write.' },
						},
						required: ['path', 'content'],
					},
				},
				{
					type: 'function',
					name: 'replace_in_file',
					description: 'Replace text in a file. The search text must match exactly.',
					parameters: {
						type: 'object',
						properties: {
							path: { type: 'string', description: 'Relative file path inside the workspace folder.' },
							search: { type: 'string', description: 'Exact text to search for.' },
							replace: { type: 'string', description: 'Replacement text.' },
							replaceAll: { type: 'boolean', description: 'Replace all occurrences instead of only the first one.', default: false },
						},
						required: ['path', 'search', 'replace'],
					},
				},
				{
					type: 'function',
					name: 'delete_file',
					description: 'Delete a file inside the workspace folder.',
					parameters: {
						type: 'object',
						properties: {
							path: { type: 'string', description: 'Relative file path inside the workspace folder.' },
						},
						required: ['path'],
					},
				},
			);
		}

		return tools;
	}

	public async execute(name: string, rawArgs: string): Promise<ToolExecutionResult> {
		try {
			if (this.agentMode === 'find' && !['list_files', 'read_file', 'search_text'].includes(name)) {
				return this.failure(`Tool ${name} is disabled in find mode.`);
			}
			if (this.agentMode === 'security' && ['write_file', 'replace_in_file', 'delete_file'].includes(name)) {
				return this.failure(`Tool ${name} is disabled in security audit mode.`);
			}
			if (name === 'image_build') {
				this.logEvent(`image_build raw function arguments:\n${rawArgs}`);
			}

			let args: Record<string, unknown>;
			try {
				args = rawArgs ? JSON.parse(rawArgs) as Record<string, unknown> : {};
			} catch (error) {
				throw error;
			}

			switch (name) {
				case 'list_files':
					return this.success(await this.listFiles(args));
				case 'read_file':
					return this.readSuccess(await this.readFile(args));
				case 'search_text':
					return this.success(await this.searchText(args));
				case 'inspect_media_file':
					return this.success(await this.inspectMediaFile(args));
				case 'image_build':
					return this.success(await this.imageBuild(args));
				case 'write_file':
					return this.success(await this.writeFile(args));
				case 'replace_in_file':
					return this.success(await this.replaceInFile(args));
				case 'delete_file':
					return this.success(await this.deleteFile(args));
				case 'run_command':
					return this.success(await this.runCommand(args));
				default:
					return this.failure(`Unknown tool: ${name}`);
			}
		} catch (error) {
			return this.failure(error instanceof Error ? error.message : String(error));
		}
	}

	private success(output: string): ToolExecutionResult {
		return {
			ok: true,
			output: truncateText(output, this.config.maxToolOutputChars),
		};
	}

	private readSuccess(output: string): ToolExecutionResult {
		return {
			ok: true,
			output,
		};
	}

	private failure(message: string): ToolExecutionResult {
		return {
			ok: false,
			output: message,
		};
	}

	private resolvePath(relativePath: string): string {
		const cleanRelativePath = normalizeRelativePath(relativePath);
		return ensureSubPath(this.folder.uri.fsPath, path.join(this.folder.uri.fsPath, cleanRelativePath));
	}

	private async listFiles(args: Record<string, unknown>): Promise<string> {
		const startPath = this.resolvePath(String(args.path ?? ''));
		const maxDepth = Math.max(0, Number(args.maxDepth ?? 4));
		const limit = Math.max(1, Number(args.limit ?? 2000));
		const results: string[] = [];

		const walk = async (currentPath: string, depth: number): Promise<void> => {
			if (results.length >= limit) {
				return;
			}

			const stat = await fs.stat(currentPath);
			const relative = path.relative(this.folder.uri.fsPath, currentPath) || '.';
			if (depth === 0) {
				results.push(`${stat.isDirectory() ? 'dir' : 'file'} ${relative}`);
			}

			if (!stat.isDirectory() || depth >= maxDepth) {
				return;
			}

			const entries = await fs.readdir(currentPath, { withFileTypes: true });
			for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
				if (results.length >= limit) {
					break;
				}

				const childPath = path.join(currentPath, entry.name);
				const childRelative = path.relative(this.folder.uri.fsPath, childPath);
				results.push(`${entry.isDirectory() ? 'dir' : 'file'} ${childRelative}`);
				if (entry.isDirectory() && !listDescendSkips.has(entry.name)) {
					await walk(childPath, depth + 1);
				}
			}
		};

		await walk(startPath, 0);
		return results.join('\n');
	}

	private async readFile(args: Record<string, unknown>): Promise<string> {
		const relativePath = String(args.path ?? '');
		const targetPath = this.resolvePath(relativePath);
		await this.ensureReadApproval(relativePath, 'Read file');
		const content = await fs.readFile(targetPath, 'utf8');
		const lines = content.split(/\r?\n/);
		const numbered = lines.map((line, index) => `${index + 1}: ${line}`).join('\n');
		return this.redactForRemote(numbered, `read_file ${relativePath}`);
	}

	private async searchText(args: Record<string, unknown>): Promise<string> {
		const query = String(args.query ?? '').trim();
		if (!query) {
			throw new Error('The search query is required.');
		}

		const limit = Math.max(1, Number(args.limit ?? 100));
		const caseSensitive = Boolean(args.caseSensitive ?? false);
		const requestedMode = String(args.matchMode ?? 'auto').toLowerCase();
		const matchMode = ['auto', 'exact', 'any', 'all', 'regex'].includes(requestedMode) ? requestedMode : 'auto';
		const glob = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : '**/*';
		const pattern = new vscode.RelativePattern(this.folder, glob);
		const matches: Array<{ score: number; text: string }> = [];
		const uris = await vscode.workspace.findFiles(pattern, '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.wrangler/**,**/.next/**}', 10000);
		const keywords = this.extractSearchKeywords(query);
		const normalizedQuery = this.normalizeSearchText(query, caseSensitive);
		const regex = matchMode === 'regex' ? this.buildSearchRegex(query, caseSensitive) : undefined;
		let sensitiveReadApproved = false;
		for (const uri of uris) {
			const relative = vscode.workspace.asRelativePath(uri, false);
			const relativeSearch = this.normalizeSearchText(relative, caseSensitive);
			const pathScore = this.scoreSearchText(relativeSearch, normalizedQuery, keywords, matchMode, regex);
			if (pathScore > 0) {
				matches.push({
					score: pathScore + 5,
					text: `${relative}: path/name match`,
				});
			}

			if (isSensitiveWorkspacePath(relative)) {
				if (!sensitiveReadApproved) {
					await this.ensureReadApproval(relative, 'Search sensitive files');
					sensitiveReadApproved = true;
				}
			}

			const stat = await fs.stat(uri.fsPath).catch(() => undefined);
			if (stat && stat.size > 3_000_000) {
				continue;
			}
			const content = await fs.readFile(uri.fsPath, 'utf8').catch(() => undefined);
			if (!content) {
				continue;
			}

			const fileScore = this.scoreSearchText(this.normalizeSearchText(content, caseSensitive), normalizedQuery, keywords, matchMode, regex);
			if (fileScore > 0) {
				matches.push({
					score: Math.max(1, fileScore - 5),
					text: `${relative}: file-level match (${this.matchedKeywordSummary(content, keywords, caseSensitive)})`,
				});
			}

			const lines = content.split(/\r?\n/);
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index];
				const lineSearch = this.normalizeSearchText(line, caseSensitive);
				const score = this.scoreSearchText(`${relativeSearch} ${lineSearch}`, normalizedQuery, keywords, matchMode, regex);
				if (score <= 0) {
					continue;
				}

				matches.push({ score, text: `${relative}:${index + 1}: ${line.trim()}` });
				if (matches.length >= limit * 5) {
					break;
				}
			}

			if (matches.length >= limit * 5) {
				break;
			}
		}

		const unique = new Map<string, { score: number; text: string }>();
		for (const match of matches) {
			const existing = unique.get(match.text);
			if (!existing || match.score > existing.score) {
				unique.set(match.text, match);
			}
		}
		const ranked = [...unique.values()]
			.sort((left, right) => right.score - left.score || left.text.localeCompare(right.text))
			.slice(0, limit);
		if (ranked.length === 0) {
			return [
				'No matches found.',
				`Search mode: ${matchMode}`,
				keywords.length > 0 ? `Extracted keywords: ${keywords.join(', ')}` : '',
			].filter(Boolean).join('\n');
		}

		const output = [
			`Search mode: ${matchMode}`,
			keywords.length > 0 ? `Extracted keywords: ${keywords.join(', ')}` : '',
			'Matches:',
			...ranked.map((match) => `${match.text}  [score ${match.score}]`),
		].filter(Boolean).join('\n');
		return this.redactForRemote(output, `search_text ${query}`);
	}

	private normalizeSearchText(value: string, caseSensitive: boolean): string {
		const expandedCamel = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
		const normalized = expandedCamel.replace(/[_./\\:-]+/g, ' ');
		return caseSensitive ? normalized : normalized.toLowerCase();
	}

	private extractSearchKeywords(query: string): string[] {
		const stopWords = new Set([
			'a', 'about', 'after', 'all', 'also', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'change',
			'contains', 'copy', 'could', 'file', 'find', 'for', 'from', 'has', 'have', 'here', 'i', 'if', 'in', 'is',
			'it', 'like', 'locate', 'manual', 'me', 'of', 'on', 'or', 'section', 'see', 'something', 'tell', 'that',
			'the', 'there', 'this', 'to', 'want', 'we', 'where', 'with', 'you', 'your',
		]);
		const normalized = this.normalizeSearchText(query, false)
			.replace(/[^a-z0-9\s]+/g, ' ')
			.split(/\s+/)
			.map((word) => word.trim())
			.filter((word) => word.length >= 3 && !stopWords.has(word));
		return [...new Set(normalized)].slice(0, 24);
	}

	private buildSearchRegex(query: string, caseSensitive: boolean): RegExp | undefined {
		try {
			return new RegExp(query, caseSensitive ? 'u' : 'iu');
		} catch {
			return undefined;
		}
	}

	private scoreSearchText(value: string, query: string, keywords: string[], matchMode: string, regex?: RegExp): number {
		if (!value) {return 0;}
		if (matchMode === 'regex') {return regex?.test(value) ? 120 : 0;}
		if (matchMode === 'exact') {return value.includes(query) ? 100 : 0;}
		if (keywords.length === 0) {return value.includes(query) ? 100 : 0;}

		const hits = keywords.filter((keyword) => value.includes(keyword));
		if (matchMode === 'all') {return hits.length === keywords.length ? 80 + hits.length * 4 : 0;}
		if (matchMode === 'any') {return hits.length > 0 ? hits.length * 10 : 0;}

		const exactPhraseScore = query.length >= 4 && value.includes(query) ? 100 : 0;
		if (exactPhraseScore > 0) {return exactPhraseScore + hits.length * 5;}
		if (hits.length >= 2) {return hits.length * 12;}
		if (hits.length === 1 && keywords.length <= 2) {return 8;}
		return 0;
	}

	private matchedKeywordSummary(content: string, keywords: string[], caseSensitive: boolean): string {
		const normalized = this.normalizeSearchText(content, caseSensitive);
		const hits = keywords.filter((keyword) => normalized.includes(keyword)).slice(0, 8);
		return hits.length > 0 ? `keywords: ${hits.join(', ')}` : 'matched query';
	}

	private async inspectMediaFile(args: Record<string, unknown>): Promise<string> {
		const relativePath = String(args.path ?? '');
		const targetPath = this.resolvePath(relativePath);
		await this.ensureReadApproval(relativePath, 'Inspect media file');
		const buffer = await fs.readFile(targetPath);
		const extension = path.extname(targetPath).toLowerCase();
		const headerText = buffer.subarray(0, Math.min(buffer.length, 256)).toString('utf8').trimStart().toLowerCase();
		const isHtml = headerText.startsWith('<!doctype html') || headerText.startsWith('<html') || (headerText.startsWith('<?xml') && headerText.includes('<html'));
		const isSvg = headerText.startsWith('<svg') || (headerText.startsWith('<?xml') && headerText.includes('<svg'));
		const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
		const isPng = buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
		const isGif = buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a');
		const isWebp = buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
		const detectedType = isHtml ? 'text/html'
			: isSvg ? 'image/svg+xml'
			: isJpeg ? 'image/jpeg'
			: isPng ? 'image/png'
			: isGif ? 'image/gif'
			: isWebp ? 'image/webp'
			: 'unknown';
		const valid = ((extension === '.jpg' || extension === '.jpeg') && isJpeg)
			|| (extension === '.png' && isPng)
			|| (extension === '.gif' && isGif)
			|| (extension === '.webp' && isWebp)
			|| (extension === '.svg' && isSvg);

		return [
			`path: ${relativePath}`,
			`size: ${buffer.length} bytes`,
			`extension: ${extension || 'none'}`,
			`detectedType: ${detectedType}`,
			`renderable: ${valid && !isHtml ? 'yes' : 'no'}`,
			!valid ? 'issue: file signature does not match the extension or file is not a valid image asset.' : '',
			isHtml ? 'issue: file content looks like HTML, not an image.' : '',
		].filter(Boolean).join('\n');
	}

	private async imageBuild(args: Record<string, unknown>): Promise<string> {
		const prompt = typeof args.prompt === 'string' ? args.prompt : '';
		if (!prompt.trim()) {
			throw new Error('image_build: The prompt is required.');
		}

		const outputPath = this.resolveImageBuildPath(args, prompt);

		this.logEvent([
			'image_build final payload:',
			JSON.stringify({
				model: this.config.imageModel,
				prompt,
				promptSource: 'tool_prompt_argument',
				promptLength: prompt.length,
				fileName: path.basename(outputPath),
			}, null, 2),
		].join('\n'));

		const imageBuffer = await this.xaiClient.generateImage({
			model: this.config.imageModel,
			prompt,
			aspectRatio: '16:9',
			resolution: '1k',
		}).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`image_build xAI call failed: ${message}`);
		});

		const detectedExtension = this.imageBuildExtensionForBuffer(imageBuffer);
		if (!detectedExtension) {
			throw new Error('image_build returned data that is not a recognized PNG, JPEG, or WebP image.');
		}

		const finalPath = path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}${detectedExtension}`);
		const finalRelativePath = path.relative(this.folder.uri.fsPath, finalPath);

		const approval = await this.ensureWriteApproval({
			kind: 'write',
			title: 'Build image asset',
			detail: `${finalRelativePath}\n\nPrompt: ${prompt.slice(0, 150)}${prompt.length > 150 ? '...' : ''}`,
			filePath: finalRelativePath,
			originalContent: '',
			updatedContent: `[binary image generated from prompt]\n${prompt}`,
		});

		await fs.mkdir(path.dirname(finalPath), { recursive: true });
		await fs.writeFile(finalPath, imageBuffer);

		const savedBuffer = await fs.readFile(finalPath);
		const savedExtension = this.imageBuildExtensionForBuffer(savedBuffer);
		if (!savedExtension) {
			await fs.rm(finalPath, { force: true });
			throw new Error('image_build saved file failed image signature verification. No image file was kept.');
		}

		await this.maybeStagePath(finalRelativePath, approval.stageFile);
		this.logEvent(`image_build created ${finalRelativePath}`);

		return [
			`Image built: ${finalRelativePath}`,
			`Verified: ${savedExtension === '.jpg' ? 'image/jpeg' : savedExtension === '.png' ? 'image/png' : 'image/webp'}`,
			`Image inbox: .build-by-grok/images`,
			`Size: ${savedBuffer.length} bytes`,
			`Model: ${this.config.imageModel}`,
			'Prompt source: tool prompt argument',
			'Continue now: copy or move this image into the framework public/static asset folder if needed, then reference it from the requested page/app.',
		].join('\n');
	}

	private resolveImageBuildPath(args: Record<string, unknown>, promptForNaming: string): string {
		const requestedName = typeof args.fileName === 'string' ? args.fileName.trim() : '';
		const fileName = this.safeImageBuildFileName(
			requestedName || `${promptForNaming.slice(0, 48)}-${Date.now()}.jpg`
		);
		return this.resolvePath(path.posix.join('.build-by-grok', 'images', fileName));
	}

	private safeImageBuildFileName(value: string): string {
		const extension = path.extname(value).toLowerCase();
		const allowedExtension = ['.jpg', '.jpeg', '.png', '.webp'].includes(extension) ? extension : '.jpg';
		const baseName = path.basename(value, extension)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 64) || 'generated-image';
		return `${baseName}${allowedExtension}`;
	}

	private imageBuildExtensionForBuffer(buffer: Buffer): '.png' | '.jpg' | '.webp' | undefined {
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

	private async writeFile(args: Record<string, unknown>): Promise<string> {
		const targetPath = this.resolvePath(String(args.path ?? ''));
		const content = String(args.content ?? '');
		let originalContent = '';
		try {
			originalContent = await fs.readFile(targetPath, 'utf8');
		} catch {
			originalContent = '';
		}
		const approval = await this.ensureWriteApproval({
			kind: 'write',
			title: 'Write file',
			detail: `${path.relative(this.folder.uri.fsPath, targetPath)}\n\nThis will create or replace the file.`,
			filePath: path.relative(this.folder.uri.fsPath, targetPath),
			originalContent,
			updatedContent: content,
		});
		const finalContent = approval.updatedContent ?? content;
		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await fs.writeFile(targetPath, finalContent, 'utf8');
		await this.maybeStagePath(path.relative(this.folder.uri.fsPath, targetPath), approval.stageFile);
		const relativePath = path.relative(this.folder.uri.fsPath, targetPath);
		const verification = await this.verifyWrittenFile(relativePath, targetPath, finalContent, originalContent);
		return [`Wrote ${relativePath} (${finalContent.length} chars).`, verification].filter(Boolean).join('\n');
	}

	private async replaceInFile(args: Record<string, unknown>): Promise<string> {
		const targetPath = this.resolvePath(String(args.path ?? ''));
		const search = String(args.search ?? '');
		const replace = String(args.replace ?? '');
		const replaceAll = Boolean(args.replaceAll ?? false);
		if (!search) {throw new Error('The search text is required.');}

		const content = await fs.readFile(targetPath, 'utf8');
		if (!content.includes(search)) {throw new Error('Search text was not found in the file.');}

		const updated = replaceAll ? content.split(search).join(replace) : content.replace(search, replace);
		const approval = await this.ensureWriteApproval({
			kind: 'write',
			title: 'Replace in file',
			detail: `${path.relative(this.folder.uri.fsPath, targetPath)}\n\nThis will modify existing file contents.`,
			filePath: path.relative(this.folder.uri.fsPath, targetPath),
			originalContent: content,
			updatedContent: updated,
		});
		const finalContent = approval.updatedContent ?? updated;
		await fs.writeFile(targetPath, finalContent, 'utf8');
		const relativePath = path.relative(this.folder.uri.fsPath, targetPath);
		await this.maybeStagePath(relativePath, approval.stageFile);
		const verification = await this.verifyWrittenFile(relativePath, targetPath, finalContent, content);
		return [`Updated ${relativePath}.`, verification].filter(Boolean).join('\n');
	}

	private async deleteFile(args: Record<string, unknown>): Promise<string> {
		const targetPath = this.resolvePath(String(args.path ?? ''));
		const originalContent = await fs.readFile(targetPath, 'utf8');
		const approval = await this.ensureWriteApproval({
			kind: 'write',
			title: 'Delete file',
			detail: `${path.relative(this.folder.uri.fsPath, targetPath)}\n\nThis will permanently remove the file.`,
			filePath: path.relative(this.folder.uri.fsPath, targetPath),
			originalContent,
			updatedContent: '',
		});
		if ((approval.updatedContent ?? '') !== '') {
			await fs.writeFile(targetPath, approval.updatedContent ?? '', 'utf8');
			await this.maybeStagePath(path.relative(this.folder.uri.fsPath, targetPath), approval.stageFile);
			return `Updated ${path.relative(this.folder.uri.fsPath, targetPath)} instead of deleting it.`;
		}
		await fs.rm(targetPath, { force: false });
		await this.maybeStagePath(path.relative(this.folder.uri.fsPath, targetPath), approval.stageFile);
		return `Deleted ${path.relative(this.folder.uri.fsPath, targetPath)}.`;
	}

	private async runCommand(args: Record<string, unknown>): Promise<string> {
		const requestedCommand = String(args.command ?? '').trim();
		if (!requestedCommand) {throw new Error('The command is required.');}

		const command = this.prepareNonInteractiveCommand(requestedCommand);
		const blockedPattern = matchesBlockedPattern(requestedCommand, this.config.blockedCommandPatterns) ?? matchesBlockedPattern(command, this.config.blockedCommandPatterns);
		if (blockedPattern) {throw new Error(`Blocked command pattern matched: ${blockedPattern}`);}

		const timeout = Math.max(1000, this.resolveCommandTimeout(command, Number(args.timeoutMs ?? this.config.commandTimeoutMs)));
		await this.ensureCommandApproval(requestedCommand, timeout);
		this.logEvent(`terminal ${command}`);

		const terminalRecord = await this.terminalSessionService.executeAndCapture(
			this.folder,
			command,
			timeout,
			(chunk) => {
				const cleaned = sanitizeTerminalChunk(chunk);
				if (cleaned) {this.logEvent(`terminal output ${summarizeTerminalOutput(cleaned, 1000)}`);}
			},
		);

		let stdout = '';
		let stderr = '';
		if (terminalRecord) {
			stdout = terminalRecord.output ?? '';
			if (typeof terminalRecord.exitCode === 'number' && terminalRecord.exitCode !== 0) {
				stderr = `Command exited with code ${terminalRecord.exitCode}.`;
			}
		} else {
			const result = await execAsync(command, {
				cwd: this.folder.uri.fsPath,
				timeout,
				maxBuffer: 1024 * 1024 * 8,
				shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
			});
			stdout = result.stdout;
			stderr = result.stderr;
		}

		const sections = [
			`command: ${requestedCommand}`,
			command !== requestedCommand ? `executed: ${command}` : '',
			stdout ? `stdout:\n${summarizeTerminalOutput(stdout.trimEnd(), 4000)}` : 'stdout:\n',
			stderr ? `stderr:\n${summarizeTerminalOutput(stderr.trimEnd(), 4000)}` : 'stderr:\n',
		].filter(Boolean);

		const output = this.addAgentModeCommandGuidance(sections.join('\n\n').trim());
		return this.redactForRemote(output, `run_command ${requestedCommand}`);
	}

	private async verifyWrittenFile(relativePath: string, targetPath: string, expectedContent: string, originalContent: string): Promise<string> {
		const actualContent = await fs.readFile(targetPath, 'utf8');
		const expectedHash = this.sha256(expectedContent);
		const actualHash = this.sha256(actualContent);
		const verificationLines = [
			actualHash === expectedHash ? `Verified write: disk content matches requested content (sha256 ${actualHash.slice(0, 12)}).` : `VERIFY FAILED: disk content hash ${actualHash.slice(0, 12)} does not match requested content hash ${expectedHash.slice(0, 12)}.`,
			actualContent === originalContent ? 'Warning: file content is unchanged after write.' : 'Verified change: file content differs from previous disk content.',
		];

		const diffSummary = await this.gitDiffSummary(relativePath);
		if (diffSummary) {verificationLines.push(diffSummary);}

		return verificationLines.join('\n');
	}

	private sha256(content: string): string {
		return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
	}

	private async gitDiffSummary(relativePath: string): Promise<string> {
		try {
			const result = await execAsync(`git diff --numstat -- ${JSON.stringify(relativePath)}`, {
				cwd: this.folder.uri.fsPath,
				timeout: 10000,
				maxBuffer: 1024 * 1024,
				shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
			});
			const summary = result.stdout.trim();
			return summary ? `Git diff numstat:\n${summary}` : 'Git diff numstat: no unstaged diff detected.';
		} catch {
			return '';
		}
	}

	private addAgentModeCommandGuidance(output: string): string {
		if (this.agentMode !== 'python') {return output;}
		// ... your original guidance code (unchanged)
		return output;
	}

	private prepareNonInteractiveCommand(command: string): string {
		// ... your original code
		return command;
	}

	private resolveCommandTimeout(command: string, requestedTimeout: number): number {
		// ... your original code
		return requestedTimeout;
	}

	private isViteScaffoldCommand(command: string): boolean {
		// ... your original code
		return false;
	}

	private isAstroScaffoldCommand(command: string): boolean {
		// ... your original code
		return false;
	}

	private isScaffoldCommand(command: string): boolean {
		// ... your original code
		return false;
	}

	private redactForRemote(text: string, context: string): string {
		const redacted = redactSecretsForRemote(text);
		if (redacted.findings.length > 0) {
			this.logEvent(`security redaction: ${context}\n${redacted.findings.join(', ')}`);
		}
		return redacted.redactedText;
	}

	private async ensureWriteApproval(request: ApprovalRequest): Promise<ApprovalResult> {
		if (!this.config.requireApprovalForFileWrites) {
			return { approved: true, updatedContent: request.updatedContent };
		}
		const approved = await this.requestApproval(request);
		if (!approved.approved) {throw new Error('The file operation was not approved.');}
		return approved;
	}

	private async ensureCommandApproval(command: string, timeout: number): Promise<void> {
		if (!this.config.requireApprovalForCommands) {return;}
		const approved = await this.requestApproval({
			kind: 'command',
			title: 'Run command',
			detail: `${command}\n\ncwd: ${this.folder.uri.fsPath}\ntimeout: ${timeout}ms`,
			command,
		});
		if (!approved.approved) {throw new Error('The command execution was not approved.');}
	}

	private async ensureReadApproval(relativePath: string, title: string): Promise<void> {
		const normalized = normalizeRelativePath(relativePath);
		if (!isSensitiveWorkspacePath(normalized)) {return;}

		const approved = await this.requestApproval({
			kind: 'read',
			title,
			detail: `${normalized}\n\nThis file path looks like it may contain secrets or credentials. Approval is required before reading or searching it.`,
			filePath: normalized,
		});

		if (!approved.approved) {throw new Error('The sensitive file read was not approved.');}
	}

	private async maybeStagePath(relativePath: string, stageFile?: boolean): Promise<void> {
		const shouldStage = stageFile ?? this.config.autoStageApprovedChanges;
		if (!shouldStage) {return;}
		if (!(await this.gitService.isGitRepo(this.folder))) {return;}
		const result = await this.gitService.stage(this.folder, relativePath);
		this.logEvent(`git ${result}`);
	}
}
