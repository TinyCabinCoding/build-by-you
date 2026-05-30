import * as vscode from 'vscode';
import { ChatController } from './chat/chatController';
import { ConfigService } from './services/configService';
import { GitService } from './services/gitService';
import { GrokAgentService } from './services/grokAgentService';
import { SecretService } from './services/secretService';
import { SessionStoreService } from './services/sessionStoreService';
import { TaskPresetService } from './services/taskPresetService';
import { TerminalSessionService } from './services/terminalSessionService';
import { WorkspaceContextService } from './services/workspaceContextService';

export function activate(context: vscode.ExtensionContext): void {
	const configService = new ConfigService();
	const secretService = new SecretService(context.secrets);
	const sessionStoreService = new SessionStoreService(context.workspaceState, context.globalState);
	const terminalSessionService = new TerminalSessionService();
	const gitService = new GitService();
	const taskPresetService = new TaskPresetService();
	const workspaceContextService = new WorkspaceContextService();
	const grokAgentService = new GrokAgentService();
	const securityOutputChannel = vscode.window.createOutputChannel('Build by Grok (Security)');
	const chatController = new ChatController(
		context,
		configService,
		secretService,
		sessionStoreService,
		terminalSessionService,
		gitService,
		taskPresetService,
		workspaceContextService,
		grokAgentService,
		securityOutputChannel,
	);

	context.subscriptions.push(
		securityOutputChannel,
		{ dispose: () => chatController.dispose() },
		vscode.window.registerWebviewViewProvider('grokrepchat.sidebar', chatController.getSidebarProvider(), {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand('grokrepchat.openChat', async () => {
			await vscode.commands.executeCommand('workbench.view.extension.grokrepchat');
			chatController.getSidebarProvider().reveal();
		}),
		vscode.commands.registerCommand('grokrepchat.openPopoutChat', async () => {
			await chatController.openPanel();
		}),
		vscode.commands.registerCommand('grokrepchat.focusSidebar', async () => {
			await vscode.commands.executeCommand('workbench.view.extension.grokrepchat');
			chatController.getSidebarProvider().reveal();
		}),
		vscode.commands.registerCommand('grokrepchat.setApiKey', async () => {
			await chatController.handleSetApiKey();
		}),
		vscode.commands.registerCommand('grokrepchat.buildNewSite', async () => {
			await chatController.handleBuildNewSite();
		}),
		vscode.commands.registerCommand('grokrepchat.factoryReset', async () => {
			await chatController.handleFactoryReset();
		}),
		vscode.commands.registerCommand('grokrepchat.clearApiKey', async () => {
			await chatController.clearApiKey();
		}),
		vscode.commands.registerCommand('grokrepchat.selectWorkspace', async () => {
			await chatController.handleSelectWorkspace();
		}),
		vscode.commands.registerCommand('grokrepchat.verifyWorkspace', async () => {
			await chatController.handleVerifyWorkspace();
		}),
		vscode.commands.registerCommand('grokrepchat.repairWorkspace', async () => {
			await chatController.handleRepairWorkspace();
		}),
		vscode.commands.registerCommand('grokrepchat.securityAudit', async () => {
			await chatController.handleSecurityAudit();
		}),
		vscode.commands.registerCommand('grokrepchat.rerunLastWorkflow', async () => {
			await chatController.handleRerunLastWorkflow();
		}),
		vscode.commands.registerCommand('grokrepchat.showLastFailure', async () => {
			await chatController.handleShowLastFailure();
		}),
		vscode.commands.registerCommand('grokrepchat.startDevServer', async () => {
			await chatController.handleStartDevServer();
		}),
		vscode.commands.registerCommand('grokrepchat.stopDevServer', async () => {
			await chatController.handleStopDevServer();
		}),
		vscode.commands.registerCommand('grokrepchat.openPreview', async () => {
			await chatController.handleOpenPreview();
		}),
		vscode.commands.registerCommand('grokrepchat.openTerminal', async () => {
			await chatController.handleOpenTerminal();
		}),
		vscode.commands.registerCommand('grokrepchat.openSourceControl', async () => {
			await chatController.handleOpenSourceControl();
		}),
		vscode.commands.registerCommand('grokrepchat.openSecurityLog', async () => {
			securityOutputChannel.show(true);
		}),
	);
}

export function deactivate(): void {}
