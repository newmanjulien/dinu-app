import { textPrefix } from '../text';

export function contractName(buyerCompanyName: string): string {
	const company = textPrefix(
		buyerCompanyName
			.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '')
			.trim()
			.replace(/[. ]+$/g, ''),
		160
	);
	return company ? `${company} - Contract` : 'Contract';
}
