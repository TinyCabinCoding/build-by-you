import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspaceSummary } from '../core/types';
import { truncateText } from '../util/pathUtils';

const keyFileNames = [
	'AGENTS.md',
	'README.md',
	'README.txt',
	'package.json',
	'astro.config.mjs',
	'vite.config.ts',
	'vite.config.js',
	'tsconfig.json',
	'wrangler.jsonc',
	'wrangler.toml',
	'vercel.json',
];

const ignoredDirs = new Set([
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

export class WorkspaceContextService {
	public getDefaultWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
		return vscode.workspace.workspaceFolders?.[0];
	}

	public async pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (folders.length <= 1) {
			return folders[0];
		}

		const picked = await vscode.window.showQuickPick(
			folders.map((folder) => ({
				label: folder.name,
				description: folder.uri.fsPath,
				folder,
			})),
			{ placeHolder: 'Select workspace folder for Build by You' },
		);
		return picked?.folder;
	}

	public resolveWorkspaceFolder(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
		if (uri) {
			return vscode.workspace.getWorkspaceFolder(uri)
				?? vscode.workspace.workspaceFolders?.find((folder) => folder.uri.toString() === uri.toString());
		}
		return this.getDefaultWorkspaceFolder();
	}

	public async buildSummary(folder: vscode.WorkspaceFolder): Promise<WorkspaceSummary> {
		const topLevelEntries = await this.listTopLevelEntries(folder.uri.fsPath);
		const keyFiles = await this.readKeyFiles(folder.uri.fsPath);
		const activeFile = this.activeFileRelativePath(folder.uri.fsPath);
		return {
			label: folder.name,
			rootPath: folder.uri.fsPath,
			workspaceCount: vscode.workspace.workspaceFolders?.length ?? 0,
			activeFile,
			topLevelEntries,
			keyFiles,
		};
	}

	private async listTopLevelEntries(rootPath: string): Promise<string[]> {
		try {
			const entries = await fs.readdir(rootPath, { withFileTypes: true });
			return entries
				.filter((entry) => !ignoredDirs.has(entry.name))
				.sort((a, b) => a.name.localeCompare(b.name))
				.slice(0, 80)
				.map((entry) => `${entry.isDirectory() ? 'dir' : 'file'} ${entry.name}`);
		} catch {
			return [];
		}
	}

	private async readKeyFiles(rootPath: string): Promise<WorkspaceSummary['keyFiles']> {
		const results: WorkspaceSummary['keyFiles'] = [];
		for (const fileName of keyFileNames) {
			const filePath = path.join(rootPath, fileName);
			try {
				const stat = await fs.stat(filePath);
				if (!stat.isFile() || stat.size > 1_000_000) {
					continue;
				}
				const content = await fs.readFile(filePath, 'utf8');
				results.push({
					path: fileName,
					preview: truncateText(content, 4000),
				});
			} catch {
				// Ignore missing/unreadable context files.
			}
		}
		return results;
	}

	private activeFileRelativePath(rootPath: string): string | undefined {
		const active = vscode.window.activeTextEditor?.document.uri;
		if (!active || active.scheme !== 'file') {
			return undefined;
		}
		const relative = path.relative(rootPath, active.fsPath);
		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			return undefined;
		}
		return relative || undefined;
	}
}
