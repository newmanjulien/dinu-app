export const quotePath = '/crm/objects/2026-09/quotes';
export const numericQuoteId = (value: unknown): value is string =>
	typeof value === 'string' && /^\d{1,30}$/u.test(value);

/** Links contain only validated provider identities, never provider-supplied URLs. */
export function quoteUrl(account: string, id: string) {
	if (!numericQuoteId(account) || !numericQuoteId(id))
		throw new Error('Invalid HubSpot quote identity');
	return `https://app.hubspot.com/quotes/${account}/details/${id}`;
}

const record = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** The shared successful native-quote boundary; callers retain their additional checks. */
export function activeQuote(raw: unknown, id: string, dealId: string) {
	if (
		!record(raw) ||
		raw.id !== id ||
		raw.archived === true ||
		!record(raw.properties) ||
		raw.properties.hs_template_type !== 'CPQ_QUOTE' ||
		!record(raw.associations) ||
		!record(raw.associations.deals)
	)
		return null;
	const deals = raw.associations.deals.results;
	if (
		!Array.isArray(deals) ||
		!deals.every((deal) => record(deal) && numericQuoteId(deal.id)) ||
		!deals.some((deal) => deal.id === dealId)
	)
		return null;
	return raw.properties;
}
