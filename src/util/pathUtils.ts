import * as path from 'path';

export function normalizeRelativePath(input: string): string {
	const normalized = input.replace(/\\/g, '/').trim();
	if (!normalized || normalized === '.') {
		return '';
	}

	if (path.isAbsolute(normalized)) {
		throw new Error('Absolute paths are not allowed.');
	}

	const collapsed = path.posix.normalize(normalized);
	if (collapsed === '..' || collapsed.startsWith('../')) {
		throw new Error('Path escapes the workspace root.');
	}

	return collapsed === '.' ? '' : collapsed;
}

export function ensureSubPath(rootPath: string, candidatePath: string): string {
	const resolvedRoot = path.resolve(rootPath);
	const resolvedCandidate = path.resolve(candidatePath);
	const relative = path.relative(resolvedRoot, resolvedCandidate);

	if (relative === '') {
		return resolvedCandidate;
	}

	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error('Path escapes the workspace root.');
	}

	return resolvedCandidate;
}

export function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}

	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}
