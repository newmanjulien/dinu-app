import { isDeepStrictEqual } from 'node:util';
import { createServer } from 'vite';
import { readSeed } from './reconcile-production-seed.mjs';
import { companyArguments, companyDeployment } from './company-convex.mjs';

const { companyId } = companyArguments();
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const { blocks, items } = await (async () => {
	try {
		return {
			blocks: await readSeed(server, 'templateSourceBlocks'),
			items: await readSeed(server, 'playbookItems')
		};
	} finally {
		await server.close();
	}
})();
const deployment = await companyDeployment({ companyId });
await deployment.run('operator:bootstrap', { companyId, blocks, items });
const actual = await deployment.run('operator:readSeed', { companyId });
if (
	!isDeepStrictEqual(actual.blocks, blocks) ||
	!isDeepStrictEqual(actual.items, items) ||
	!isDeepStrictEqual(actual.snapshot.blocks, blocks) ||
	!isDeepStrictEqual(actual.snapshot.items, items)
)
	throw new Error('Saved company data differs from the seed. Refusing to overwrite or restore it.');
console.log(
	`Company ${companyId} seed round trip verified: ${blocks.length} blocks, ${items.length} items.`
);
