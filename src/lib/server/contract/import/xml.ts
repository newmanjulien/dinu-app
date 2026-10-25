import { SaxesParser } from 'saxes';
import { DOCX_MAX_XML_NODES, DOCX_MAX_XML_CHARACTERS } from '../../../contract/import/limits';

export type XmlNode = {
	name: string;
	attrs: Record<string, string>;
	children: XmlNode[];
	text: string;
};
const wordNamespaces = new Set([
	'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
	'http://purl.oclc.org/ooxml/wordprocessingml/main'
]);
const relationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
	'http://purl.oclc.org/ooxml/officeDocument/relationships'
]);
const packageNamespaces = {
	relationships: 'http://schemas.openxmlformats.org/package/2006/relationships',
	types: 'http://schemas.openxmlformats.org/package/2006/content-types'
} as const;
export const child = (n: XmlNode | undefined, name: string) =>
	n?.children.find((c) => c.name === name);
export const children = (n: XmlNode | undefined, name: string) =>
	n?.children.filter((c) => c.name === name) ?? [];
export const val = (n: XmlNode | undefined) => n?.attrs.val;
export const on = (n: XmlNode | undefined): boolean | undefined =>
	n ? !['0', 'false', 'off'].includes(n.attrs.val) : undefined;
export const text = (n: XmlNode): string => n.text + n.children.map(text).join('');

export function indexBy(nodes: XmlNode[], attribute: string): Map<string, XmlNode> {
	const result = new Map<string, XmlNode>();
	for (const node of nodes) {
		const key = node.attrs[attribute];
		if (!key || result.has(key)) throw new Error(`Missing or duplicate Word ${attribute}.`);
		result.set(key, node);
	}
	return result;
}

/** Limits apply during SAX parsing, before allocating a normalized document tree. */
export function parseXml(
	bytes: Uint8Array,
	budget: { nodes: number; characters: number },
	kind: 'word' | 'relationships' | 'types' = 'word'
): XmlNode {
	const root: XmlNode = { name: 'root', attrs: {}, children: [], text: '' };
	const stack = [root];
	const parser = new SaxesParser({ xmlns: true });
	const consume = (length: number) => {
		budget.characters += length;
		if (budget.characters > DOCX_MAX_XML_CHARACTERS)
			throw new Error('The Word XML exceeds supported complexity.');
	};
	parser.on('doctype', () => {
		throw new Error('Document type declarations are unsupported in Word XML.');
	});
	parser.on('opentag', (tag) => {
		if (
			++budget.nodes > DOCX_MAX_XML_NODES ||
			stack.length > 100 ||
			Object.keys(tag.attributes).length > 100
		)
			throw new Error('The Word document is too complex.');
		const attrs: Record<string, string> = {};
		for (const attribute of Object.values(tag.attributes)) {
			consume(attribute.value.length);
			if (attribute.uri === 'http://www.w3.org/2000/xmlns/') continue;
			const local = (kind === 'word' && wordNamespaces.has(attribute.uri)) || !attribute.uri;
			const relationship = relationshipNamespaces.has(attribute.uri);
			consume(attribute.local.length + (local ? 0 : relationship ? 2 : attribute.uri.length + 1));
			const name = local
				? attribute.local
				: relationship
					? `r:${attribute.local}`
					: `${attribute.uri}:${attribute.local}`;
			attrs[name] = attribute.value;
		}
		const local =
			kind === 'word' ? wordNamespaces.has(tag.uri) : tag.uri === packageNamespaces[kind];
		consume(tag.local.length + (local ? 0 : tag.uri.length + 1));
		const node: XmlNode = {
			name: local ? tag.local : `${tag.uri}:${tag.local}`,
			attrs,
			children: [],
			text: ''
		};
		stack.at(-1)!.children.push(node);
		stack.push(node);
	});
	parser.on('text', (value) => {
		consume(value.length);
		stack.at(-1)!.text += value;
	});
	parser.on('cdata', (value) => {
		consume(value.length);
		stack.at(-1)!.text += value;
	});
	parser.on('closetag', () => {
		stack.pop();
	});
	// XML permits UTF-16 as well as UTF-8. BOMs and the initial '<' identify
	// byte order without decoding the entire part into an intermediate string.
	const encoding =
		(bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)
			? 'utf-16le'
			: (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)
				? 'utf-16be'
				: 'utf-8';
	const decoder = new TextDecoder(encoding, { fatal: true });
	for (let offset = 0; offset < bytes.length; offset += 65536)
		parser.write(decoder.decode(bytes.subarray(offset, offset + 65536), { stream: true }));
	parser.write(decoder.decode()).close();
	return root;
}
