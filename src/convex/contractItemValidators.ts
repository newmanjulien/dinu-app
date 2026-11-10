import { v } from 'convex/values';
import { playbookItem } from '../lib/playbook/validators';
import { contractItemId } from '../lib/contract/item-identity';

export const contractItem = playbookItem.extend({
	_id: contractItemId,
	_creationTime: v.number(),
	companyId: v.id('company'),
	contentRevision: v.number()
});
export const contractConcession = playbookItem.extend({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	contentRevision: v.number(),
	proposalId: v.string()
});
