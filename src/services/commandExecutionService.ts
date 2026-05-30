import * as cp from 'child_process';
import * as util from 'util';
import * as vscode from 'vscode';
import { TerminalSessionService } from './terminalSessionService';

const execAsync = util.promisify(cp.exec);

export interface CommandExecutionResult {
	command: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	previewUrls: string[];
	source: 'terminal' | 'process';
}

export class CommandExecutionService {
	public constructor(private readonly terminalSessionService: TerminalSessionService) {}

	public async run(
		folder: vscode.WorkspaceFolder,
		command: string,
		timeoutMs: number,
		onData?: (chunk: string) => void,
	): Promise<CommandExecutionResult> {
		const terminalRecord = await this.terminalSessionService.executeAndCapture(folder, command, timeoutMs, onData);
		if (terminalRecord) {
			return {
				command,
				exitCode: terminalRecord.exitCode ?? -1,
				stdout: terminalRecord.output ?? '',
				stderr: terminalRecord.exitCode && terminalRecord.exitCode !== 0 ? `Command exited with code ${terminalRecord.exitCode}.` : '',
				previewUrls: terminalRecord.previewUrls ?? [],
				source: 'terminal',
			};
		}

		try {
			const result = await execAsync(command, {
				cwd: folder.uri.fsPath,
				timeout: timeoutMs,
				maxBuffer: 1024 * 1024 * 8,
				shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
			});
			return {
				command,
				exitCode: 0,
				stdout: result.stdout,
				stderr: result.stderr,
				previewUrls: [],
				source: 'process',
			};
		} catch (error) {
			const executionError = error as cp.ExecException & { stdout?: string; stderr?: string };
			return {
				command,
				exitCode: typeof executionError.code === 'number' ? executionError.code : -1,
				stdout: executionError.stdout ?? '',
				stderr: executionError.stderr ?? executionError.message,
				previewUrls: [],
				source: 'process',
			};
		}
	}
}
