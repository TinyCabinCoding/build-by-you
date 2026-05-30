import { AutonomousCommandPolicy } from '../core/types';

export function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, ' ');
}

export function getPrimaryCommandToken(command: string): string {
	const normalized = normalizeCommand(command);
	const token = normalized.split(/\s+/)[0] ?? '';
	return token.toLowerCase();
}

export function matchesSafePrefix(command: string, prefixes: string[]): boolean {
	const normalized = normalizeCommand(command).toLowerCase();
	return prefixes.some((prefix) => {
		const candidate = prefix.trim().toLowerCase();
		return candidate !== '' && (normalized === candidate || normalized.startsWith(`${candidate} `));
	});
}

export function matchesAllowedCommand(command: string, allowedCommands: string[]): boolean {
	const normalized = normalizeCommand(command).toLowerCase();
	return allowedCommands.some((allowed) => normalizeCommand(allowed).toLowerCase() === normalized);
}

export function matchesBlockedPattern(command: string, patterns: string[]): string | undefined {
	const normalized = normalizeCommand(command);
	for (const pattern of patterns) {
		const trimmed = pattern.trim();
		if (!trimmed) {
			continue;
		}

		try {
			const regex = new RegExp(trimmed, 'i');
			if (regex.test(normalized)) {
				return trimmed;
			}
		} catch {
			if (normalized.toLowerCase().includes(trimmed.toLowerCase())) {
				return trimmed;
			}
		}
	}

	return undefined;
}

export function hasUnsafeShellSyntax(command: string): boolean {
	const normalized = normalizeCommand(command);
	return /(?:&&|\|\||[|;><`]|[$][(]|\n|\r)/.test(normalized);
}

export function canAutoApproveCommand(
	command: string,
	policy: AutonomousCommandPolicy,
	allowedCommands: string[],
	safePrefixes: string[],
): boolean {
	if (hasUnsafeShellSyntax(command)) {
		return false;
	}

	if (policy === 'all') {
		return true;
	}

	return matchesAllowedCommand(command, allowedCommands) || matchesSafePrefix(command, safePrefixes);
}
