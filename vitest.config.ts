import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Backend tests don't need the SvelteKit build pipeline. Individual files retain
// their existing Node/edge-runtime environment declarations.
export default defineConfig({
	resolve: {
		alias: {
			$lib: local('./src/lib'),
			'$app/environment': local('./tests/support/browser-inputs.ts'),
			'$app/navigation': local('./tests/support/browser-inputs.ts'),
			'$env/dynamic/public': local('./tests/support/browser-inputs.ts')
		}
	},
	test: {
		include: ['tests/backend/**/*.test.ts'],
		environment: 'node',
		restoreMocks: true,
		unstubGlobals: true
	}
});
