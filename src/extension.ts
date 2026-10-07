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
	const securityOutputChannel = vscode.window.createOutputChannel('Build by You (Security)');
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
		vscode.window.registerWebviewViewProvider('buildbyyou.sidebar', chatController.getSidebarProvider(), {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand('buildbyyou.openChat', async () => {
			await vscode.commands.executeCommand('workbench.view.extension.buildbyyou');
			chatController.getSidebarProvider().reveal();
		}),
		vscode.commands.registerCommand('buildbyyou.openPopoutChat', async () => {
			await chatController.openPanel();
		}),
		vscode.commands.registerCommand('buildbyyou.focusSidebar', async () => {
			await vscode.commands.executeCommand('workbench.view.extension.buildbyyou');
			chatController.getSidebarProvider().reveal();
		}),
		vscode.commands.registerCommand('buildbyyou.setApiKey', async () => {
			await chatController.handleSetApiKey();
		}),
		vscode.commands.registerCommand('buildbyyou.buildNewSite', async () => {
			await chatController.handleBuildNewSite();
		}),
		vscode.commands.registerCommand('buildbyyou.factoryReset', async () => {
			await chatController.handleFactoryReset();
		}),
		vscode.commands.registerCommand('buildbyyou.clearApiKey', async () => {
			await chatController.clearApiKey();
		}),
		vscode.commands.registerCommand('buildbyyou.selectWorkspace', async () => {
			await chatController.handleSelectWorkspace();
		}),
		vscode.commands.registerCommand('buildbyyou.verifyWorkspace', async () => {
			await chatController.handleVerifyWorkspace();
		}),
		vscode.commands.registerCommand('buildbyyou.repairWorkspace', async () => {
			await chatController.handleRepairWorkspace();
		}),
		vscode.commands.registerCommand('buildbyyou.securityAudit', async () => {
			await chatController.handleSecurityAudit();
		}),
		vscode.commands.registerCommand('buildbyyou.rerunLastWorkflow', async () => {
			await chatController.handleRerunLastWorkflow();
		}),
		vscode.commands.registerCommand('buildbyyou.showLastFailure', async () => {
			await chatController.handleShowLastFailure();
		}),
		vscode.commands.registerCommand('buildbyyou.startDevServer', async () => {
			await chatController.handleStartDevServer();
		}),
		vscode.commands.registerCommand('buildbyyou.stopDevServer', async () => {
			await chatController.handleStopDevServer();
		}),
		vscode.commands.registerCommand('buildbyyou.openPreview', async () => {
			await chatController.handleOpenPreview();
		}),
		vscode.commands.registerCommand('buildbyyou.openTerminal', async () => {
			await chatController.handleOpenTerminal();
		}),
		vscode.commands.registerCommand('buildbyyou.openSourceControl', async () => {
			await chatController.handleOpenSourceControl();
		}),
		vscode.commands.registerCommand('buildbyyou.openSecurityLog', async () => {
			securityOutputChannel.show(true);
		}),
	);
}

export function deactivate(): void {}
