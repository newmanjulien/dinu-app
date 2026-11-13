import { v, type Infer } from 'convex/values';

/** Playbook item identity remains the frozen template item; proposals use native change IDs. */
export const contractItemId = v.id('playbookItems');
export type ContractItemId = Infer<typeof contractItemId>;
