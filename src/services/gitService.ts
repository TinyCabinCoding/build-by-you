import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';
import * as vscode from 'vscode';

const execAsync = util.promisify(cp.exec);
const execFileAsync = util.promisify(cp.execFile);

interface GitExecResult {
	stdout: string;
	stderr: string;
}

export class GitService {
	public async loginGithub(): Promise<string> {
		const session = await this.getGithubSession(true, true);
		const login = await this.githubUsername(session.accessToken);
		return `Signed in to GitHub as ${login}.`;
	}

	public async githubWhoami(): Promise<string> {
		const session = await this.getGithubSession(false);
		if (!session) {
			return 'Not signed in to GitHub. Run `/git login` first.';
		}
		const profile = await this.githubRequest<{ login?: string; html_url?: string }>('/user', session.accessToken, 'GET');
		const login = profile.login ?? session.account.label;
		return [`GitHub account: ${login}`, profile.html_url ?? ''].filter(Boolean).join('\n');
	}

	public async isGitRepo(folder: vscode.WorkspaceFolder): Promise<boolean> {
		try {
			await this.git(folder, ['rev-parse', '--is-inside-work-tree'], 5000);
			return true;
		} catch {
			return false;
		}
	}

	public async init(folder: vscode.WorkspaceFolder): Promise<string> {
		let result: GitExecResult;
		try {
			result = await this.git(folder, ['init', '-b', 'main'], 10000);
		} catch {
			result = await this.git(folder, ['init'], 10000);
		}
		return this.compactResult('Initialized git repository.', result);
	}

	public async start(folder: vscode.WorkspaceFolder): Promise<string> {
		const steps: string[] = [];
		if (!(await this.isGitRepo(folder))) {
			steps.push(await this.init(folder));
		} else {
			steps.push('Git repository already initialized.');
		}

		await this.ensureDefaultGitignore(folder);
		steps.push('Default .gitignore is ready.');
		steps.push(await this.stageAll(folder));
		steps.push('Next: create a GitHub repo, then run `/git remote add <github-url>` and `/git push`.');
		return steps.filter(Boolean).join('\n');
	}

	public async status(folder: vscode.WorkspaceFolder): Promise<string> {
		const { stdout } = await this.git(folder, ['status', '--short'], 10000);
		return stdout.trim() || 'Working tree clean.';
	}

	public async diff(folder: vscode.WorkspaceFolder, relativePath?: string): Promise<string> {
		const args = relativePath ? ['diff', '--', relativePath] : ['diff'];
		const { stdout } = await this.git(folder, args, 10000, 1024 * 1024 * 8);
		return stdout.trim() || 'No unstaged diff.';
	}

	public async diffStaged(folder: vscode.WorkspaceFolder, relativePath?: string): Promise<string> {
		const args = relativePath ? ['diff', '--staged', '--', relativePath] : ['diff', '--staged'];
		const { stdout } = await this.git(folder, args, 10000, 1024 * 1024 * 8);
		return stdout.trim() || 'No staged diff.';
	}

	public async diffSummary(folder: vscode.WorkspaceFolder): Promise<string> {
		const { stdout } = await execAsync('git diff --numstat HEAD', {
			cwd: folder.uri.fsPath,
			timeout: 10000,
			maxBuffer: 1024 * 1024 * 8,
			shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
		});
		const lines = stdout
			.trim()
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);
		if (lines.length === 0) {
			return '';
		}

		const entries = lines
			.map((line) => {
				const [added = '0', removed = '0', ...pathParts] = line.split('\t');
				const filePath = pathParts.join('\t').trim();
				if (!filePath) {
					return undefined;
				}
				return `- ${filePath} (+${added} -${removed})`;
			})
			.filter((entry): entry is string => Boolean(entry));
		if (entries.length === 0) {
			return '';
		}

		return ['Diff report:', ...entries.slice(0, 8), entries.length > 8 ? '- ...' : '']
			.filter(Boolean)
			.join('\n');
	}

	public async stage(folder: vscode.WorkspaceFolder, relativePath: string): Promise<string> {
		try {
			await this.git(folder, ['add', '-A', '--', relativePath], 10000);
			return `Staged ${relativePath}.`;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/pathspec .* did not match any files/i.test(message)) {
				return `Skipped staging missing path ${relativePath}.`;
			}
			throw error;
		}
	}

	public async stageAll(folder: vscode.WorkspaceFolder): Promise<string> {
		await this.ensureDefaultGitignore(folder);
		await this.git(folder, ['add', '-A'], 10000);
		return 'Staged all workspace changes.';
	}

	public async unstage(folder: vscode.WorkspaceFolder, relativePath: string): Promise<string> {
		await this.git(folder, ['restore', '--staged', '--', relativePath], 10000);
		return `Unstaged ${relativePath}.`;
	}

	public async unstageAll(folder: vscode.WorkspaceFolder): Promise<string> {
		await this.git(folder, ['restore', '--staged', '.'], 10000);
		return 'Unstaged all workspace changes.';
	}

	public async branch(folder: vscode.WorkspaceFolder): Promise<string> {
		const { stdout } = await this.git(folder, ['branch', '--show-current'], 10000);
		const current = stdout.trim();
		return current ? `Current branch: ${current}` : 'No current branch yet.';
	}

	public async checkout(folder: vscode.WorkspaceFolder, branch: string, create = false): Promise<string> {
		const result = await this.git(folder, create ? ['checkout', '-b', branch] : ['checkout', branch], 10000);
		return this.compactResult(`${create ? 'Created and switched to' : 'Switched to'} ${branch}.`, result);
	}

	public async commit(folder: vscode.WorkspaceFolder, message: string): Promise<string> {
		await this.ensureDefaultGitignore(folder);
		const status = await this.status(folder);
		if (status === 'Working tree clean.') {
			return 'No changes to commit.';
		}
		const staged = await this.diffStaged(folder);
		if (staged === 'No staged diff.') {
			await this.stageAll(folder);
		}
		const result = await this.git(folder, ['commit', '-m', message], 30000, 1024 * 1024 * 4);
		return this.compactResult('Committed staged changes.', result);
	}

	public async addCommitPush(folder: vscode.WorkspaceFolder, message: string, remote = 'origin', branch?: string): Promise<string> {
		const steps: string[] = [];
		if (!(await this.isGitRepo(folder))) {
			steps.push(await this.init(folder));
		}

		steps.push(await this.stageAll(folder));
		const status = await this.status(folder);
		if (status === 'Working tree clean.') {
			steps.push('No changes to commit.');
		} else {
			steps.push(await this.commit(folder, message));
		}
		steps.push(await this.pushWithGithubAuth(folder, remote, branch));
		return steps.filter(Boolean).join('\n');
	}

	public async remotes(folder: vscode.WorkspaceFolder): Promise<string> {
		const { stdout } = await this.git(folder, ['remote', '-v'], 10000);
		return stdout.trim() || 'No git remotes configured.';
	}

	public async addRemote(folder: vscode.WorkspaceFolder, name: string, url: string): Promise<string> {
		const result = await this.git(folder, ['remote', 'add', name, url], 10000);
		return this.compactResult(`Added remote ${name}: ${url}`, result);
	}

	public async setRemote(folder: vscode.WorkspaceFolder, name: string, url: string): Promise<string> {
		const result = await this.git(folder, ['remote', 'set-url', name, url], 10000);
		return this.compactResult(`Updated remote ${name}: ${url}`, result);
	}

	public async push(folder: vscode.WorkspaceFolder, remote = 'origin', branch?: string): Promise<string> {
		const remoteUrl = await this.remoteUrl(folder, remote);
		if (!remoteUrl) {
			return `No git remote named ${remote} is configured. Add one first:\n/git remote add ${remote} https://github.com/YOUR_USER/YOUR_REPO.git\n\nOr create and push a new GitHub repo with:\n/git publish github <repo> [--public|--private]`;
		}

		const targetBranch = branch || await this.currentBranch(folder) || 'main';
		const prepMessage = await this.ensureCommitReadyForPush(folder, targetBranch);

		const result = await this.git(folder, ['push', '-u', remote, targetBranch], 120000, 1024 * 1024 * 8);
		return [prepMessage, this.compactResult(`Pushed ${targetBranch} to ${remote}.`, result)].filter(Boolean).join('\n');
	}

	public async pushWithGithubAuth(folder: vscode.WorkspaceFolder, remote = 'origin', branch?: string): Promise<string> {
		const session = await this.getGithubSession(true, false);
		const targetBranch = branch || await this.currentBranch(folder) || 'main';
		const remoteUrl = await this.remoteUrl(folder, remote);
		if (!remoteUrl) {
			return `No git remote named ${remote} is configured. Add one first:\n/git remote add ${remote} https://github.com/YOUR_USER/YOUR_REPO.git`;
		}
		const prepMessage = await this.ensureCommitReadyForPush(folder, targetBranch);
		if (!/^https:\/\/github\.com\//i.test(remoteUrl)) {
			const result = await this.git(folder, ['push', '-u', remote, targetBranch], 120000, 1024 * 1024 * 8);
			return [prepMessage, this.compactResult(`Pushed ${targetBranch} to ${remote}.`, result)].filter(Boolean).join('\n');
		}
		const result = await this.gitWithGithubToken(folder, ['push', '-u', remote, targetBranch], session.accessToken, 120000, 1024 * 1024 * 8);
		return [prepMessage, this.compactResult(`Pushed ${targetBranch} to ${remote} as ${session.account.label}.`, result)].filter(Boolean).join('\n');
	}

	public async pull(folder: vscode.WorkspaceFolder, remote = 'origin', branch?: string): Promise<string> {
		const args = branch ? ['pull', remote, branch] : ['pull'];
		const result = await this.git(folder, args, 120000, 1024 * 1024 * 8);
		return this.compactResult('Pulled latest changes.', result);
	}

	public async sync(folder: vscode.WorkspaceFolder): Promise<string> {
		const pull = await this.pull(folder);
		const push = await this.push(folder);
		return [pull, push].join('\n\n');
	}

	public async publishGithub(folder: vscode.WorkspaceFolder, repo: string, visibility: 'private' | 'public' = 'private'): Promise<string> {
		const session = await this.getGithubSession(true, false);
		if (!(await this.isGitRepo(folder))) {
			await this.init(folder);
		}
		if (!(await this.currentBranch(folder))) {
			await this.stageAll(folder);
			const status = await this.status(folder);
			if (status !== 'Working tree clean.') {
				await this.commit(folder, 'Initial commit');
			}
		}
		const owner = await this.githubUsername(session.accessToken);
		const repository = await this.createGithubRepository(session.accessToken, repo, visibility);
		const cloneUrl = repository.clone_url ?? `https://github.com/${owner}/${repo}.git`;
		const remoteExists = Boolean(await this.remoteUrl(folder, 'origin'));
		if (remoteExists) {
			await this.setRemote(folder, 'origin', cloneUrl);
		} else {
			await this.addRemote(folder, 'origin', cloneUrl);
		}
		const pushResult = await this.pushWithGithubAuth(folder, 'origin');
		return [
			`Published GitHub repository ${repository.full_name ?? `${owner}/${repo}`}.`,
			repository.html_url ?? '',
			pushResult,
		].filter(Boolean).join('\n');
	}

	public async createPullRequest(folder: vscode.WorkspaceFolder, title?: string, body?: string): Promise<string> {
		const session = await this.getGithubSession(true, false);
		const remoteUrl = await this.remoteUrl(folder, 'origin');
		const repo = remoteUrl ? this.parseGithubRepoFromRemote(remoteUrl) : undefined;
		if (!repo) {
			return 'Could not determine GitHub owner/repo from origin. Set an origin like https://github.com/OWNER/REPO.git first.';
		}
		const head = await this.currentBranch(folder);
		if (!head) {
			return 'No current branch exists for PR creation.';
		}
		const payload = {
			title: title || head,
			head,
			base: 'main',
			body: body || '',
		};
		const result = await this.githubRequest<{ html_url?: string }>(`/repos/${repo.owner}/${repo.name}/pulls`, session.accessToken, 'POST', payload);
		return ['Created GitHub pull request.', result.html_url ?? ''].filter(Boolean).join('\n');
	}

	private async currentBranch(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
		const { stdout } = await this.git(folder, ['branch', '--show-current'], 10000);
		return stdout.trim() || undefined;
	}

	private async hasCommit(folder: vscode.WorkspaceFolder): Promise<boolean> {
		try {
			await this.git(folder, ['rev-parse', '--verify', 'HEAD'], 10000);
			return true;
		} catch {
			return false;
		}
	}

	private async ensureCommitReadyForPush(folder: vscode.WorkspaceFolder, branch: string): Promise<string> {
		if (await this.hasCommit(folder)) {
			return '';
		}

		await this.ensureDefaultGitignore(folder);
		await this.git(folder, ['checkout', '-B', branch], 10000);
		await this.stageAll(folder);
		const status = await this.status(folder);
		if (status === 'Working tree clean.') {
			return 'No commit was created because the working tree is clean.';
		}
		await this.commit(folder, 'Initial commit');
		return `Created initial commit on ${branch}.`;
	}

	private async ensureDefaultGitignore(folder: vscode.WorkspaceFolder): Promise<void> {
		const gitignorePath = path.join(folder.uri.fsPath, '.gitignore');
		const defaults = [
			'node_modules/',
			'dist/',
			'.slidev/',
			'.vercel/',
			'.wrangler/',
			'.build-by-you/',
			'.env',
			'.env.*',
			'*.log',
			'coverage/',
		];
		let existing = '';
		try {
			existing = await fs.readFile(gitignorePath, 'utf8');
		} catch {
			// Create below.
		}
		const missing = defaults.filter((entry) => !existing.split(/\r?\n/).some((line) => line.trim() === entry));
		if (missing.length === 0) {
			return;
		}
		const prefix = existing.trim() ? `${existing.replace(/\s*$/, '\n')}\n` : '';
		await fs.writeFile(gitignorePath, `${prefix}${missing.join('\n')}\n`, 'utf8');
	}

	private async remoteUrl(folder: vscode.WorkspaceFolder, remote: string): Promise<string | undefined> {
		try {
			const { stdout } = await this.git(folder, ['remote', 'get-url', remote], 10000);
			return stdout.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	private async git(folder: vscode.WorkspaceFolder, args: string[], timeout: number, maxBuffer = 1024 * 1024): Promise<GitExecResult> {
		return this.execFile(folder, 'git', args, timeout, maxBuffer);
	}

	private async gitWithGithubToken(folder: vscode.WorkspaceFolder, args: string[], token: string, timeout: number, maxBuffer = 1024 * 1024): Promise<GitExecResult> {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-by-you-git-'));
		const askpassPath = path.join(tempDir, process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh');
		const script = process.platform === 'win32'
			? '@echo off\r\necho %1 | findstr /I Username >nul\r\nif %errorlevel%==0 (echo x-access-token) else (echo %BUILD_BY_GROK_GITHUB_TOKEN%)\r\n'
			: '#!/bin/sh\ncase "$1" in\n*Username*) printf "%s" "x-access-token" ;;\n*) printf "%s" "$BUILD_BY_GROK_GITHUB_TOKEN" ;;\nesac\n';
		await fs.writeFile(askpassPath, script, { mode: 0o700 });
		try {
			return await this.execFile(folder, 'git', args, timeout, maxBuffer, {
				GIT_TERMINAL_PROMPT: '0',
				GIT_ASKPASS: askpassPath,
				BUILD_BY_GROK_GITHUB_TOKEN: token,
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}

	private async execFile(folder: vscode.WorkspaceFolder, file: string, args: string[], timeout: number, maxBuffer = 1024 * 1024, env: NodeJS.ProcessEnv = {}): Promise<GitExecResult> {
		try {
			const { stdout, stderr } = await execFileAsync(file, args, {
				cwd: folder.uri.fsPath,
				timeout,
				maxBuffer,
				shell: false,
				env: {
					...process.env,
					...env,
				},
			});
			return { stdout: String(stdout), stderr: String(stderr) };
		} catch (error) {
			const executionError = error as cp.ExecFileException & { stdout?: string | Buffer; stderr?: string | Buffer };
			const detail = [
				`${file} ${args.join(' ')}`,
				executionError.stdout ? String(executionError.stdout).trim() : '',
				executionError.stderr ? String(executionError.stderr).trim() : '',
				executionError.message,
			].filter(Boolean).join('\n');
			throw new Error(detail);
		}
	}

	private async getGithubSession(createIfNone: true, forceNewSession?: boolean): Promise<vscode.AuthenticationSession>;
	private async getGithubSession(createIfNone: false, forceNewSession?: boolean): Promise<vscode.AuthenticationSession | undefined>;
	private async getGithubSession(createIfNone: boolean, forceNewSession = false): Promise<vscode.AuthenticationSession | undefined> {
		if (forceNewSession) {
			return vscode.authentication.getSession('github', ['repo', 'read:user', 'user:email'], {
				forceNewSession: true,
				clearSessionPreference: true,
			});
		}

		return vscode.authentication.getSession('github', ['repo', 'read:user', 'user:email'], {
			createIfNone,
		});
	}

	private async githubUsername(token: string): Promise<string> {
		const user = await this.githubRequest<{ login?: string }>('/user', token, 'GET');
		if (!user.login) {
			throw new Error('GitHub authentication succeeded, but the username could not be read.');
		}
		return user.login;
	}

	private async createGithubRepository(token: string, repo: string, visibility: 'private' | 'public'): Promise<{ clone_url?: string; full_name?: string; html_url?: string }> {
		const payload = {
			name: repo,
			private: visibility !== 'public',
			auto_init: false,
		};
		try {
			return await this.githubRequest('/user/repos', token, 'POST', payload);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/already_exists|name already exists|422/.test(message)) {
				const owner = await this.githubUsername(token);
				return this.githubRequest(`/repos/${owner}/${repo}`, token, 'GET');
			}
			throw error;
		}
	}

	private async githubRequest<T>(pathName: string, token: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
		const response = await fetch(`https://api.github.com${pathName}`, {
			method,
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				'User-Agent': 'build-by-you-vscode',
				'X-GitHub-Api-Version': '2022-11-28',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		const data = text ? JSON.parse(text) as unknown : {};
		if (!response.ok) {
			const message = typeof data === 'object' && data && 'message' in data
				? String((data as { message?: unknown }).message)
				: text || response.statusText;
			throw new Error(`GitHub API ${response.status}: ${message}`);
		}
		return data as T;
	}

	private parseGithubRepoFromRemote(remoteUrl: string): { owner: string; name: string } | undefined {
		const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
		if (httpsMatch) {
			return { owner: httpsMatch[1], name: httpsMatch[2] };
		}
		const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
		if (sshMatch) {
			return { owner: sshMatch[1], name: sshMatch[2] };
		}
		return undefined;
	}

	private compactResult(fallback: string, result: GitExecResult): string {
		return [fallback, result.stdout.trim(), result.stderr.trim()]
			.filter(Boolean)
			.join('\n');
	}
}
