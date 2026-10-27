import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
	plugins: [tailwindcss(), sveltekit()],
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
