import * as assert from 'assert';
import * as path from 'path';
import { ensureSubPath, normalizeRelativePath } from '../util/pathUtils';

suite('Path Utils', () => {
	test('normalizeRelativePath rejects parent traversal', () => {
		assert.throws(() => normalizeRelativePath('../outside'));
	});

	test('ensureSubPath accepts child path', () => {
		const root = path.resolve('/tmp/project');
		const child = path.resolve('/tmp/project/src/index.ts');
		assert.strictEqual(ensureSubPath(root, child), child);
	});

	test('ensureSubPath rejects escaped path', () => {
		const root = path.resolve('/tmp/project');
		const outside = path.resolve('/tmp/other/file.ts');
		assert.throws(() => ensureSubPath(root, outside));
	});
});
