export interface SecretScanResult {
	redactedText: string;
	findings: string[];
}

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
	{ label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
	{ label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
	{ label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
	{ label: 'OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
	{ label: 'Bearer token', pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
	{ label: 'Private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
	{ label: '.env assignment', pattern: /^\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*[^\s'"]+/gmi },
];

export function redactSecretsForRemote(text: string): SecretScanResult {
	let redactedText = text;
	const findings: string[] = [];

	for (const { label, pattern } of SECRET_PATTERNS) {
		let matched = false;
		redactedText = redactedText.replace(pattern, () => {
			matched = true;
			return `[REDACTED: ${label}]`;
		});
		if (matched) {
			findings.push(label);
		}
	}

	return {
		redactedText,
		findings: [...new Set(findings)],
	};
}
