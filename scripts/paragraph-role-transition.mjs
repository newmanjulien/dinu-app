// Prepare local schema files only. Deployment and data changes are separate operations.
import { readFile, writeFile, unlink } from 'node:fs/promises';
const schema = 'src/convex/schema.ts';
const canonical = 'src/convex/paragraphRoleCanonicalSchema.ts';
const marker = '// PARAGRAPH ROLE TRANSITION: restore strict schema before normal operation.';
const command = process.argv[2];
if (process.argv.length !== 3 || !['prepare', 'restore'].includes(command))
	throw new Error('Usage: node scripts/paragraph-role-transition.mjs prepare|restore');
if (command === 'prepare') {
	const contents = await readFile(schema, 'utf8');
	if (contents.includes('TRANSITION:')) throw new Error('A schema transition is already prepared.');
	await writeFile(canonical, contents, { flag: 'wx' });
	await writeFile(
		schema,
		`${marker}\nimport { defineSchema } from 'convex/server';\nimport canonical from './paragraphRoleCanonicalSchema';\nexport default defineSchema(canonical.tables, { schemaValidation: false });\n`
	);
} else {
	if (!(await readFile(schema, 'utf8')).startsWith(marker))
		throw new Error('Refusing to overwrite a schema without its transition marker.');
	await writeFile(schema, await readFile(canonical, 'utf8'));
	await unlink(canonical);
}
console.log(
	`${command === 'prepare' ? 'Prepared transition' : 'Restored strict'} schema locally. No deployment or database operation was run.`
);
