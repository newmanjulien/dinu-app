/** Buyer URLs are bearer credentials. Keep codes as strings, including leading zeros. */
export const isBuyerCode = (value: string) => /^[0-9]{39}$/u.test(value);
export const isLegacyBuyerToken = (value: string) => /^[A-Za-z0-9_-]{43}$/u.test(value);
export const isBuyerToken = (value: string) => isBuyerCode(value) || isLegacyBuyerToken(value);

export const buyerTokenCollision = 'Buyer link code collision.';
