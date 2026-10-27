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
			'$app/environment': local('./tests/perf/browser-inputs.ts'),
			'$env/dynamic/public': local('./tests/perf/browser-inputs.ts'),
			'$app/state': local('./tests/lifecycle/navigation.svelte.ts'),
			'$app/paths': local('./tests/lifecycle/navigation.svelte.ts'),
			'$app/navigation': local('./tests/lifecycle/navigation.svelte.ts')
		}
	},
	test: {
		include: ['tests/lifecycle/*.test.ts'],
		environment: 'jsdom',
		restoreMocks: true,
		unstubGlobals: true
	}
});
