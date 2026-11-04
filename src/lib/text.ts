/** Keep the UTF-16 length limit without splitting a code point. */
export function textPrefix(text: string, maxLength: number): string {
	return text.slice(0, (text.codePointAt(maxLength - 1) ?? 0) > 0xffff ? maxLength - 1 : maxLength);
}
