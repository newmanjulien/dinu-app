import type { BaselineBlock, RoleAssignment } from './source-model';

export type ParagraphDecision = { blockKey: string; reason: string; needsReview: boolean };

/** Role corrections never replace source content, identities, or legal numbering. */
export function assignParagraphRoles(
	blocks: readonly BaselineBlock[],
	assignments: readonly RoleAssignment[]
): BaselineBlock[] {
	if (assignments.length > blocks.length) throw new Error('Too many paragraph corrections.');
	const byKey = new Map(blocks.map((block) => [block.blockKey, block]));
	const roles = new Map<string, RoleAssignment['role']>();
	for (const assignment of assignments) {
		if (
			byKey.get(assignment.blockKey)?.kind !== 'paragraph' ||
			roles.has(assignment.blockKey) ||
			!['title', 'heading', 'body'].includes(assignment.role)
		)
			throw new Error('Invalid paragraph correction.');
		roles.set(assignment.blockKey, assignment.role);
	}
	let bodyStarted = false;
	return blocks.map((block) => {
		if (block.kind === 'table') {
			bodyStarted = true;
			return block;
		}
		const role = roles.get(block.blockKey) ?? block.role;
		if (role === 'title') {
			if (bodyStarted || block.numbering)
				throw new Error('The title must be an unnumbered opening group.');
		} else bodyStarted = true;
		return role === block.role ? block : { ...block, role };
	});
}
