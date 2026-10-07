import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { TaskPreset } from '../core/types';

export class TaskPresetService {
	public async getPresets(folder: vscode.WorkspaceFolder, configured: TaskPreset[]): Promise<TaskPreset[]> {
		const defaults: TaskPreset[] = [
			{ name: 'lint', command: 'npm run lint', description: 'Run project lint checks' },
			{ name: 'test', command: 'npm test', description: 'Run project tests' },
			{ name: 'build', command: 'npm run build', description: 'Run build script if present' },
			{ name: 'compile', command: 'npm run compile', description: 'Run extension compile script' },
		];

		const packageJsonPath = path.join(folder.uri.fsPath, 'package.json');
		try {
			const content = await fs.readFile(packageJsonPath, 'utf8');
			const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
			const scripts = parsed.scripts ?? {};
			return [
				...defaults.filter((item) => {
					const scriptName = item.command.replace('npm run ', '');
					return scriptName === 'build' ? Boolean(scripts.build) : Boolean(scripts[scriptName]);
				}),
				...configured.filter((item) => item.name.trim() && item.command.trim()),
			];
		} catch {
			return configured.filter((item) => item.name.trim() && item.command.trim());
		}
	}

	public async getVerificationPresets(folder: vscode.WorkspaceFolder, configured: TaskPreset[]): Promise<TaskPreset[]> {
		const packageJsonPath = path.join(folder.uri.fsPath, 'package.json');
		const configuredVerification = configured.filter((item) => /lint|test|build|compile|check|verify/i.test(item.name) || /lint|test|build|compile|check|verify/i.test(item.command));
		try {
			const content = await fs.readFile(packageJsonPath, 'utf8');
			const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
			const scripts = parsed.scripts ?? {};
			const orderedCandidates: Array<[string, string, string]> = [
				['compile', 'npm run compile', 'Compile the project'],
				['build', 'npm run build', 'Build the project'],
				['lint', 'npm run lint', 'Run lint checks'],
				['test', 'npm test', 'Run automated tests'],
			];
			return [
				...orderedCandidates
					.filter(([scriptName]) => Boolean(scripts[scriptName]) || (scriptName === 'test' && Boolean(scripts.test)))
					.map(([name, command, description]) => ({ name, command, description })),
				...configuredVerification,
			];
		} catch {
			return configuredVerification;
		}
	}

	public async getDevPresets(folder: vscode.WorkspaceFolder, configured: TaskPreset[]): Promise<TaskPreset[]> {
		const packageJsonPath = path.join(folder.uri.fsPath, 'package.json');
		const configuredDev = configured.filter((item) => /dev|serve|start|preview/i.test(item.name) || /dev|serve|start|preview/i.test(item.command));
		try {
			const content = await fs.readFile(packageJsonPath, 'utf8');
			const parsed = JSON.parse(content) as {
				scripts?: Record<string, string>;
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
			};
			const scripts = parsed.scripts ?? {};
			const deps = {
				...(parsed.dependencies ?? {}),
				...(parsed.devDependencies ?? {}),
			};
			const candidates: Array<[string, string, string]> = [
				['dev', 'npm run dev', 'Start the local development server'],
				['start', 'npm run start', 'Start the local application server'],
				['serve', 'npm run serve', 'Serve the local application'],
				['preview', 'npm run preview', 'Preview the local production build'],
			];
			const presets = [
				...candidates
					.filter(([scriptName]) => Boolean(scripts[scriptName]))
					.map(([name, command, description]) => ({ name, command, description })),
				...configuredDev,
			];
			if (presets.length > 0) {
				return presets;
			}
			if (await this.isSlidevWorkspace(folder, scripts, deps)) {
				return [{
					name: 'slidev',
					command: 'npx --yes slidev',
					description: 'Start a local Slidev deck server',
				}];
			}
			const htmlPreset = await this.createStaticHtmlPreset(folder);
			return htmlPreset ? [htmlPreset] : presets;
		} catch {
			if (await this.isSlidevWorkspace(folder)) {
				return [{
					name: 'slidev',
					command: 'npx --yes slidev',
					description: 'Start a local Slidev deck server',
				}];
			}
			const htmlPreset = await this.createStaticHtmlPreset(folder);
			if (htmlPreset) {
				return [htmlPreset, ...configuredDev];
			}
			return [
				...configuredDev,
			];
		}
	}

	private async isSlidevWorkspace(
		folder: vscode.WorkspaceFolder,
		scripts: Record<string, string> = {},
		deps: Record<string, string> = {},
	): Promise<boolean> {
		if ('@slidev/cli' in deps || 'slidev' in deps) {
			return true;
		}
		if (/\bslidev\b/i.test(Object.values(scripts).join(' '))) {
			return true;
		}
		try {
			await fs.access(path.join(folder.uri.fsPath, 'slides.md'));
			return true;
		} catch {
			return false;
		}
	}

	private async createStaticHtmlPreset(folder: vscode.WorkspaceFolder): Promise<TaskPreset | undefined> {
		const previewChoices = await this.findHtmlPreviewPaths(folder.uri.fsPath);
		if (previewChoices.length === 0) {
			return undefined;
		}

		const previewPath = previewChoices[0].path;
		const pythonCommand = await this.detectPythonServerCommand(folder.uri.fsPath);
		return {
			name: 'static-html',
			command: `${pythonCommand} -m http.server 8000`,
			description: previewChoices.length === 1
				? `Serve static HTML files from the workspace and preview ${previewPath}`
				: `Serve static HTML files from the workspace and choose one of ${previewChoices.length} HTML files`,
			previewPath,
			previewChoices,
		};
	}

	private async detectPythonServerCommand(root: string): Promise<string> {
		const venvPython = process.platform === 'win32'
			? path.join(root, '.venv', 'Scripts', 'python.exe')
			: path.join(root, '.venv', 'bin', 'python');
		try {
			await fs.access(venvPython);
			return process.platform === 'win32'
				? `"${venvPython.replace(/"/g, '""')}"`
				: `'${venvPython.replace(/'/g, "'\\''")}'`;
		} catch {
			return process.platform === 'win32' ? 'python' : 'python3';
		}
	}

	private async findHtmlPreviewPaths(root: string): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
		const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.build-by-you']);
		const candidates: Array<{ path: string; mtimeMs: number; size: number }> = [];

		const visit = async (dir: string, depth: number): Promise<void> => {
			if (depth > 6 || candidates.length > 2000) {
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

				if (!entry.isFile() || !/\.(?:html?|xhtml)$/i.test(entry.name)) {
					continue;
				}

				try {
					const stat = await fs.stat(fullPath);
					candidates.push({
						path: path.relative(root, fullPath).split(path.sep).join('/'),
						mtimeMs: stat.mtimeMs,
						size: stat.size,
					});
				} catch {
					// Ignore files that disappear during scanning.
				}
			}
		};

		await visit(root, 0);
		candidates.sort((a, b) => this.htmlPreviewRank(a.path) - this.htmlPreviewRank(b.path) || b.mtimeMs - a.mtimeMs);
		return candidates;
	}

	private htmlPreviewRank(relativePath: string): number {
		const basename = path.basename(relativePath).toLowerCase();
		if (basename === 'index.html' || basename === 'index.htm') {
			return 0;
		}
		if (/\bdashboard\b/i.test(basename)) {
			return 1;
		}
		if (/\breport\b/i.test(basename)) {
			return 2;
		}
		return 3;
	}
}
