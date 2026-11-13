import { textPrefix } from '../text';

export function contractName(title: string): string {
	const company = textPrefix(
		title
			.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '')
			.trim()
			.replace(/[. ]+$/g, ''),
		160
	);
	return company ? `${company} - Contract` : 'Contract';
}
