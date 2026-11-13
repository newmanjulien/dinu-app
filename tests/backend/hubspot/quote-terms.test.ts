import { expect, it } from 'vitest';
import { equivalentTerms, exportHtml } from '../../../src/lib/document/export/html';

it('preserves literal labels, tables, significant spaces and escaped legal wording in Quote terms', () => {
	const html = exportHtml([
		{ kind: 'paragraph', role: 'heading', content: '3. Terms & <conditions>' },
		{ kind: 'paragraph', role: 'body', content: " A  B\tC\n“Quoted” 'text' " },
		{
			kind: 'table',
			headerRowCount: 1,
			rows: [
				['Fee', 'Amount'],
				['', '$10']
			]
		}
	]);
	const expected =
		'<h2>3. Terms &amp; &lt;conditions&gt;</h2><p>&nbsp;A&nbsp;&nbsp;B&nbsp;&nbsp;&nbsp;&nbsp;C<br>“Quoted” &#39;text&#39;&nbsp;</p><table><tbody><tr><th>Fee</th><th>Amount</th></tr><tr><td><br></td><td>$10</td></tr></tbody></table>';
	expect(html).toBe(expected);
	expect(
		equivalentTerms(
			html,
			expected
				.replaceAll('&nbsp;', '&#160;')
				.replaceAll('<br>', '<br />')
				.replaceAll('<tbody>', '')
				.replaceAll('</tbody>', '')
		)
	).toBe(true);
	for (const changed of [
		expected.replace('$10', '$100'),
		expected.replace('&nbsp;&nbsp;B', '&nbsp;B'),
		expected.replace('<th>Fee', '<td>Fee').replace('Fee</th>', 'Fee</td>'),
		expected.replace('<p>', '<p style="display:none">'),
		'<script>alert(1)</script>',
		'<p>Malformed'
	])
		expect(equivalentTerms(html, changed)).toBe(false);
});
