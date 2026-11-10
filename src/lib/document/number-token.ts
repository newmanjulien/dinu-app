const romanSymbols = [
	[1000, 'm'],
	[900, 'cm'],
	[500, 'd'],
	[400, 'cd'],
	[100, 'c'],
	[90, 'xc'],
	[50, 'l'],
	[40, 'xl'],
	[10, 'x'],
	[9, 'ix'],
	[5, 'v'],
	[4, 'iv'],
	[1, 'i']
] as const;
export type NumberStyle = 'decimal' | 'lower-alpha' | 'upper-alpha' | 'lower-roman' | 'upper-roman';

export function numberValue(style: NumberStyle, position: number, sequential = false): string {
	if (!Number.isSafeInteger(position) || position < 1 || position > 10000)
		throw new Error('Numbering positions must be between 1 and 10000.');
	if (style === 'decimal') return String(position);
	let result = '';
	if (style.endsWith('roman')) {
		for (const [value, symbol] of romanSymbols)
			while (position >= value) {
				result += symbol;
				position -= value;
			}
	} else if (sequential) {
		while (position) {
			position--;
			result = String.fromCharCode(97 + (position % 26)) + result;
			position = Math.floor(position / 26);
		}
	} else result = String.fromCharCode(97 + ((position - 1) % 26)).repeat(Math.ceil(position / 26));
	return style.startsWith('upper') ? result.toUpperCase() : result;
}

export function tokenPosition(
	token: string,
	kind: 'decimal' | 'roman' | 'repeated' | 'sequential'
): number {
	let position = 0;
	const value = token.toLowerCase();
	if (kind === 'decimal') position = /^\d+$/u.test(token) ? Number(token) : 0;
	else if (!/^(?:[a-z]+|[A-Z]+)$/u.test(token)) return 0;
	else if (kind === 'repeated')
		position = /^([a-z])\1*$/u.test(value) ? (value.length - 1) * 26 + value.charCodeAt(0) - 96 : 0;
	else if (kind === 'sequential') {
		for (const letter of value) {
			position = position * 26 + letter.charCodeAt(0) - 96;
			if (position > 10000) return 0;
		}
	} else {
		let cursor = 0;
		for (const [count, symbol] of romanSymbols)
			while (value.startsWith(symbol, cursor)) {
				position += count;
				cursor += symbol.length;
			}
		if (
			cursor !== value.length ||
			position < 1 ||
			position > 10000 ||
			numberValue('lower-roman', position) !== value
		)
			return 0;
	}
	return Number.isSafeInteger(position) && position >= 1 && position <= 10000 ? position : 0;
}
