import { Unzip, UnzipInflate } from 'fflate';
import {
	DOCX_MAX_BYTES,
	DOCX_MAX_EXPANDED_BYTES,
	DOCX_MAX_RETAINED_XML_BYTES
} from '../../../contract/import/limits';
import { child, children, indexBy, parseXml, type XmlNode } from './xml';

type Relationship = { id: string; type: string; target: string; external: boolean };

function extract(
	input: Uint8Array,
	keepPart: (name: string) => boolean,
	retained: { bytes: number },
	inflateAll = true
) {
	const parts = new Map<string, Uint8Array>();
	const names = new Set<string>();
	let total = 0,
		completed = 0;
	const unzip = new Unzip((file) => {
		if (names.size >= 2000 || names.has(file.name) || /(^\/|\\|(^|\/)\.\.?(\/|$))/.test(file.name))
			throw new Error('The Word archive is invalid or too complex.');
		names.add(file.name);
		if ((file.originalSize ?? 0) > DOCX_MAX_EXPANDED_BYTES)
			throw new Error('The expanded Word file exceeds 50 MB.');
		const keep = keepPart(file.name);
		if (!inflateAll && !keep) return;
		const chunks: Uint8Array[] = [];
		let size = 0;
		file.ondata = (error, bytes, final) => {
			if (error) throw error;
			total += bytes.length;
			size += bytes.length;
			if (total > DOCX_MAX_EXPANDED_BYTES) throw new Error('The expanded Word file exceeds 50 MB.');
			if (keep) {
				retained.bytes += bytes.length;
				if (retained.bytes > DOCX_MAX_RETAINED_XML_BYTES)
					throw new Error('The Word XML exceeds supported size.');
				chunks.push(bytes);
			}
			if (final) {
				completed++;
				if (keep) {
					const joined = new Uint8Array(size);
					let offset = 0;
					for (const chunk of chunks) {
						joined.set(chunk, offset);
						offset += chunk.length;
					}
					parts.set(file.name, joined);
				}
			}
		};
		file.start();
	});
	unzip.register(UnzipInflate);
	for (let offset = 0; offset < input.length; offset += 4096)
		unzip.push(input.subarray(offset, offset + 4096), offset + 4096 >= input.length);
	if (inflateAll && completed !== names.size)
		throw new Error('The Word archive is incomplete. Save it again in Word.');
	return { parts, names };
}

export function openPackage(input: Uint8Array) {
	if (input.length > DOCX_MAX_BYTES) throw new Error('Choose a DOCX smaller than 10 MB.');
	const budget = { nodes: 0, characters: 0 };
	const retained = { bytes: 0 };
	// Discover relationships before retaining payloads. Ignored comments, footers,
	// media, and unrelated XML count toward expansion but never occupy the part map.
	const discovery = extract(
		input,
		(name) => name === '[Content_Types].xml' || name === '_rels/.rels',
		retained,
		false
	);
	const { names } = discovery;
	const manifest = discovery.parts.get('[Content_Types].xml');
	if (manifest) {
		const types = child(parseXml(manifest, budget, 'types'), 'Types');
		if (!types) throw new Error('Invalid Word package content types.');
		for (const node of types.children)
			if (!node.attrs.ContentType) throw new Error('Invalid Word package content types.');
		indexBy(children(types, 'Default'), 'Extension');
		indexBy(children(types, 'Override'), 'PartName');
	}
	const relationshipName = (source: string) => {
		const slash = source.lastIndexOf('/');
		return source
			? `${source.slice(0, slash + 1)}_rels/${source.slice(slash + 1)}.rels`
			: '_rels/.rels';
	};
	function relationships(source: string, bytes: Uint8Array | undefined): Relationship[] {
		const slash = source.lastIndexOf('/');
		if (!bytes) return [];
		const root = child(parseXml(bytes, budget, 'relationships'), 'Relationships');
		if (!root) throw new Error('Invalid Word package relationships.');
		const seen = new Set<string>();
		return children(root, 'Relationship').map((node) => {
			const { Id: id, Type: type, Target: raw, TargetMode } = node.attrs;
			if (!id || !type || !raw || seen.has(id))
				throw new Error('Invalid Word package relationships.');
			seen.add(id);
			const knownType = type.match(
				/^https?:\/\/(?:schemas\.openxmlformats\.org\/officeDocument\/2006|purl\.oclc\.org\/ooxml\/officeDocument)\/relationships\/([^/]+)$/
			)?.[1];
			const ignored =
				knownType === 'footer' || /\/comments(?:Extended|Extensible|Ids)?$/u.test(type);
			const external = TargetMode === 'External';
			let target = raw;
			if (!external) {
				if (/[\\?#]/.test(raw)) throw new Error('Unsupported Word package target.');
				const segments = (
					raw.startsWith('/') ? raw.slice(1) : source.slice(0, slash + 1) + raw
				).split('/');
				const resolved: string[] = [];
				for (const segment of segments) {
					if (segment === '..') {
						if (!resolved.length) throw new Error('Invalid Word package target.');
						resolved.pop();
					} else if (segment && segment !== '.') resolved.push(segment);
				}
				target = resolved.join('/');
				if (!ignored && !names.has(target))
					throw new Error(`The Word file is missing its referenced part: ${target}.`);
			}
			return { id, type: knownType ?? type, target, external };
		});
	}
	const mains = relationships('', discovery.parts.get('_rels/.rels')).filter(
		(r) => r.type === 'officeDocument' && !r.external
	);
	if (mains.length !== 1) throw new Error('Choose a valid DOCX with one main document part.');
	const main = mains[0].target;
	const relName = relationshipName(main);
	const relBytes = extract(input, (name) => name === relName, retained, false).parts.get(relName);
	const related = relationships(main, relBytes);
	const consumed = new Set([
		main,
		...related
			.filter((r) => !r.external && ['styles', 'numbering', 'header'].includes(r.type))
			.map((r) => r.target)
	]);
	const { parts } = extract(input, (name) => consumed.has(name), retained);
	const parsed = new Map<string, XmlNode>();
	function read(name: string): XmlNode {
		const cached = parsed.get(name);
		if (cached) return cached;
		const bytes = parts.get(name);
		if (!bytes) throw new Error(`The Word file is missing its referenced part: ${name}.`);
		const node = parseXml(bytes, budget);
		parsed.set(name, node);
		parts.delete(name);
		return node;
	}
	function relatedPart(type: string) {
		const matches = related.filter((r) => r.type === type);
		if (matches.length > 1 || matches.some((r) => r.external))
			throw new Error(`Invalid Word ${type} relationship.`);
		return matches.length ? read(matches[0].target) : undefined;
	}
	return { document: read(main), related, relatedPart, read };
}
