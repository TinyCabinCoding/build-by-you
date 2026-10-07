import * as vscode from 'vscode';
import { AgentMode, ApprovalRequest, ApprovalResult, ChatMessage, ExtensionConfig, WorkspaceSummary } from '../core/types';
import { GitService } from './gitService';
import { TerminalSessionService } from './terminalSessionService';
import { WorkspaceToolService } from './workspaceToolService';
import { XaiClient } from './xaiClient';
import { redactSecretsForRemote } from '../util/secretScan';
import { ASTRO_MAX_PROMPT } from '../prompts/astroMaxPrompt';

export interface AgentRunOptions {
	client: XaiClient;
	config: ExtensionConfig;
	folder: vscode.WorkspaceFolder;
	history: ChatMessage[];
	userPrompt: string;
	userAttachments?: ChatMessage['attachments'];
	agentMode?: AgentMode;
	forcePlanner?: boolean;
	plannerEffort?: ExtensionConfig['plannerEffort'];
	workspaceSummary: WorkspaceSummary;
	onStatus: (message: string) => void;
	onTextDelta: (text: string) => void;
	onReasoningDelta?: (text: string) => void;
	onEvent: (text: string) => void;
	requestApproval: (details: ApprovalRequest) => Promise<ApprovalResult>;
	terminalSessionService: TerminalSessionService;
	gitService: GitService;
}

interface AgentPassResult {
	finalText: string;
	executedActions: string[];
	unresolvedFailures: string[];
	verified: boolean;
}

interface ImagePreflightAsset {
	prompt: string;
	path?: string;
	error?: string;
}

export class GrokAgentService {
	public async runTurn(options: AgentRunOptions): Promise<string> {
		const agentMode = options.agentMode ?? 'default';
		options.onStatus('Running Grok agent...');

		const tools = new WorkspaceToolService(
			options.folder,
			options.config,
			options.requestApproval,
			options.terminalSessionService,
			options.gitService,
			options.onEvent,
			options.client,
			agentMode,
		);

		// Image preflight is intentionally disabled.
		// Image generation should only happen during the normal agent tool loop when the
		// user explicitly asks for it; normal coding prompts must never start by
		// generating images before workspace tools run.
		const imageContext = '';
		const input: Array<{ role: 'system' | 'user' | 'assistant'; content: string | unknown[] }> = [
			{ role: 'system', content: this.buildExecutorSystemPrompt(options.workspaceSummary, agentMode) },
			...(imageContext ? [{ role: 'system' as const, content: imageContext }] : []),
			...options.history.map((message) => this.toResponseMessage(message)),
			this.toResponseMessage({
				role: 'user',
				text: options.userPrompt,
				attachments: options.userAttachments,
			}),
		];

		const plannerNotes = await this.maybeRunPlannerPass(options, agentMode);
		const plannedInput = plannerNotes
			? [
				input[0],
				{
					role: 'system' as const,
					content: [
						'Multi-agent planner notes for this turn:',
						plannerNotes,
						'Use these notes as strategy only. You remain responsible for inspecting current files, making actual tool calls, verifying results, and reporting uncertainty honestly.',
					].join('\n\n'),
				},
				...input.slice(1),
			]
			: input;

		let result = await this.runAgentPass(options, tools, plannedInput);
		const allActions = [...result.executedActions];
		let finalResult = result;
		const maxContinuationAttempts = agentMode === 'find' || agentMode === 'security' ? 0 : 3;
		for (let attempt = 1; result.unresolvedFailures.length > 0 && attempt <= maxContinuationAttempts; attempt += 1) {
			const failure = result.unresolvedFailures[0];
			options.onEvent(`note: validation failed; continuing agent loop attempt ${attempt}/${maxContinuationAttempts}: ${failure}`);
			options.onStatus(`Self-check found issues. Repair attempt ${attempt}/${maxContinuationAttempts}...`);
			const continuationPrompt = [
				'Continue the same user request. The previous pass stopped before verified completion.',
				'Do not summarize yet. Gather the missing context, take the missing action, verify the result, and only then return a final response.',
				'',
				'Original user request:',
				options.userPrompt,
				'',
				'Unresolved issue to fix:',
				failure,
				'',
				'Previous assistant text:',
				result.finalText || '(no final response)',
				'',
				'Previous local actions:',
				result.executedActions.join('\n') || '(none)',
			].join('\n');
			const continuationInput: Array<{ role: 'system' | 'user' | 'assistant'; content: string | unknown[] }> = [
				{ role: 'system', content: this.buildExecutorSystemPrompt(options.workspaceSummary, agentMode) },
				...(imageContext ? [{ role: 'system' as const, content: imageContext }] : []),
				...options.history.map((message) => this.toResponseMessage(message)),
				{ role: 'user', content: continuationPrompt },
			];
			result = await this.runAgentPass(options, tools, continuationInput);
			allActions.push(...result.executedActions);
			finalResult = result;
		}

		if (finalResult.unresolvedFailures.length > 0) {
			return this.buildFallbackSummary(allActions, finalResult.unresolvedFailures, agentMode);
		}

		return finalResult.finalText || this.buildFallbackSummary(allActions, [], agentMode);
	}

	private async runImagePreflight(options: AgentRunOptions, tools: WorkspaceToolService, agentMode: AgentMode): Promise<ImagePreflightAsset[]> {
		if (agentMode === 'find' || agentMode === 'security') {
			return [];
		}

		const prompts = this.extractImagePreflightPrompts(options.userPrompt, options.history);
		if (prompts.length === 0) {
			return [];
		}

		options.onEvent(`image preflight detected ${prompts.length} requested generated image asset${prompts.length === 1 ? '' : 's'}`);
		const assets: ImagePreflightAsset[] = [];
		for (let index = 0; index < prompts.length; index += 1) {
			const prompt = prompts[index];
			options.onStatus(`Image preflight ${index + 1}/${prompts.length}...`);
			const fileName = `${this.slugForImagePrompt(prompt)}-${Date.now()}-${index + 1}.jpg`;
			let result = await tools.execute('image_build', JSON.stringify({ prompt, fileName }));
			options.onEvent(`tool result: image_build\n${result.output}`);
			if (!result.ok) {
				const retryPrompt = this.shortImagePrompt(prompt);
				if (retryPrompt && retryPrompt !== prompt) {
					options.onEvent(`image preflight retry ${index + 1}/${prompts.length} with shorter prompt`);
					result = await tools.execute('image_build', JSON.stringify({ prompt: retryPrompt, fileName }));
					options.onEvent(`tool result: image_build\n${result.output}`);
				}
			}

			const path = result.ok ? result.output.match(/Image built:\s*([^\s]+)/i)?.[1] : undefined;
			assets.push({
				prompt,
				path,
				error: result.ok ? undefined : result.output,
			});
		}
		return assets;
	}

	private buildImagePreflightContext(assets: ImagePreflightAsset[]): string {
		if (assets.length === 0) {
			return '';
		}

		const created = assets.filter((asset) => asset.path);
		const failed = assets.filter((asset) => !asset.path);
		const incomplete = created.length < assets.length;
		return [
			'Generated image preflight results for this turn:',
			`Requested generated images: ${assets.length}`,
			`Created generated images: ${created.length}`,
			`Failed generated images: ${failed.length}`,
			incomplete ? 'IMAGE PREFLIGHT INCOMPLETE: do not treat partial image success as satisfying the user request.' : 'IMAGE PREFLIGHT COMPLETE.',
			...created.map((asset) => `- ${asset.path} from prompt: ${asset.prompt}`),
			failed.length > 0 ? 'Failed image preflight requests:' : '',
			...failed.map((asset) => `- ${asset.prompt}: ${asset.error ?? 'unknown failure'}`),
			incomplete ? 'Required behavior: retry or report the missing generated images as a blocker. Do not reduce requested scope, card count, pair count, gallery count, or app requirements to match only the images that succeeded.' : '',
			incomplete ? 'Do not replace failed generated images with emoji, SVG, CSS-only fake images, external URLs, or placeholders unless the user explicitly approves that fallback.' : '',
			'Use the generated images in the site/app only when they match the requested scope. For Astro/Vite apps, copy the chosen files into public/images and reference them as /images/...',
		].filter(Boolean).join('\n');
	}

	private extractImagePreflightPrompts(userPrompt: string, history: ChatMessage[] = []): string[] {
		const prompt = userPrompt.trim();
		// Avoid duplicate image preflight on follow-up turns when images were already created
		const historyText = history.map(h => h.text || '').join('\n');
		if (historyText.includes('Generated image preflight results for this turn')) {
			return [];
		}
		if (!this.hasImageGenerationIntent(prompt)) {
			return [];
		}

		const pokemon = this.extractPokemonNames(prompt);
		if (pokemon.length > 0 && /\b(all|each|every|pairs?|cards?)\b/i.test(prompt)) {
			return pokemon.map((name) => `${name} character image for the requested site or game`);
		}

		const count = this.extractRequestedImageCount(prompt);
		const imageSentences = prompt
			.split(/(?<=[.!?])\s+|\n+/u)
			.map((sentence) => sentence.trim())
			.filter((sentence) => /\b(images?|pictures?|photos?|artwork|visuals?|backgrounds?|assets?|illustrations?)\b/i.test(sentence));
		const base = imageSentences.join(' ') || prompt;
		if (count <= 1) {
			return [base];
		}

		return Array.from({ length: count }, (_, index) => `${base} Image ${index + 1} of ${count}.`);
	}

	private isExplicitImageCommand(prompt: string): boolean {
		return /^(\/image|\/img|\/generate-image|image:|generate image:)\b/i.test(prompt.trim());
	}

	private hasImageGenerationIntent(prompt: string): boolean {
		const text = prompt.trim();

		if (!text) {
			return false;
		}

		// Explicit negative requests should never trigger image generation.
		if (/\b(no|don't|do not|without|skip|avoid|disable|stop)\b[^.!?\n]{0,80}\b(generate|create|make|build)?\s*(images?|pictures?|photos?|artwork|visuals?|backgrounds?|assets?|illustrations?)\b/i.test(text)) {
			return false;
		}

		// Command-style image requests always count.
		if (this.isExplicitImageCommand(text)) {
			return true;
		}

		// Natural-language requests that clearly ask the agent to make generated images.
		if (/\b(generate|create|make|build|produce|draw|render)\b[^.!?\n]{0,100}\b(images?|pictures?|photos?|artwork|illustrations?|character images?|background images?|generated assets?)\b/i.test(text)) {
			return true;
		}

		// Follow-up wording like "create them using your image tool" should be allowed.
		if (/\b(use|using|with)\b[^.!?\n]{0,80}\b(image tool|image generator|grok imagine|imagine tool)\b/i.test(text)) {
			return true;
		}

		// "Create all the Pokémon character images" style requests should be allowed.
		if (/\b(create|generate|make|build|produce|draw|render)\b[^.!?\n]{0,120}\b(characters?|pokemon|pokémon|sprites?|portraits?)\b/i.test(text)
			&& /\b(images?|pictures?|photos?|artwork|illustrations?|assets?)\b/i.test(text)) {
			return true;
		}

		return false;
	}

	private extractRequestedImageCount(prompt: string): number {
		const digitMatch = prompt.match(/\b(\d{1,2})\s+(?:\w+\s+){0,4}(?:images?|pictures?|photos?|artwork|visuals?|backgrounds?|assets?|illustrations?)\b/i);
		if (digitMatch) {
			return Math.min(12, Math.max(1, Number(digitMatch[1])));
		}

		const numberWords: Record<string, number> = {
			one: 1,
			two: 2,
			three: 3,
			four: 4,
			five: 5,
			six: 6,
			seven: 7,
			eight: 8,
			nine: 9,
			ten: 10,
			eleven: 11,
			twelve: 12,
		};
		const wordMatch = prompt.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|few|couple)\s+(?:\w+\s+){0,4}(?:images?|pictures?|photos?|artwork|visuals?|backgrounds?|assets?|illustrations?)\b/i);
		if (!wordMatch) {
			return 1;
		}
		const word = wordMatch[1].toLowerCase();
		if (word === 'few') {
			return 3;
		}
		if (word === 'couple') {
			return 2;
		}
		return numberWords[word] ?? 1;
	}

	private extractPokemonNames(prompt: string): string[] {
		const names = ['Pikachu', 'Charizard', 'Bulbasaur', 'Squirtle', 'Charmander', 'Jigglypuff', 'Mewtwo', 'Snorlax'];
		return names.filter((name) => new RegExp(`\\b${name}\\b`, 'i').test(prompt));
	}

	private slugForImagePrompt(prompt: string): string {
		return prompt
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48) || 'generated-image';
	}

	private shortImagePrompt(prompt: string): string {
		return prompt
			.replace(/\b(use|include|make|build|create)\b[^.?!]{80,}/gi, '')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 240);
	}

	private async maybeRunPlannerPass(options: AgentRunOptions, agentMode: AgentMode): Promise<string> {
		if (!options.forcePlanner && !options.config.enablePlanner) {
			return '';
		}

		const effort = options.plannerEffort ?? options.config.plannerEffort;
		options.onStatus('Running Grok multi-agent planner...');
		options.onEvent(`planner started: ${options.config.plannerModel} (${effort})`);

		try {
			const response = await options.client.createResponse({
				model: options.config.plannerModel,
				reasoning: { effort },
				tool_choice: 'none',
				input: [
					{
						role: 'system',
						content: [
							'You are the Build by You multi-agent planning council.',
							'Do not claim files were edited, commands were run, or previews were verified. You have no tools in this pass.',
							'Analyze the request, current workspace summary, likely failure modes, and a practical execution strategy for the main coding agent.',
							'Return concise notes with: goal, key files or commands to inspect, likely fix/build path, verification steps, and risks.',
							'If the request is ambiguous, state the ambiguity instead of inventing facts.',
						].join('\n'),
					},
					{
						role: 'user',
						content: [
							`Agent mode: ${agentMode}`,
							`Workspace: ${options.workspaceSummary.label}`,
							`Workspace root: ${options.workspaceSummary.rootPath}`,
							`Active file: ${options.workspaceSummary.activeFile ?? 'none'}`,
							'Top-level entries:',
							options.workspaceSummary.topLevelEntries.join('\n') || 'none',
							'Key file previews:',
							options.workspaceSummary.keyFiles
								.map((file) => `--- ${file.path} ---\n${file.preview}`)
								.join('\n\n') || 'none',
							'User request:',
							options.userPrompt,
						].join('\n\n'),
					},
				],
			});
			const plannerText = options.client.extractText(response).trim();
			if (!plannerText) {
				options.onEvent('planner returned no text; continuing with direct executor');
				return '';
			}
			options.onEvent(`planner result:\n${this.truncateForPlannerEvent(plannerText)}`);
			return plannerText;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.onEvent(`planner failed: ${message}`);
			if (options.forcePlanner) {
				return [
					`Planner failed before execution: ${message}`,
					'Proceed carefully with direct execution, and explicitly report the planner failure in the final answer if it affects confidence.',
				].join('\n');
			}
			return '';
		}
	}

	private async runAgentPass(
		options: AgentRunOptions,
		tools: WorkspaceToolService,
		input: Array<{ role: 'system' | 'user' | 'assistant'; content: string | unknown[] }>,
	): Promise<AgentPassResult> {
		let continuationInput: unknown[] = input;
		const executedActions: string[] = [];
		const currentPassFailures: string[] = [];
		let sawVerificationAfterFailure = false;
		let sawAnyVerification = false;
		let streamedText = '';

		let response = await options.client.streamResponse({
			model: options.config.executorModel,
			input,
			tools: tools.getToolDefinitions(),
			tool_choice: 'auto',
		}, {
			onTextDelta: (delta) => {
				streamedText += delta;
				options.onTextDelta(delta);
			},
			onReasoningDelta: (delta) => options.onReasoningDelta?.(delta),
			onFunctionCall: (call) => {
				if (call.name.trim()) {
					options.onEvent(`tool requested: ${call.name}`);
				}
			},
		});

		let loopCount = 0;
		while (loopCount < 12) {
			const calls = (response.output ?? []).filter((item) => item.type === 'function_call' && item.name?.trim());
			if (calls.length === 0) {
				break;
			}

			loopCount += 1;
			options.onStatus(`Executing ${calls.length} local tool call${calls.length === 1 ? '' : 's'}...`);
			const toolOutputs = [];
			for (const call of calls) {
				const result = await tools.execute(call.name ?? '', call.arguments ?? '{}');
				options.onStatus(`Tool: ${call.name}`);
				options.onEvent(`tool result: ${call.name}\n${result.output}`);
				executedActions.push(`${call.name}: ${this.summarizeToolResult(result.output, call.name ?? '')}`);
				const failure = this.detectToolFailure(call.name ?? '', result.ok, result.output);
				if (failure) {
					currentPassFailures.push(failure);
					sawVerificationAfterFailure = false;
				} else if (this.isVerificationToolResult(call.name ?? '', result.ok, result.output)) {
					sawAnyVerification = true;
					if (currentPassFailures.length > 0) {
						sawVerificationAfterFailure = true;
					}
				}
				toolOutputs.push({
					type: 'function_call_output',
					call_id: call.call_id,
					output: JSON.stringify({
						ok: result.ok,
						output: result.output,
					}),
				});
			}

			response = await options.client.streamResponse({
				model: options.config.executorModel,
				input: response.id.startsWith('local-stream-')
					? [...continuationInput, ...toolOutputs]
					: toolOutputs,
				tools: tools.getToolDefinitions(),
				tool_choice: 'auto',
				previous_response_id: response.id.startsWith('local-stream-') ? undefined : response.id,
			}, {
				onTextDelta: (delta) => {
					streamedText += delta;
					options.onTextDelta(delta);
				},
				onReasoningDelta: (delta) => options.onReasoningDelta?.(delta),
				onFunctionCall: (call) => {
					if (call.name.trim()) {
						options.onEvent(`tool requested: ${call.name}`);
					}
				},
			});
			continuationInput = [...continuationInput, ...toolOutputs];
		}

		let finalText = options.client.extractText(response);
		if (!finalText.trim() && streamedText.trim()) {
			finalText = streamedText.trim();
		}

		if (!finalText.trim() && response.id && !response.id.startsWith('local-stream-')) {
			finalText = await this.requestFinalSummary(options, response.id, options.agentMode ?? 'default', executedActions);
		}
		const unresolvedFailures = this.unresolvedFailuresForPass(currentPassFailures, sawVerificationAfterFailure);
		const incompletePassFailure = this.incompleteMutatingPassFailure(options.userPrompt, finalText, executedActions, sawAnyVerification);
		if (incompletePassFailure) {
			unresolvedFailures.push(incompletePassFailure);
		}

		return {
			finalText,
			executedActions,
			unresolvedFailures,
			verified: sawAnyVerification,
		};
	}

	private buildExecutorSystemPrompt(workspaceSummary: WorkspaceSummary, agentMode: AgentMode): string {
		const role = agentMode === 'security'
			? 'You are Build by You Security Auditor.'
			: agentMode === 'slide'
				? 'You are Build by You Slide Deck Builder.'
				: agentMode === 'python'
					? 'You are Build by You Python Coding Agent.'
					: agentMode === 'astro'
						? 'You are AstroMax, Build by You Astro Specialist.'
						: agentMode === 'find'
							? 'You are Build by You Find Agent.'
							: 'You are Build by You, a coding agent running inside VS Code.';

		if (agentMode === 'slide') {
			return [
				role,
				'Operate only inside the selected workspace folder.',
				'Use the large file-read context window. Before editing a normal source/page/config file, read the full relevant file when practical instead of assuming it is too long.',
				'Follow the user request directly and make the requested deck change.',
				'For a new or empty deck workspace, create the Slidev project files directly. Do not run interactive scaffolders such as `npm create slidev`, `npm init slidev`, `create-slidev`, or any command that can stop for package name/theme prompts.',
				'Minimum new Slidev project files: `package.json`, `slides.md`, and any requested local assets. `package.json` must include scripts `dev: "slidev"` and `build: "slidev build"`, devDependencies `@slidev/cli`, `@slidev/theme-default`, and `playwright-chromium`, and a safe kebab-case package name derived from the workspace folder if one is needed.',
				'After writing a new Slidev `package.json`, run `npm install` once, then run `npm run build` to verify. Use the extension Start Server button or `npm run dev` for preview.',
				'For edit requests, inspect the current deck file first, then edit the relevant slide or style block.',
				'Prefer changing existing Slidev markdown/frontmatter/CSS over adding new explanatory text to the slide.',
				'Never leave the terminal waiting for an interactive answer. If a command prompts, stop it and switch to direct file creation/editing.',
				'Do not claim a rendered slide was visually verified unless the user supplied a screenshot or tool results prove the rendered behavior directly.',
				'After editing, briefly say exactly which file and slide/section changed.',
				'',
				'Examples:',
				'- User: "/sd Change page 1 text to dark grey" -> Read slides.md, find the first slide content or its style, change the rendered text color/class/CSS. Do not write the instruction text onto the slide.',
				'- User: "/sd The background image disappeared when I removed the # heading" -> Inspect slides.md and explain/fix the markdown/frontmatter structure. In Slidev, lines without # are paragraphs, while # creates a heading; changing that can affect theme layout/CSS but should not remove valid frontmatter background.',
				'- User: "/sd Check the repo structure" -> List files, read package.json and slides.md, then report concrete structure findings with file paths.',
				'',
				`Selected workspace: ${workspaceSummary.label}`,
				`Workspace root: ${workspaceSummary.rootPath}`,
				`Active file: ${workspaceSummary.activeFile ?? 'none'}`,
			].join('\n');
		}

		if (agentMode === 'python') {
			return [
				role,
				'Master Prompt:',
				'You are Build by You Python Lab Agent: an expert scientific Python developer, debugger, and lab instructor helping young scientists and students build professional, reproducible Python projects.',
				'',
				'Mission:',
				'- Create, fix, run, and explain Python scripts for lab portfolios, data generation, data analysis, plotting, simulations, automation, and beginner-friendly scientific computing.',
				'- Do the actual workspace work with tools. Write files, update dependency files, run checks, repair failures, and verify outputs whenever the user asks you to build or fix something.',
				'- Keep the user experience simple: beginner-friendly code, professional structure, short final summaries, and self-repair before asking the user to intervene.',
				'- Before installing or writing any third-party package dependency, use real-time web lookup when available to confirm the current latest stable package/version, then choose a version compatible with the active Python version and project goal.',
				'- If the prompt names a package, library, framework, or dependency, check current package information first before deciding what to install or write into dependency files.',
				'',
				'Agentic loop:',
				'- Work in this loop: gather context -> take action -> verify result -> if verification fails, gather the new failure context and try the next fix.',
				'- Repeat the repair loop at least 3 times when the next fix is clear and execution mode allows it.',
				'- Prefer fixing the blocker yourself over reporting it. For installs, if one install path fails, determine why, adjust dependency versions or environment strategy, and try again.',
				'- Only stop with a blocker when the fix requires external user/system action you cannot perform from the workspace, or after repeated repair attempts fail.',
				'- When stopping, include the failed attempts, the root cause you found, and the exact command or system package the user needs.',
				'',
				'Coding standards:',
				'- Produce clean, readable, well-commented Python with clear section comments.',
				'- Use modern Python practices: `pathlib.Path`, context managers, functions with `main()`, useful type hints, constants for configuration, and `if __name__ == "__main__": main()`.',
				'- Prioritize reproducibility: fixed seeds for random data, deterministic output paths, and dependency versions compatible with the active Python version.',
				'- For new lab-style projects, prefer a simple data-science structure when useful: `data/raw`, `data/processed`, `scripts`, `results/plots`, `results/reports`. If an existing project structure is already present, follow it instead of creating duplicate folders.',
				'- For scientific scripts, prefer numpy and pandas for data, matplotlib and seaborn for plots, scipy/statsmodels/sympy when analysis requires them.',
				'- Add realistic noise to synthetic experimental data when appropriate, but keep the model and assumptions easy for students to understand.',
				'- Include a short "How to run" comment at the top of runnable scripts and print useful status messages.',
				'',
				'Workspace and path rules:',
				'Operate only inside the selected workspace folder.',
				'Use the large file-read context window. Before editing a normal Python/source/config file, read the full relevant file when practical instead of assuming it is too long.',
				'Before creating files, identify the intended project root from the user request and existing folders.',
				'If the workspace contains a single existing project folder and the user refers to folders like `scripts/`, `data/`, `results/`, or `../requirements.txt`, resolve those paths inside that project folder unless the user explicitly says workspace root.',
				'If the user gives a relative path such as `../requirements.txt`, resolve it relative to the target script path, not relative to the VS Code workspace root.',
				'Prefer existing matching folders over creating new top-level duplicates.',
				'Follow the user-requested file and folder paths exactly. Do not invent extra parent folders or duplicate the workspace folder in shell commands.',
				'Use commands from the selected workspace root unless a specific file path requires changing directories.',
				'Use `python3`, not `python`, unless the repository clearly configures a different Python command.',
				'',
				'Dependency and environment rules:',
				'- Before pinning scientific dependencies, check the active Python version when practical.',
				'- Generate or update dependency files with current stable versions when appropriate, while keeping compatibility with the active Python version and the project goal.',
				'- For new lab projects that import third-party packages, create or update `requirements.txt` unless the repo already uses `pyproject.toml`. Do this before the final run; do not wait for the user to ask separately.',
				'- If the user asks for `../requirements.txt` from a script in `scripts/`, that means the project-root `requirements.txt`. If no dependency file exists and the script imports third-party packages, create it in the intended project root.',
				'- If the user explicitly lists imports such as numpy, pandas, matplotlib, seaborn, scipy, statsmodels, sympy, or scikit-learn, treat that as permission to add those packages to the dependency file and install them when execution mode allows commands.',
				'- Prefer compatible lower bounds over restrictive old pins. For Python 3.13+, do not pin NumPy below 2.0; prefer NumPy 2.x-compatible dependency ranges.',
				'- Prefer a project-local `.venv` for installs and runtime verification. Install dependencies through the `.venv` Python and run scripts through that same `.venv` Python.',
				'- A missing import is not a final blocker by itself. If a script fails with `ModuleNotFoundError`, first create/update the dependency file, install through `.venv` when allowed, and rerun the script. Only report a blocker after that repair path fails.',
				'- If `venv`, `pip`, Python headers, or wheel availability blocks installation, do not stop immediately. Diagnose why, try a practical alternate install/dependency strategy when safe, and rerun verification.',
				'- If pip attempts a source build and fails, first consider whether the dependency version is incompatible with the active Python version. Adjust the dependency range to a wheel-compatible version when appropriate, then retry if allowed. If that still fails, identify the system package or Python version needed.',
				'',
				'Verification rules:',
				'- `py_compile` is only a syntax check. Runtime verification means the script actually runs with its imports available.',
				'- After creating or editing Python code, run a syntax check when practical, then run the requested script when safe. If dependencies are required, run it with the `.venv` Python after installing them.',
				'- If the user requested a generated file such as a CSV, plot, report, or HTML dashboard, success requires verifying that output file exists after runtime execution. Syntax-only verification is not enough.',
				'- If a runtime command fails before producing the requested output, do not replace runtime verification with `py_compile`. Fix dependencies or code, rerun the script, then check the output file.',
				'- If the script writes files, verify those files exist. For CSV/data outputs, check row count or preview a few lines. For plots, verify the image exists and is non-empty.',
				'- If a command fails, inspect the error, fix the code or dependency issue, and rerun. Do not stop at the first failure if the fix is clear and execution mode allows it.',
				'- Never say "done", "success", or "verified" unless tool results confirm the code, dependencies, script run, and requested outputs are actually working.',
				'',
				'Response rules:',
				'- Do not paste full source code into chat after writing the file unless the user explicitly asks to see the code.',
				'- Final response should be concise: changed files, commands/checks run, outputs created, and any remaining blocker.',
				'- If finally blocked after repair attempts, say exactly what failed, what you tried, why it still cannot continue, and what needs to be installed or changed locally.',
				'',
				`Selected workspace: ${workspaceSummary.label}`,
				`Workspace root: ${workspaceSummary.rootPath}`,
				`Active file: ${workspaceSummary.activeFile ?? 'none'}`,
			].join('\n');
		}

		if (agentMode === 'astro') {
			return [
				ASTRO_MAX_PROMPT,
				'',
				'Build by You Astro rail execution rules:',
				'Operate only inside the selected workspace folder.',
				'Use the large file-read context window. Before editing a normal Astro/source/page/config file, read the full relevant file when practical instead of assuming it is too long.',
				'Work in this loop: gather context -> take action -> verify result -> if verification fails, gather the failure context and repair it -> verify again.',
				'Do not stop in the middle of that loop. If you have written files, run the relevant build/check command and repair clear failures before final response.',
				'For a new or empty Astro workspace, scaffold immediately and non-interactively with the current Astro CLI basics template unless the user requested a different Astro starter. Do not stop after listing an empty folder.',
				'Preferred scaffold command: `npm create astro@latest . --yes -- --template basics --yes`, then continue editing files.',
				'For Tailwind in Astro, prefer the current official Astro integration path (`npx astro add tailwind --yes`) when it works. If it prompts, fails, or times out, switch to direct package/config edits and verify.',
				'Always ensure styling is wired correctly: import the global CSS from the shared layout, confirm Tailwind/global styles are reachable by every page, and fix broken CSS routes such as `/styles/global.css` being requested directly from the browser.',
				'Disable the Astro dev toolbar for generated preview/build projects by setting `devToolbar: { enabled: false }` in `astro.config.mjs` unless the user explicitly asks to keep it.',
				'Never leave the terminal waiting for an interactive prompt. If a command prompts for package name, install confirmation, template, theme, or start-now, stop using that path and make the files directly.',
				'If adding UI framework islands, only add React/Vue/Svelte/etc. when the requested interactivity needs it. Prefer Astro + vanilla script for simple modals, toggles, timelines, and galleries.',
				'After every `write_file` or `replace_in_file`, inspect the tool result for the verified write/read-back and diff summary. If the tool reports unchanged content, a hash mismatch, or no expected diff, re-read the target file and repair before claiming the edit succeeded.',
				'After editing, run `npm run build` when package scripts exist. If build fails, fix the Astro/component/CSS/TypeScript error and rerun before reporting completion.',
				'If your last thought is "Run build to verify", you are not done. Call the build command, inspect the result, and repair any failures before writing the final response.',
				'If a dev server or preview shows a runtime error in user-provided output, treat that as failed verification even if `npm run build` passed.',
				'Do not claim rendered UI, click handlers, modals, images, or responsive layout were visually verified unless a user screenshot or tool result proves it. If only code/build was verified, say that plainly.',
				'Final response should be concise: changed files, verification command(s), and any remaining blocker.',
				'',
				`Selected workspace: ${workspaceSummary.label}`,
				`Workspace root: ${workspaceSummary.rootPath}`,
				`Active file: ${workspaceSummary.activeFile ?? 'none'}`,
			].join('\n');
		}

		if (agentMode === 'find') {
			return [
				role,
				'Operate only inside the selected workspace folder.',
				'You are in read-only find mode. Your job is to locate where something exists in the repo and report the best file path and line numbers.',
				'Do not edit files. Do not generate images. Do not run shell commands. Do not start servers. Do not propose broad rebuilds.',
				'Use only file listing, text search, and targeted file reads.',
				'First, inspect README-style files when present (`README.md`, `README.txt`, `readme.md`, docs overview files, or similar) to understand what kind of system this repo is before searching broadly.',
				'Then search exact phrases from the user prompt, followed by useful variants, synonyms, and likely implementation terms.',
				'Search user wording as general intent, not literal-only text. Pull useful keywords from the prompt and search several variants.',
				'Use broad searches when exact phrases fail. The search tool ranks natural-language keyword matches, path/name matches, exact matches, and partial matches.',
				'When multiple files could contain the answer, return the most likely candidates ranked by confidence instead of continuing indefinitely.',
				'For copy/content requests, search both visible text and likely code terms such as subject, body, message, email, template, admin, invite, download, link, user, send, mail, and notification when relevant.',
				'For UI location requests, search component names, labels, headings, button text, route names, and nearby domain terms.',
				'After about 8-12 useful search/read steps, stop and report the best match, likely matches, or no exact match with searched terms.',
				'Prefer concrete evidence over guesses. A valid answer needs a file path and relevant line number or clearly labeled likely match.',
				'If you cannot find an exact match, say so plainly and list what you searched plus the most likely next places.',
				'Always return a final answer. Do not stop after only searching.',
				'',
				'Output format:',
				'- Start with `Found it.`, `Likely match.`, or `I could not find an exact match.`',
				'- Include file path(s), line number(s), why it matches, and what copy/code the user should edit.',
				'- Keep the answer concise and actionable.',
				'',
				`Selected workspace: ${workspaceSummary.label}`,
				`Workspace root: ${workspaceSummary.rootPath}`,
				`Active file: ${workspaceSummary.activeFile ?? 'none'}`,
			].join('\n');
		}

		const modeLine = agentMode === 'security'
			? 'Inspect the workspace and report security findings. Do not edit files.'
			: 'Follow the user request directly. Use tools to inspect, edit, and verify the workspace when needed.';

		const guidance = agentMode === 'security' ? [] : [
			'Work in this loop: gather context -> take action -> verify result -> if verification fails, gather the failure context and repair it -> verify again.',
			'For build/site/app work, run the relevant build/check command after edits when one exists. If a dev server or build output reports a runtime error, fix it and rerun the relevant check before summarizing success.',
			'For visual UI bugs, layout bugs, click/interaction bugs, missing images, missing modals/popups, or screenshot-driven reports, inspect the relevant markup/CSS/JS path carefully, fix structurally, and use practical checks such as build output, dev-server errors, source checks, and user-provided screenshots. If you only verified code/build, say that plainly.',
			'For repeated UI complaints, change strategy instead of repeating the same tiny edit.',
			'Repeat the repair loop up to 3 times when the next fix is clear and execution mode allows it.',
			'Only stop with a blocker when the fix requires external user/system action you cannot perform from the workspace, or after repeated repair attempts fail.',
			'If `replace_in_file` reports that search text was not found, do not retry the same brittle replacement. Re-read the current file and use `write_file` or an exact replacement based on the current file contents.',
			'After every `write_file` or `replace_in_file`, inspect the tool result for the verified write/read-back and diff summary. If the tool reports unchanged content, a hash mismatch, or no expected diff, re-read the target file and repair before claiming the edit succeeded.',
			'Do not treat `Wrote` or `Updated` alone as proof. The edit is only proven when the tool result confirms disk content matches and the file differs from the previous content, or when the requested operation intentionally leaves it unchanged.',
			'Call `image_build` only when the user clearly asks to generate/create/make/render actual images, pictures, photos, artwork, illustrations, character images, or generated assets, or when the prompt starts with `/image`, `/img`, `/generate-image`, `image:`, or `generate image:`. Do not call `image_build` for incidental coding mentions like fixing image loading, adding an image section, checking an images folder, using existing assets, cards, counts, placeholders, logos in text, or visual layout work unless the user clearly asks to generate new image files.',
			'Do not create SVG/image substitutes, emoji substitutes, CSS-only fake images, or placeholder image URLs unless the user explicitly asks for SVG/vector/code-native art or placeholders.',
			'For React/Vite/Tailwind builds, remember Tailwind CSS v4 moved the PostCSS plugin to `@tailwindcss/postcss`. If Vite/PostCSS says `tailwindcss` cannot be used directly as a PostCSS plugin, install `@tailwindcss/postcss`, rewrite `postcss.config.*` to use `"@tailwindcss/postcss": {}`, then rerun `npm run build` or the failing dev command.',
			'When `npm run build` reports TypeScript errors, fix every listed TS error, rerun `npm run build`, and only then start or report a dev server.',
			'For new app/site work in an empty workspace, prefer direct project file creation or fully non-interactive commands. Do not leave terminal commands waiting for package names, install prompts, theme prompts, or "start now" prompts.',
			'If the user asks for an Astro site in an empty workspace, immediately create the Astro project non-interactively with the basics template, then continue editing files. Do not stop after listing an empty folder.',
			'If a scaffold command prompts interactively or times out, stop using that path, create or edit the required files directly, then continue the task.',
		];

		return [
			role,
			'Operate only inside the selected workspace folder.',
			'Use the large file-read context window. Before editing a normal source/page/config file, read the full relevant file when practical instead of assuming it is too long.',
			modeLine,
			...guidance,
			'Keep responses concise and grounded in the tool results.',
			'',
			`Selected workspace: ${workspaceSummary.label}`,
			`Workspace root: ${workspaceSummary.rootPath}`,
			`Active file: ${workspaceSummary.activeFile ?? 'none'}`,
		].join('\n');
	}

	private async requestFinalSummary(options: AgentRunOptions, previousResponseId: string, agentMode: AgentMode, executedActions: string[]): Promise<string> {
		try {
			const summaryResponse = await options.client.createResponse({
				model: options.config.executorModel,
				previous_response_id: previousResponseId,
				tool_choice: 'none',
				input: [
					{
						role: 'user',
						content: agentMode === 'security'
							? 'Summarize the security audit result for the user.'
							: agentMode === 'find'
								? 'Write the final find result now. Use Found it, Likely match, or I could not find an exact match. Include file paths, line numbers when available, why they match, searched terms, and likely next places. Do not claim edits or command verification.'
								: 'Summarize what changed and what was checked. If any tool output showed an unfixed build/runtime error, say the result is blocked or failed, not completed.',
					},
				],
			});

			const summaryText = options.client.extractText(summaryResponse);
			if (summaryText.trim()) {
				return summaryText;
			}
		} catch {
			// Fall through to the local fallback.
		}

		return this.buildFallbackSummary(executedActions, [], agentMode);
	}

	private buildFallbackSummary(executedActions: string[], unresolvedFailures: string[] = [], agentMode: AgentMode = 'default'): string {
		if (agentMode === 'find') {
			return this.buildFindFallbackSummary(executedActions);
		}
		if (executedActions.length === 0) {
			return unresolvedFailures.length > 0
				? `Stopped before completion. Unresolved issue:\n${unresolvedFailures[0]}`
				: 'Turn ended without a model final response. No local actions were captured.';
		}

		const changed = executedActions
			.map((action) => action.match(/\b(?:Wrote|Updated|Deleted)\s+([^.;\n]+)/i)?.[1]?.trim())
			.filter((value): value is string => Boolean(value));
		const commands = executedActions
			.map((action) => action.match(/^run_command:\s*command:\s*([^.\n]+)/i)?.[1]?.trim())
			.filter((value): value is string => Boolean(value));
		if (unresolvedFailures.length > 0) {
			return [
				'Turn ended before verified completion.',
				changed.length > 0 ? `Changed: ${[...new Set(changed)].slice(0, 10).join('; ')}.` : '',
				commands.length > 0 ? `Commands: ${[...new Set(commands)].slice(0, 6).join('; ')}.` : '',
				'Unresolved issue:',
				unresolvedFailures[0],
				unresolvedFailures.length > 1 ? `Additional unresolved signals: ${unresolvedFailures.length - 1}.` : '',
			].filter(Boolean).join('\n');
		}
		return [
			'Turn ended without a model final response.',
			changed.length > 0 ? `Changed: ${[...new Set(changed)].slice(0, 10).join('; ')}.` : '',
			commands.length > 0 ? `Commands: ${[...new Set(commands)].slice(0, 6).join('; ')}.` : '',
			changed.length === 0 && commands.length === 0 ? `Inspected ${executedActions.length} workspace step${executedActions.length === 1 ? '' : 's'}.` : '',
			executedActions.length > 12 ? `- ...${executedActions.length - 12} more` : '',
		].filter(Boolean).join('\n');
	}

	private buildFindFallbackSummary(executedActions: string[]): string {
		if (executedActions.length === 0) {
			return 'I could not complete the find request. No files were searched or read.';
		}

		const searchActions = executedActions.filter((action) => /^search_text:/i.test(action));
		const readActions = executedActions.filter((action) => /^read_file:/i.test(action));
		const listActions = executedActions.filter((action) => /^list_files:/i.test(action));
		const positiveSearches = searchActions.filter((action) => !/\bNo matches found\b/i.test(action));
		const candidatePaths = new Set<string>();
		for (const action of positiveSearches) {
			for (const match of action.matchAll(/\b([A-Za-z0-9_.@/\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|html|css|sql|toml|yml|yaml|astro|vue|svelte|py|go|rs|php))(?::\d+)?/g)) {
				candidatePaths.add(match[1]);
			}
		}

		if (candidatePaths.size > 0) {
			return [
				'Likely match.',
				'The model stopped before writing a final answer, but the find rail found candidate files.',
				'',
				'Candidate files:',
				...[...candidatePaths].slice(0, 8).map((file) => `- ${file}`),
				'',
				'Next step: run `/find` again with one of those file names or a narrower phrase to get exact lines.',
			].join('\n');
		}

		return [
			'I could not find an exact match.',
			`Searched/read workspace context with ${executedActions.length} step${executedActions.length === 1 ? '' : 's'}.`,
			searchActions.length > 0 ? `Searches attempted: ${searchActions.length}` : '',
			readActions.length > 0 ? `Files read: ${readActions.length}` : '',
			listActions.length > 0 ? `File listings: ${listActions.length}` : '',
			'',
			'Try a narrower `/find` prompt with one or two key phrases, or include a word you remember from the exact copy.',
		].filter(Boolean).join('\n');
	}

	private unresolvedFailuresForPass(failures: string[], sawVerificationAfterFailure: boolean): string[] {
		const hardFailures = failures.filter((failure) => this.isHardRequirementFailure(failure));
		if (hardFailures.length > 0) {
			return this.prioritizeFailures(hardFailures).slice(0, 5);
		}
		if (sawVerificationAfterFailure || failures.length === 0) {
			return [];
		}
		return this.prioritizeFailures(failures).slice(0, 5);
	}

	private isHardRequirementFailure(failure: string): boolean {
		return /^image_build failed:/i.test(failure)
			|| /^image_build:/i.test(failure) && /\b(failed|error|500|unavailable|request failed)\b/i.test(failure)
			|| /\brequested generated image\/assets\b/i.test(failure);
	}

	private incompleteMutatingPassFailure(userPrompt: string, finalText: string, executedActions: string[], sawAnyVerification: boolean): string {
		const promptLooksLikeBuild = /\b(build|create|make|site|app|website|astro|react|vite|html|page|project|fix|repair|update|edit|write)\b/i.test(userPrompt);
		if (!promptLooksLikeBuild) {
			return '';
		}

		const madeWorkspaceChanges = executedActions.some((action) => /\b(Wrote|Updated|Deleted|cp |mkdir|npm create|astro add|install)\b/i.test(action));
		const onlyInspected = executedActions.length === 0 || executedActions.every((action) => /^(read_file|list_files|search_text|inspect_media_file):/i.test(action));
		const fallbackOnlySummary = /\b(Turn ended without a model final response|Inspected \d+ workspace step|No local actions were captured)\b/i.test(finalText);
		if (madeWorkspaceChanges) {
			if (sawAnyVerification) {
				return '';
			}

			if (!finalText.trim()) {
				return 'The agent stopped after making workspace changes but did not return a final response or run a verification command. Continue the gather -> action -> verify loop, inspect the current files, finish the requested build, and run the relevant verification command such as `npm run build`.';
			}

			return 'The agent made workspace changes for a build/edit request but did not run a verification command. Continue the gather -> action -> verify loop and run the relevant build/check command before reporting completion.';
		}

		if (onlyInspected && (!finalText.trim() || fallbackOnlySummary)) {
			return 'The agent only gathered context for an edit/build/fix request and stopped without taking action. Continue the gather -> action -> verify loop: make the requested change or state a concrete blocker, then run the relevant check if one exists.';
		}

		return '';
	}

	private prioritizeFailures(failures: string[]): string[] {
		const seen = new Set<string>();
		return failures
			.filter((failure) => {
				const key = failure.trim();
				if (!key || seen.has(key)) {
					return false;
				}
				seen.add(key);
				return true;
			})
			.sort((a, b) => this.failurePriority(a) - this.failurePriority(b));
	}

	private failurePriority(failure: string): number {
		const lowered = failure.toLowerCase();
		if (lowered.includes('tailwindcss') || lowered.includes('postcss') || lowered.includes('vite:css') || lowered.includes('@tailwindcss/postcss')) {
			return 0;
		}
		if (/\bts\d{4}\b/i.test(failure) || lowered.includes('cannot find module') || lowered.includes('referenceerror') || lowered.includes('syntaxerror') || lowered.includes('typeerror')) {
			return 1;
		}
		if (lowered.includes('modulenotfounderror') || lowered.includes('command not found')) {
			return 2;
		}
		if (lowered.startsWith('run_command')) {
			return 3;
		}
		if (lowered.startsWith('replace_in_file')) {
			return 8;
		}
		return 5;
	}

	private detectToolFailure(toolName: string, ok: boolean, output: string): string {
		const compact = output.replace(/\s+/g, ' ').trim();
		if (!ok) {
			return `${toolName} failed: ${compact.slice(0, 1200) || 'Tool returned failure.'}`;
		}

		if (toolName !== 'run_command') {
			return '';
		}

		const failurePatterns = [
			/\bReferenceError\b/i,
			/\bTypeError\b/i,
			/\bSyntaxError\b/i,
			/\bModuleNotFoundError\b/i,
			/\bCannot find module\b/i,
			/\bmodule not found\b/i,
			/\bcommand not found\b/i,
			/\bError:\s+/i,
			/\[ERROR\]/i,
			/\bfailed\b/i,
			/\bexited with code\s+(?!0\b)\d+/i,
			/\bTS\d{4}\b/i,
			/\bvite:css\b/i,
			/trying to use [`']?tailwindcss[`']? directly as a PostCSS plugin/i,
			/PostCSS plugin has moved to a separate package/i,
			/@tailwindcss\/postcss/i,
		];
		if (failurePatterns.some((pattern) => pattern.test(output))) {
			return `run_command reported an error: ${compact.slice(0, 1200)}`;
		}
		return '';
	}

	private isVerificationToolResult(toolName: string, ok: boolean, output: string): boolean {
		if (!ok) {
			return false;
		}
		if (toolName !== 'run_command') {
			return false;
		}
		if (this.detectToolFailure(toolName, ok, output)) {
			return false;
		}
		return /\b(npm run build|npm run lint|npm run test|npm run compile|astro build|vite build|tsc|pytest|python3?\s+.+\.py|py_compile)\b/i.test(output)
			|| /\b(compiled successfully|build completed|built in|passed|successfully generated|saved to:)\b/i.test(output);
	}

	private summarizeToolResult(output: string, toolName = ''): string {
		const compact = output.replace(/\s+/g, ' ').trim();
		if (!compact) {
			return 'completed';
		}


		return compact.slice(0, 160);
	}

	private truncateForPlannerEvent(text: string): string {
		const normalized = text.trim();
		return normalized.length > 6000 ? `${normalized.slice(0, 6000)}\n...planner output truncated for chat log...` : normalized;
	}

	private toResponseMessage(message: ChatMessage): { role: 'user' | 'assistant' | 'system'; content: string | unknown[] } {
		const safeText = redactSecretsForRemote(message.text).redactedText;
		if (message.role !== 'user' || !message.attachments || message.attachments.length === 0) {
			return { role: message.role, content: safeText };
		}

		const content: unknown[] = message.attachments.map((attachment) => ({
			type: 'input_image',
			image_url: attachment.dataUrl,
		}));
		if (message.text.trim()) {
			content.push({
				type: 'input_text',
				text: safeText,
			});
		}

		return {
			role: 'user',
			content,
		};
	}
}
