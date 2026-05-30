export function stripAnsi(text: string): string {
	return text
		.replace(/\u001B\][^\u0007]*\u0007/g, '')
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
		.replace(/\u001B[@-_]/g, '');
}

export function sanitizeTerminalChunk(text: string): string {
	const stripped = stripAnsi(text)
		.replace(/\r/g, '\n')
		.replace(/\u0000/g, '')
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== '')
		.filter((line) => !/^[⠁-⣿◐◑◒◓]+(?:\s+.*)?$/.test(line.trim()))
		.join('\n')
		.trim();

	return stripped;
}

export function summarizeTerminalOutput(text: string, maxChars = 4000): string {
	const cleaned = sanitizeTerminalChunk(text)
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	if (cleaned.length <= maxChars) {
		return cleaned;
	}

	return `${cleaned.slice(0, maxChars)}\n\n[truncated ${cleaned.length - maxChars} chars]`;
}
