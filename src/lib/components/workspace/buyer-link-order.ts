export function orderBuyerLinks<T extends { hasUnreadComment: boolean; createdAt: number }>(
	rows: readonly T[],
	unreadFirst: boolean
): T[] {
	return [...rows].sort(
		(a, b) =>
			(unreadFirst ? Number(b.hasUnreadComment) - Number(a.hasUnreadComment) : 0) ||
			b.createdAt - a.createdAt
	);
}
