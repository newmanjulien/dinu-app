import type { ExportBlock } from './content';
import { SaxesParser } from 'saxes';

const escape = (text: string) =>
	text.replace(
		/[&<>"']/gu,
		(char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
	);

/** Literal labels are already in composeExport's text. Never number the paragraphs again. */
function textHtml(text: string) {
	// Nonbreaking spaces survive HubSpot's rich text sanitizer without relying on CSS.
	// Tabs have the exporter's fixed four-space presentation; newlines remain explicit.
	return text
		.split('\n')
		.map((line) =>
			escape(line)
				.replace(/ {2,}|^ | $/gu, (spaces) => '&nbsp;'.repeat(spaces.length))
				.replace(/\t/gu, '&nbsp;&nbsp;&nbsp;&nbsp;')
		)
		.join('<br>');
}

/** A conservative, self-contained Terms document, with no links, styles or remote resources. */
export function exportHtml(blocks: readonly ExportBlock[]): string {
	return blocks
		.map((block) => {
			if (block.kind === 'table')
				return `<table><tbody>${block.rows
					.map(
						(row, index) =>
							`<tr>${row
								.map((cell) => {
									const tag = index < block.headerRowCount ? 'th' : 'td';
									return `<${tag}>${textHtml(cell) || '<br>'}</${tag}>`;
								})
								.join('')}</tr>`
					)
					.join('')}</tbody></table>`;
			const tag = block.role === 'title' ? 'h1' : block.role === 'heading' ? 'h2' : 'p';
			return `<${tag}>${textHtml(block.content) || '<br>'}</${tag}>`;
		})
		.join('');
}

/** Only entity/br spelling and optional tbody wrappers may differ. Text is never trimmed. */
export function equivalentTerms(expected: string, actual: string): boolean {
	if (expected === actual) return true;
	const canonical = (html: string) => {
		const tokens: (string | [string, string])[] = [];
		const parser = new SaxesParser({ fragment: true });
		parser.on('opentag', (tag) => {
			if (
				!/^(h1|h2|p|br|table|tbody|tr|th|td)$/u.test(tag.name) ||
				Object.keys(tag.attributes).length
			)
				throw new Error('Unsupported Terms markup');
			if (tag.name !== 'tbody') tokens.push(`<${tag.name}>`);
		});
		parser.on('closetag', (tag) => {
			if (tag.name !== 'tbody') tokens.push(`</${tag.name}>`);
		});
		parser.on('text', (text) => {
			const last = tokens[tokens.length - 1];
			if (Array.isArray(last)) last[1] += text;
			else tokens.push(['text', text]);
		});
		parser.on('error', () => {
			throw new Error('Invalid Terms markup');
		});
		parser.write(html.replace(/&nbsp;/gu, '&#160;').replace(/<br\s*\/?>/gu, '<br/>')).close();
		return JSON.stringify(tokens);
	};
	try {
		return canonical(expected) === canonical(actual);
	} catch {
		return false;
	}
}
