import * as assert from 'assert';
import { XaiClient } from '../services/xaiClient';

suite('XaiClient image requests', () => {
	test('image request body uses the Grok Imagine wire format', () => {
		assert.deepStrictEqual(XaiClient.buildImageGenerationBody({
			model: 'grok-imagine-image-quality',
			prompt: 'Create a test image.',
			aspectRatio: '16:9',
			resolution: '1k',
		}), {
			model: 'grok-imagine-image-quality',
			prompt: 'Create a test image.',
			response_format: 'b64_json',
			aspect_ratio: '16:9',
			resolution: '1k',
		});
	});
});
