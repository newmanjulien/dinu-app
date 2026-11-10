import fs from 'node:fs';
import zlib from 'node:zlib';

/** @type {Record<string, {file:string;imports?:string[]}>} */
const manifest = JSON.parse(
	fs.readFileSync('.svelte-kit/output/client/.vite/manifest.json', 'utf8')
);
// Find route nodes by their source components; route-group changes can reorder node IDs.
const components = new Set([
	'src/routes/+layout.svelte',
	'src/routes/(workspace)/+layout.svelte',
	'src/routes/(workspace)/contracts/+page.svelte'
]);
const directory = '.svelte-kit/generated/client-optimized/nodes';
const roots = fs
	.readdirSync(directory)
	.filter((file) => {
		const source = fs.readFileSync(`${directory}/${file}`, 'utf8');
		return [...components].some((component) => source.includes(`/${component}\"`));
	})
	.map((file) => `${directory}/${file}`);
if (roots.length !== components.size)
	throw new Error('Could not identify all workspace route nodes.');
/** @type {Set<string>} */
const visited = new Set();
/** @param {string} key */
function visit(key) {
	if (visited.has(key)) return;
	const entry = manifest[key];
	if (!entry) throw new Error(`Missing manifest entry: ${key}`);
	visited.add(key);
	for (const dependency of entry.imports ?? []) visit(dependency);
}
roots.forEach(visit);
const files = [...visited].map((key) => manifest[key].file);
const contents = files.map((file) => fs.readFileSync(`.svelte-kit/output/client/${file}`));
const result = {
	kind: 'static-bundle-analysis',
	roots,
	files,
	bytes: contents.reduce((total, content) => total + content.length, 0),
	gzipBytes: contents.reduce((total, content) => total + zlib.gzipSync(content).length, 0),
	authenticatedBrowserTimings: null
};
const destination = process.argv[2];
if (destination) fs.writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
