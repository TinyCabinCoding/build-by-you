import * as vscode from 'vscode';

export interface ChatImageAttachment {
	name: string;
	mimeType: string;
	dataUrl: string;
}

export interface ChatTraceRecord {
	text: string;
	elapsedMs?: number;
	tokenCount?: number;
	stepCount?: number;
}

export interface ChatMessage {
	role: 'user' | 'assistant';
	text: string;
	attachments?: ChatImageAttachment[];
	trace?: ChatTraceRecord;
}

export type ExecutionMode = 'verify' | 'autonomous';
export type WorkflowMode = 'verify' | 'repair' | 'security';
export type WorkflowStatus = 'idle' | 'running' | 'passed' | 'failed';
export type AutonomousCommandPolicy = 'safeOnly' | 'all';
export type AgentMode = 'default' | 'security' | 'slide' | 'python' | 'find' | 'astro';

export interface ExtensionConfig {
	baseUrl: string;
	executorModel: string;
	enablePlanner: boolean;
	plannerModel: string;
	imageModel: string;
	plannerEffort: 'low' | 'medium' | 'high' | 'xhigh';
	commandTimeoutMs: number;
	maxRepairIterations: number;
	maxToolOutputChars: number;
	requireApprovalForFileWrites: boolean;
	requireApprovalForCommands: boolean;
	autonomousCommandPolicy: AutonomousCommandPolicy;
	autonomousAllowedCommands: string[];
	safeCommandPrefixes: string[];
	blockedCommandPatterns: string[];
	autoStageApprovedChanges: boolean;
	persistSensitiveHistory: boolean;
	taskPresets: TaskPreset[];
}

export interface WorkspaceSummary {
	label: string;
	rootPath: string;
	workspaceCount: number;
	activeFile?: string;
	topLevelEntries: string[];
	keyFiles: Array<{
		path: string;
		preview: string;
	}>;
}

export interface ChatSessionState {
	selectedWorkspace?: vscode.Uri;
	messages: ChatMessage[];
	recentPrompts: string[];
	executionMode: ExecutionMode;
	lastWorkflow?: LastWorkflowState;
}

export interface RecentConversationRecord {
	id: string;
	title: string;
	workspaceLabel: string;
	workspaceUri?: string;
	workspacePath?: string;
	updatedAt: string;
	messages: ChatMessage[];
}

export interface PersistedChatSessionState {
	selectedWorkspace?: string;
	messages: ChatMessage[];
	recentPrompts?: string[];
	executionMode?: ExecutionMode;
	lastWorkflow?: LastWorkflowState;
}

export interface LastWorkflowState {
	mode: WorkflowMode;
	status: WorkflowStatus;
	label: string;
	detail: string;
	command?: string;
	output?: string;
	updatedAt: string;
}

export interface TerminalCommandRecord {
	command: string;
	cwd: string;
	startedAt: string;
	exitCode?: number;
	output?: string;
	previewUrls?: string[];
	persistent?: boolean;
}

export interface TaskRunRecord {
	id: string;
	kind: 'verify' | 'repair' | 'security' | 'dev' | 'task' | 'command';
	label: string;
	command: string;
	status: 'running' | 'passed' | 'failed';
	startedAt: string;
	finishedAt?: string;
	summary?: string;
	outputPreview?: string;
}

export interface ToolDefinition {
	type: 'function';
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface ToolExecutionResult {
	ok: boolean;
	output: string;
}

export interface ApprovalRequest {
	kind: 'write' | 'command' | 'read';
	title: string;
	detail: string;
	command?: string;
	filePath?: string;
	originalContent?: string;
	updatedContent?: string;
}

export interface ApprovalResult {
	approved: boolean;
	updatedContent?: string;
	stageFile?: boolean;
}

export interface TaskPreset {
	name: string;
	command: string;
	description?: string;
	previewPath?: string;
	previewChoices?: Array<{
		path: string;
		mtimeMs?: number;
		size?: number;
	}>;
}

export interface TimelineEntry {
	id: string;
	turnId: string;
	kind: 'turn' | 'status' | 'tool' | 'command' | 'git' | 'note';
	title: string;
	detail?: string;
	timestamp: string;
}

export interface XaiOutputItem {
	type: string;
	name?: string;
	call_id?: string;
	arguments?: string;
	content?: Array<{
		type: string;
		text?: string;
	}>;
}

export interface XaiResponse {
	id: string;
	output?: XaiOutputItem[];
	output_text?: string;
	usage?: Record<string, unknown>;
	error?: {
		message?: string;
	};
}
