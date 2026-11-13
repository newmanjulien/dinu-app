import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import base from './vitest.config.ts';

export default defineConfig({
	...base,
	plugins: [svelte({ configFile: false })],
	resolve: { ...base.resolve, conditions: ['browser'] },
	test: { ...base.test, include: ['tests/client/**/*.test.ts'] }
});
