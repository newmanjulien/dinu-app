import type { ChangeReview, ChangeStatus, DecisionCommand } from './changes';

export type ReviewStatus = ChangeStatus;
export type ReviewDecision = DecisionCommand['action'];
/** Review tags carry native changes and exact eligibility, including a gutter fallback. */
export type ReviewTag = ChangeReview & { admin: boolean; disabled: boolean; error?: string };
export type ReviewNavigation = { afterChangeId?: string };
