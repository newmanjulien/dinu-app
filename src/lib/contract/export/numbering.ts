import type { BaselineBlock } from '../source-model';

export type CanonicalNumbering = NonNullable<BaselineBlock['numbering']> & { position: number };
export const NUMBERING_NAMESPACE = 'urn:dinu:numbering';
export const NUMBERING_PART = 'customXml/dinu-numbering.xml';

export function numberingXml(items: readonly CanonicalNumbering[]): string {
	const escape = (value: string) =>
		value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
	return `<?xml version="1.0" encoding="UTF-8"?><numbering xmlns="${NUMBERING_NAMESPACE}" version="1">${items.map((item) => `<clause>${escape(JSON.stringify(item))}</clause>`).join('')}</numbering>`;
}
