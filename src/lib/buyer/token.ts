/** Buyer codes are case-sensitive bearer credentials. */
export const buyerCodeAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const buyerCodeLength = 13;
export function isBuyerCode(value: string) {
	if (value.length !== buyerCodeLength) return false;
	for (const character of value) {
		if (!buyerCodeAlphabet.includes(character)) return false;
	}
	return true;
}

export const buyerTokenCollision = 'Buyer link code collision.';
