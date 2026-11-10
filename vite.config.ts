import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import fs from 'node:fs';

export default defineConfig(({ command }) => ({
	plugins: [
		tailwindcss(),
		sveltekit(),
		{
			name: 'loading-module-boundaries',
			writeBundle(options, bundle) {
				if (!options.dir?.replaceAll('\\', '/').endsWith('/client')) return;
				// Verification metadata stays outside the published static assets.
				fs.writeFileSync(
					'.svelte-kit/loading-modules.json',
					JSON.stringify(
						Object.values(bundle)
							.filter((entry) => entry.type === 'chunk')
							.map((chunk) => ({
								file: chunk.fileName,
								imports: chunk.imports,
								dynamicImports: chunk.dynamicImports,
								modules: Object.keys(chunk.modules).map((id) => id.replaceAll(process.cwd(), ''))
							}))
					)
				);
			}
		}
	],
	css: {
		// Production already runs Tailwind's optimizer and Vite's CSS minifier.
		transformer: command === 'serve' ? 'lightningcss' : 'postcss',
		lightningcss: {
			targets: {
				chrome: 111 << 16,
				edge: 111 << 16,
				firefox: 128 << 16,
				safari: (16 << 16) | (4 << 8)
			}
		}
	},
	build: {
		target: ['chrome111', 'edge111', 'firefox128', 'safari16.4', 'ios16.4']
	}
}));
