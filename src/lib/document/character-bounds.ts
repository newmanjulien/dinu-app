/** The first character rectangle shared by text-anchored document cards. */
export function characterBounds(node: Node, offset: number): DOMRect | null {
	if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.length || !node.ownerDocument)
		return null;
	const from = Math.max(0, Math.min(offset, node.textContent.length - 1));
	const range = node.ownerDocument.createRange();
	range.setStart(node, from);
	range.setEnd(node, from + 1);
	for (const bounds of range.getClientRects()) if (bounds.height || bounds.width) return bounds;
	return null;
}
