import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
	plugins: [svelte({ configFile: false })],
	resolve: {
		conditions: ['browser'],
		alias: {
			$lib: local('./src/lib'),
			'$app/environment': local('./tests/support/browser-inputs.ts'),
			'$env/dynamic/public': local('./tests/support/browser-inputs.ts'),
			'$app/state': local('./tests/support/navigation.svelte.ts'),
			'$app/paths': local('./tests/support/navigation.svelte.ts'),
			'$app/navigation': local('./tests/support/navigation.svelte.ts')
		}
	},
	test: {
		include: ['tests/components/**/*.test.ts'],
		environment: 'jsdom',
		restoreMocks: true,
		unstubGlobals: true
	}
});
