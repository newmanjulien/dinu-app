import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { companyArguments, companyDeployment } from './company-convex.mjs';

const { companyId } = companyArguments();
async function readRows(name) {
	const source = (await readFile(`data/convex/${name}.jsonl`, 'utf8')).trim();
	if (!source) throw new Error(`${name} import records are empty.`);
	return source.split('\n').map((row) => JSON.parse(row));
}
const blocks = await readRows('contractBlocks');
const items = await readRows('playbookItems');
const deployment = await companyDeployment({ companyId });
await deployment.run('operator:bootstrap', { companyId, blocks, items });
const actual = await deployment.run('operator:readSeed', { companyId });
if (
	!isDeepStrictEqual(actual.blocks, blocks) ||
	!isDeepStrictEqual(actual.items, items) ||
	!isDeepStrictEqual(actual.publication.blocks, blocks) ||
	!isDeepStrictEqual(actual.publication.items, items)
)
	throw new Error(
		'Published company data differs from the seed. Refusing to overwrite or restore it.'
	);
console.log(
	`Company ${companyId} seed round trip verified: ${blocks.length} blocks, ${items.length} items.`
);
