import { strFromU8, unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';

export type XmlNode = {
	name: string;
	attributes: Record<string, string>;
	children: (XmlNode | string)[];
};
export function parseXml(xml: string): XmlNode {
	const root: XmlNode = { name: '#document', attributes: {}, children: [] };
	const stack = [root];
	const parser = new SaxesParser();
	parser.on('opentag', ({ name, attributes }) => {
		const node: XmlNode = { name, attributes: attributes as Record<string, string>, children: [] };
		stack.at(-1)!.children.push(node);
		stack.push(node);
	});
	parser.on('text', (value) => stack.at(-1)!.children.push(value));
	parser.on('closetag', () => {
		stack.pop();
	});
	parser.write(xml).close();
	return root;
}
export function elements(node: XmlNode, name: string): XmlNode[] {
	return node.children.flatMap((child) =>
		typeof child === 'string'
			? []
			: [...(child.name === name ? [child] : []), ...elements(child, name)]
	);
}
export function textContent(node: XmlNode): string {
	return node.children
		.map((child) => (typeof child === 'string' ? child : textContent(child)))
		.join('');
}
export async function readDocx(blob: Blob) {
	const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
	// Parse every XML part, including relationships and content types, to catch broken packages.
	return Object.fromEntries(
		Object.entries(entries)
			.filter(([path]) => /\.(xml|rels)$/u.test(path))
			.map(([path, bytes]) => [path, parseXml(strFromU8(bytes))])
	);
}
