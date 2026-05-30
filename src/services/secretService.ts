import * as vscode from 'vscode';

const SECRET_KEY = 'grokrepchat.xaiApiKey';

export class SecretService {
	public constructor(private readonly secrets: vscode.SecretStorage) {}

	public async getApiKey(): Promise<string | undefined> {
		return this.secrets.get(SECRET_KEY);
	}

	public async hasApiKey(): Promise<boolean> {
		return Boolean(await this.getApiKey());
	}

	public async setApiKey(apiKey: string): Promise<void> {
		await this.secrets.store(SECRET_KEY, apiKey.trim());
	}

	public async clearApiKey(): Promise<void> {
		await this.secrets.delete(SECRET_KEY);
	}
}
