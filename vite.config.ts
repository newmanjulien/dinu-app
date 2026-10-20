import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// These imports are first reached by the upload worker. Discover them before
	// the first upload so dependency optimization cannot reload its review state.
	optimizeDeps: { include: ['fflate', 'saxes'] },
	plugins: [tailwindcss(), sveltekit()]
});
