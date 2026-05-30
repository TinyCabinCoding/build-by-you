import * as vscode from 'vscode';
import { TerminalCommandRecord } from '../core/types';

export class TerminalSessionService {
	private readonly terminals = new Map<string, vscode.Terminal>();
	private readonly history = new Map<string, TerminalCommandRecord[]>();
	private readonly latestPreviewUrl = new Map<string, string>();
	private readonly latestDevCommand = new Map<string, string>();
	private readonly activePersistentCommands = new Map<string, TerminalCommandRecord>();

	public constructor() {
		vscode.window.onDidCloseTerminal((terminal) => {
			for (const [key, trackedTerminal] of this.terminals.entries()) {
				if (trackedTerminal !== terminal) {
					continue;
				}

				this.terminals.delete(key);
				this.activePersistentCommands.delete(key);
				this.latestPreviewUrl.delete(key);
			}
		});
	}

	public getOrCreate(folder: vscode.WorkspaceFolder): vscode.Terminal {
		const key = folder.uri.toString();
		let terminal = this.terminals.get(key);
		if (!terminal) {
			terminal = vscode.window.createTerminal({
				name: `GrokRepoChat: ${folder.name}`,
				cwd: folder.uri.fsPath,
			});
			this.terminals.set(key, terminal);
		}
		return terminal;
	}

	public run(folder: vscode.WorkspaceFolder, command: string): TerminalCommandRecord {
		const terminal = this.getOrCreate(folder);
		const key = folder.uri.toString();
		terminal.show(true);
		const record = {
			command,
			cwd: folder.uri.fsPath,
			startedAt: new Date().toISOString(),
			previewUrls: [],
		};
		const entries = this.history.get(key) ?? [];
		entries.push(record);
		this.history.set(key, entries.slice(-50));
		return record;
	}

	public isPersistentCommandRunning(folder: vscode.WorkspaceFolder): boolean {
		return this.activePersistentCommands.has(folder.uri.toString());
	}

	public async executeAndCapture(
		folder: vscode.WorkspaceFolder,
		command: string,
		timeoutMs: number,
		onData?: (chunk: string) => void,
	): Promise<TerminalCommandRecord | undefined> {
		const terminal = this.getOrCreate(folder);
		terminal.show(true);
		const record = this.run(folder, command);
		this.latestDevCommand.set(folder.uri.toString(), command);
		const shellIntegration = await this.waitForShellIntegration(terminal, 3000);
		if (!shellIntegration) {
			return undefined;
		}

		const execution = shellIntegration.executeCommand(`cd ${this.shellQuote(folder.uri.fsPath)} && ${command}`);
		const readPromise = this.observeExecution(folder, execution, record, onData);

		const timedExit = new Promise<number>((resolve, reject) => {
			const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
				if (event.execution === execution) {
					clearTimeout(timer);
					disposable.dispose();
					resolve(event.exitCode ?? -1);
				}
			});
			const timer = setTimeout(() => {
				disposable.dispose();
				reject(new Error(`Command timed out after ${timeoutMs}ms.`));
			}, timeoutMs);
		});

		const exitCode = await timedExit;
		await Promise.race([
			readPromise,
			new Promise((resolve) => setTimeout(resolve, 1500)),
		]);
		record.exitCode = exitCode;
		return record;
	}

	private shellQuote(value: string): string {
		if (process.platform === 'win32') {
			return `"${value.replace(/"/g, '""')}"`;
		}
		return `'${value.replace(/'/g, "'\\''")}'`;
	}

	public async startPersistentCommand(
		folder: vscode.WorkspaceFolder,
		command: string,
		onData?: (chunk: string) => void,
		onPreview?: (url: string) => void,
		onExit?: (exitCode: number) => void,
	): Promise<TerminalCommandRecord> {
		const terminal = this.getOrCreate(folder);
		terminal.show(true);
		const record = this.run(folder, command);
		record.persistent = true;
		this.latestDevCommand.set(folder.uri.toString(), command);
		this.activePersistentCommands.set(folder.uri.toString(), record);
		const shellIntegration = await this.waitForShellIntegration(terminal, 3000);
		if (!shellIntegration) {
			terminal.sendText(command, true);
			return record;
		}

		const execution = shellIntegration.executeCommand(command);
		void this.observeExecution(folder, execution, record, onData, onPreview);
		void vscode.window.onDidEndTerminalShellExecution((event) => {
			if (event.execution === execution) {
				record.exitCode = event.exitCode ?? -1;
				this.activePersistentCommands.delete(folder.uri.toString());
				onExit?.(record.exitCode);
			}
		});
		return record;
	}

	public stopPersistentCommand(folder: vscode.WorkspaceFolder): boolean {
		const key = folder.uri.toString();
		const terminal = this.terminals.get(key);
		if (!terminal) {
			return false;
		}

		terminal.show(true);
		terminal.sendText('\u0003', false);
		this.activePersistentCommands.delete(key);
		this.latestPreviewUrl.delete(key);
		return true;
	}

	public getHistory(folder: vscode.WorkspaceFolder): TerminalCommandRecord[] {
		return this.history.get(folder.uri.toString()) ?? [];
	}

	public exportHistory(): Record<string, TerminalCommandRecord[]> {
		return Object.fromEntries(this.history.entries());
	}

	public importHistory(history: Record<string, TerminalCommandRecord[]>): void {
		for (const [key, records] of Object.entries(history)) {
			this.history.set(key, records.slice(-50));
		}
	}

	public clearAll(): void {
		for (const terminal of this.terminals.values()) {
			terminal.dispose();
		}
		this.terminals.clear();
		this.history.clear();
		this.latestPreviewUrl.clear();
		this.latestDevCommand.clear();
		this.activePersistentCommands.clear();
	}

	public getLatestPreviewUrl(folder: vscode.WorkspaceFolder): string | undefined {
		return this.latestPreviewUrl.get(folder.uri.toString());
	}

	public getLatestDevCommand(folder: vscode.WorkspaceFolder): string | undefined {
		return this.latestDevCommand.get(folder.uri.toString());
	}

	public rememberPreviewUrl(folder: vscode.WorkspaceFolder, url: string): void {
		this.latestPreviewUrl.set(folder.uri.toString(), url.replace('0.0.0.0', 'localhost'));
	}

	public clearPreviewUrl(folder: vscode.WorkspaceFolder): void {
		this.latestPreviewUrl.delete(folder.uri.toString());
	}

	private async waitForShellIntegration(terminal: vscode.Terminal, timeoutMs: number): Promise<vscode.TerminalShellIntegration | undefined> {
		if (terminal.shellIntegration) {
			return terminal.shellIntegration;
		}

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				disposable.dispose();
				resolve(undefined);
			}, timeoutMs);

			const disposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
				if (event.terminal === terminal) {
					clearTimeout(timeout);
					disposable.dispose();
					resolve(event.shellIntegration);
				}
			});
		});
	}

	private async observeExecution(
		folder: vscode.WorkspaceFolder,
		execution: vscode.TerminalShellExecution,
		record: TerminalCommandRecord,
		onData?: (chunk: string) => void,
		onPreview?: (url: string) => void,
	): Promise<void> {
		let output = '';
		record.output = output;
		const reader = execution.read();
		for await (const chunk of reader) {
			output += chunk;
			record.output = output;
			const previews = this.extractPreviewUrls(chunk);
			if (previews.length > 0) {
				const previewUrl = this.choosePreviewUrl(previews);
				record.previewUrls = [...(record.previewUrls ?? []), ...previews];
				this.latestPreviewUrl.set(folder.uri.toString(), previewUrl);
				onPreview?.(previewUrl);
			}
			onData?.(chunk);
		}
		record.output = output;
	}

	private extractPreviewUrls(text: string): string[] {
		const cleaned = text
			.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
			.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
			.replace(/[\u001b\u009b]/g, '');
		const matches = cleaned.match(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}(?:\/[^\s<>"')\]]*)?/gi) ?? [];
		const normalized = matches.map((value) =>
			value.replace('0.0.0.0', 'localhost').replace(/[.,;:!?]+$/, ''),
		);
		return [...new Set(normalized)];
	}

	private choosePreviewUrl(urls: string[]): string {
		const parsed = urls
			.map((url) => {
				try {
					return { url, parsed: new URL(url) };
				} catch {
					return undefined;
				}
			})
			.filter((item): item is { url: string; parsed: URL } => item !== undefined);

		const rootUrl = parsed.find((item) => item.parsed.pathname === '/' || item.parsed.pathname === '');
		if (rootUrl) {
			return rootUrl.url;
		}

		const publicUrl = parsed.find((item) => !/^\/(?:presenter|overview|export)(?:\/|$)/.test(item.parsed.pathname));
		return publicUrl?.url ?? urls[0];
	}
}
