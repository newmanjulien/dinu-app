import fs from 'node:fs';
/** @type {{file:string;imports:string[];modules:string[]}[]} */
const chunks = JSON.parse(fs.readFileSync('.svelte-kit/loading-modules.json', 'utf8'));
const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
/** @param {{file:string;imports:string[];modules:string[]}[]} roots */
function closure(roots) {
	const visited = new Set();
	/** @param {string} file */
	function visit(file) {
		if (visited.has(file)) return;
		visited.add(file);
		const chunk = byFile.get(file);
		if (!chunk) throw new Error(`Missing emitted chunk ${file}`);
		chunk.imports.forEach(visit);
	}
	roots.forEach((chunk) => visit(chunk.file));
	return [...visited].flatMap((file) => byFile.get(file)?.modules ?? []);
}
const heavy = [
	'/src/lib/document/runtime/workspace-factory.ts',
	'/src/lib/document/pagination/profiler.ts',
	'/src/lib/components/document/DocumentViewer.svelte',
	'/src/lib/playbook/authoring-controller.svelte.ts',
	'/node_modules/docx/'
];
for (const [name, roots] of /** @type {const} */ ([
	[
		'public account frame',
		['/src/routes/+layout.svelte', '/src/routes/(workspace)/+layout.svelte']
	],
	['Contracts', ['/src/lib/components/workspace/Contracts.svelte']],
	['buyer contract entry', ['/src/routes/(buyer)/[token=buyerCode]/+page.svelte']]
])) {
	const entries = chunks.filter((chunk) =>
		roots.some((root) => chunk.modules.some((module) => module.endsWith(root)))
	);
	if (entries.length === 0) throw new Error(`No chunks found for ${name}`);
	const modules = closure(entries);
	const violations = modules.filter((module) => heavy.some((path) => module.includes(path)));
	if (name === 'public account frame')
		violations.push(
			...modules.filter((module) => module.endsWith('/src/lib/buyer/AnonymousProvider.svelte'))
		);
	if (violations.length)
		throw new Error(
			`${name} statically imports heavy dependencies:\n${[...new Set(violations)].join('\n')}`
		);
}
for (const module of heavy.filter((module) => !module.includes('node_modules'))) {
	if (!chunks.some((chunk) => chunk.modules.some((source) => source.endsWith(module))))
		throw new Error(`Missing demanded document module ${module}`);
}
console.log('Loading dependency boundaries passed: public frame, Contracts, buyer contract entry.');
