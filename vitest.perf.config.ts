import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

// Preserve the original work/cost guarantees across backend and client features.
export default defineConfig({
	...base,
	test: {
		...base.test,
		include: [
			'tests/backend/contracts/{creation,saving}.test.ts',
			'tests/backend/csm/provider.test.ts',
			'tests/backend/accounts/startup.test.ts',
			'tests/client/{caching,scheduling,csm-availability}.test.ts'
		]
	}
});
