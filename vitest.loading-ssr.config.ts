import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
	plugins: [svelte({ configFile: false })],
	resolve: {
		conditions: ['node'],
		alias: {
			$lib: local('./src/lib'),
			'$app/environment': local('./tests/ssr/environment.ts'),
			'$env/dynamic/public': local('./tests/ssr/environment.ts'),
			'$app/state': local('./tests/lifecycle/navigation.svelte.ts'),
			'$app/paths': local('./tests/lifecycle/navigation.svelte.ts'),
			'$app/navigation': local('./tests/lifecycle/navigation.svelte.ts')
		}
	},
	test: { include: ['tests/ssr/*.test.ts'], environment: 'node', restoreMocks: true }
});
