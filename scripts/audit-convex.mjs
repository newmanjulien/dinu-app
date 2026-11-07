import assert from 'node:assert/strict';
import { readSeed, differences } from './reconcile-production-seed.mjs';
import { createServer } from 'vite';
import { companyArguments, companyDeployment } from './company-convex.mjs';

const { companyId, exactSeed } = companyArguments({ audit: true });
const deployment = await companyDeployment({ companyId, readOnly: true });
const { blocks, items, snapshot } = await deployment.run('operator:readSeed', { companyId });
assert.deepEqual(snapshot.blocks, blocks, 'Saved blocks differ from the live baseline');
assert.deepEqual(snapshot.items, items, 'Saved items differ from live authoring');
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
	const { validatePlaybook } = await server.ssrLoadModule('/src/lib/playbook/audit.ts');
	validatePlaybook(blocks, items);
	if (exactSeed) {
		const expectedBlocks = await readSeed('contractBlocks');
		const expectedItems = await readSeed('playbookItems');
		const identity = (item) => JSON.stringify(item.trigger.id);
		const actualByIdentity = new Map(items.map((item) => [identity(item), item]));
		assert.equal(actualByIdentity.size, items.length, 'Duplicate logical item identity');
		assert.equal(items.length, expectedItems.length, 'Live item count differs from seed');
		const aligned = expectedItems.map((item) => actualByIdentity.get(identity(item)));
		const mismatches = [
			...differences(expectedBlocks, blocks, 'contractBlocks'),
			...differences(expectedItems, aligned, 'playbookItems')
		];
		assert.equal(mismatches.length, 0, JSON.stringify(mismatches.slice(0, 20), null, 2));
		console.log(
			'Exact seed reconciliation passed: 0 business-data mismatches (Convex IDs and transport metadata excluded).'
		);
	}
	console.log(
		`Live contract valid at ${new URL(deployment.url).host}, company ${companyId}: ${blocks.length} blocks, ${items.length} items, ${items.reduce((count, box) => count + box.concessions.length, 0)} concessions.`
	);
} finally {
	await server.close();
}
