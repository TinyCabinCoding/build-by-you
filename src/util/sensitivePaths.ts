export const DEFAULT_SENSITIVE_BASENAMES = new Set([
	'.env',
	'.env.local',
	'.env.development',
	'.env.production',
	'.env.test',
	'.npmrc',
	'.yarnrc',
	'.pypirc',
	'.netrc',
	'credentials',
	'config',
	'id_rsa',
	'id_dsa',
	'id_ecdsa',
	'id_ed25519',
	'known_hosts',
]);

export function normalizeForMatch(relativePath: string): string {
	return relativePath.replace(/\\/g, '/').toLowerCase();
}

export function isSensitiveWorkspacePath(relativePath: string): boolean {
	const normalized = normalizeForMatch(relativePath);
	const segments = normalized.split('/').filter(Boolean);
	const basename = segments[segments.length - 1] ?? '';

	if (DEFAULT_SENSITIVE_BASENAMES.has(basename)) {
		return true;
	}

	if (basename.startsWith('.env')) {
		return true;
	}

	if (segments.includes('.ssh')) {
		return true;
	}

	if (segments.includes('.aws')) {
		return true;
	}

	if (segments.includes('.azure')) {
		return true;
	}

	if (segments.includes('.config') && segments.includes('gcloud')) {
		return true;
	}

	if (segments.includes('.gnupg')) {
		return true;
	}

	if (segments.includes('.kube')) {
		return true;
	}

	if (segments.includes('.docker') && basename === 'config.json') {
		return true;
	}

	if (normalized.includes('/secrets/')) {
		return true;
	}

	if (basename.endsWith('.pem') || basename.endsWith('.key') || basename.endsWith('.p12') || basename.endsWith('.pfx')) {
		return true;
	}

	return false;
}
