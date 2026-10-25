import { child, children, val, on, type XmlNode as Node } from './xml';
import type { ImportIssue } from '../../../contract/import/limits';
export type Marks = { bold?: boolean; italic?: boolean };
export type Location = string | { id: string; label: string };
export type Issue = (
	location: Location,
	message: string,
	severity?: ImportIssue['severity']
) => void;
type Format = Marks & {
	vanish?: boolean;
	strike?: boolean;
	dstrike?: boolean;
	vertAlign?: string;
	underline?: string;
	cs?: boolean;
	rtl?: boolean;
	bCs?: boolean;
	iCs?: boolean;
};
// Word selects complex-script properties from the text as well as cs/rtl.
const complexScript =
	/[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Tibetan}\p{Script=Myanmar}\p{Script=Khmer}\p{Script=Mongolian}]/u;

// Compare the whole definition, including properties the importer does not use.
// XML attribute order does not change a style's meaning.
function sameStyle(a: Node, b: Node): boolean {
	const attributes = Object.keys(a.attrs);
	return (
		a.name === b.name &&
		a.text === b.text &&
		attributes.length === Object.keys(b.attrs).length &&
		attributes.every((name) => a.attrs[name] === b.attrs[name]) &&
		a.children.length === b.children.length &&
		a.children.every((node, index) => sameStyle(node, b.children[index]))
	);
}

export function formatting(root: Node | undefined, issue: Issue) {
	const styles = new Map<string, Node>();
	for (const style of children(root, 'style')) {
		const id = style.attrs.styleId;
		if (!id) throw new Error('A Word style is missing its styleId.');
		const existing = styles.get(id);
		if (existing && !sameStyle(existing, style))
			throw new Error(`The Word file contains conflicting definitions for style: ${id}.`);
		if (!existing) styles.set(id, style);
	}
	const defaults = child(root, 'docDefaults');
	const defaultStyle = (type: string) =>
		[...styles.values()].find(
			(s) => s.attrs.type === type && ['1', 'true', 'on'].includes(s.attrs.default)
		)?.attrs.styleId;
	const defaultParagraph = defaultStyle('paragraph');
	const defaultTable = defaultStyle('table');
	const cache = new Map<string, Node[]>();
	const visiting = new Set<string>();
	function chain(id?: string): Node[] {
		if (!id) return [];
		if (visiting.has(id)) throw new Error('Word styles contain a cycle.');
		if (visiting.size >= 30) throw new Error('Word styles contain excessive inheritance.');
		const cached = cache.get(id);
		if (cached) return cached;
		const style = styles.get(id);
		if (!style) throw new Error(`The Word file refers to a missing style: ${id}.`);
		visiting.add(id);
		try {
			const ancestors = chain(val(child(style, 'basedOn')));
			if (ancestors.length >= 30) throw new Error('Word styles contain excessive inheritance.');
			const result = [...ancestors, style];
			cache.set(id, result);
			return result;
		} finally {
			visiting.delete(id);
		}
	}
	function apply(base: Format, props: Node | undefined, toggles = false): Format {
		const result = { ...base };
		for (const [name, key] of [
			['b', 'bold'],
			['i', 'italic'],
			['vanish', 'vanish'],
			['strike', 'strike'],
			['dstrike', 'dstrike'],
			['bCs', 'bCs'],
			['iCs', 'iCs']
		] as const) {
			const value = on(child(props, name));
			if (value !== undefined) result[key] = toggles ? (value ? !result[key] : result[key]) : value;
		}
		if (child(props, 'vertAlign')) result.vertAlign = val(child(props, 'vertAlign'));
		if (child(props, 'u')) result.underline = val(child(props, 'u')) ?? 'single';
		for (const name of ['cs', 'rtl'] as const)
			if (child(props, name)) result[name] = on(child(props, name));
		return result;
	}
	function checked(format: Format, location: Location, runText = ''): Marks {
		if (format.vanish) issue(location, 'Remove hidden text in Word.');
		if (format.strike || format.dstrike)
			issue(location, 'Remove struck-through text or accept its deletion in Word.');
		if (format.vertAlign && format.vertAlign !== 'baseline')
			issue(location, 'Replace superscript or subscript with ordinary text in Word.');
		if (
			(format.cs || format.rtl || complexScript.test(runText)) &&
			(Boolean(format.bCs) !== Boolean(format.bold) ||
				Boolean(format.iCs) !== Boolean(format.italic))
		)
			issue(location, 'Convert complex-script run formatting to ordinary bold and italic in Word.');
		if (format.underline && format.underline !== 'none')
			issue(location, 'Underlining is standardized to ordinary text.', 'warning');
		return { bold: format.bold ?? false, italic: format.italic ?? false };
	}
	const tableCache = new Map<string, Node[]>();
	function table(
		n: Node,
		row: number,
		column: number,
		rowCount: number,
		columnCount: number,
		location: Location
	): Node[] {
		const props = child(n, 'tblPr');
		const look = child(props, 'tblLook');
		const bits = Number.parseInt(look?.attrs.val ?? '0', 16);
		const flag = (name: string, bit: number) =>
			look?.attrs[name] !== undefined
				? !['0', 'false', 'off'].includes(look.attrs[name])
				: Boolean(bits & bit);
		const conditions = new Set(['wholeTable']);
		if (flag('firstRow', 0x20) && row === 0) conditions.add('firstRow');
		if (flag('lastRow', 0x40) && row === rowCount - 1) conditions.add('lastRow');
		if (flag('firstColumn', 0x80) && column === 0) conditions.add('firstCol');
		if (flag('lastColumn', 0x100) && column === columnCount - 1) conditions.add('lastCol');
		const styleId = val(child(props, 'tblStyle')) ?? defaultTable;
		const cacheKey = `${styleId ?? ''}:${[...conditions].join(',')}`;
		if (tableCache.has(cacheKey)) return tableCache.get(cacheKey)!;
		const styleChain = chain(styleId);
		const result: Node[] = [];
		for (const style of styleChain) {
			if (child(style, 'rPr')) result.push(child(style, 'rPr')!);
			if (child(child(style, 'pPr'), 'numPr'))
				issue(location, 'Remove numbering inherited from table styles in Word.');
			const overrides = children(style, 'tblStylePr');
			// Banding/corner precedence depends on additional geometry and cnfStyle overrides.
			// Refuse those run-property rules rather than approximating their result.
			for (const override of overrides)
				if (
					!['wholeTable', 'firstRow', 'lastRow', 'firstCol', 'lastCol'].includes(
						override.attrs.type
					) &&
					child(override, 'rPr')
				)
					issue(
						location,
						'Convert banded or corner table text formatting to direct formatting in Word.'
					);

			if (overrides.some((o) => child(child(o, 'pPr'), 'numPr')))
				issue(location, 'Remove numbering inherited from conditional table styles in Word.');
		}
		// Complete each inheritance layer before advancing to the next condition.
		// Row rules therefore retain precedence over column/base rules in child styles.
		for (const condition of ['wholeTable', 'firstCol', 'lastCol', 'firstRow', 'lastRow'])
			if (conditions.has(condition))
				for (const style of styleChain) {
					const override = children(style, 'tblStylePr').find((o) => o.attrs.type === condition);
					if (child(override, 'rPr')) result.push(child(override, 'rPr')!);
				}
		tableCache.set(cacheKey, result);
		return result;
	}
	function character(base: Format, props: Node | undefined): Format {
		let result = base;
		for (const style of chain(val(child(props, 'rStyle'))))
			result = apply(result, child(style, 'rPr'), true);
		return apply(result, props);
	}
	function paragraph(p: Node, tableProps: Node[] = []) {
		const props = child(p, 'pPr');
		const styleChain = chain(val(child(props, 'pStyle')) ?? defaultParagraph);
		const pProps = [
			child(child(defaults, 'pPrDefault'), 'pPr'),
			...styleChain.map((s) => child(s, 'pPr')),
			props
		];
		const property = (name: string) => pProps.map((n) => child(n, name)).findLast(Boolean);
		const indents = pProps.map((n) => child(n, 'ind'));
		const indent = indents
			.map((n) => n?.attrs.start ?? n?.attrs.left)
			.findLast((n) => n !== undefined);
		const hanging = indents.map((n) => n?.attrs.hanging).findLast((n) => n !== undefined);
		let base = apply({}, child(child(defaults, 'rPrDefault'), 'rPr'));
		for (const rPr of tableProps) base = apply(base, rPr, true);
		for (const style of styleChain) base = apply(base, child(style, 'rPr'), true);
		return {
			property,
			indent:
				indent !== undefined &&
				Number.isSafeInteger(Number(indent)) &&
				Number.isSafeInteger(Number(hanging ?? 0)) &&
				Math.abs(Number(indent)) <= 1_000_000 &&
				Math.abs(Number(hanging ?? 0)) <= 1_000_000
					? Number(indent) - Number(hanging ?? 0)
					: undefined,
			numProps: pProps.map((n) => child(n, 'numPr')).filter((n): n is Node => Boolean(n)),
			headingStyle: styleChain
				.map((s) => val(child(s, 'name')) ?? s.attrs.styleId)
				.findLast((s) => /^heading\s*[1-9]$/i.test(s)),
			run(rPr: Node | undefined, location: Location, runText = '') {
				return checked(character(base, rPr), location, runText);
			},
			label(rPr: Node | undefined, location: Location) {
				return checked(character(character(base, child(props, 'rPr')), rPr), location);
			}
		};
	}
	function tableDirection(n: Node): boolean {
		let rtl = false;
		for (const style of chain(val(child(child(n, 'tblPr'), 'tblStyle')) ?? defaultTable))
			rtl = on(child(child(style, 'tblPr'), 'bidiVisual')) ?? rtl;
		return on(child(child(n, 'tblPr'), 'bidiVisual')) ?? rtl;
	}
	return { paragraph, table, tableDirection };
}
