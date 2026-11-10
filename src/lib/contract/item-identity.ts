import { v, type Infer } from 'convex/values';

/** Template rules and immutable contract-owned alternatives share application semantics. */
export const contractItemId = v.union(v.id('playbookItems'), v.id('contractConcessions'));
export type ContractItemId = Infer<typeof contractItemId>;
