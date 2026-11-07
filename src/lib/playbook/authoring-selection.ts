/** Semantic selection admission; route coordinates never enter the membership session. */
export type AnnotationAdmission = { status: 'rejected' } | { status: 'accepted'; token: object };
export type AuthoringSelectionRequest = {
	token: object;
	itemId: string;
	annotationId: string;
	status: 'pending' | 'opened';
};
