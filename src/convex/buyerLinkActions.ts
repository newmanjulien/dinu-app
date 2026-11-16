'use node';
import { randomBytes } from 'node:crypto';
import { ConvexError, v, type Infer } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { linkPreparation, linkSummary } from './buyerValidators';
import { buyerCodeAlphabet, buyerCodeLength, buyerTokenCollision } from '../lib/buyer/token';

const args = {
	membershipId: v.id('memberships'),
	id: v.id('savedContracts'),
	preparation: linkPreparation
};
const unbiasedByteLimit = Math.floor(256 / buyerCodeAlphabet.length) * buyerCodeAlphabet.length;
function buyerCode() {
	let code = '';
	while (code.length < buyerCodeLength) {
		for (const byte of randomBytes(buyerCodeLength - code.length)) {
			if (byte < unbiasedByteLimit) code += buyerCodeAlphabet[byte % buyerCodeAlphabet.length];
		}
	}
	return code;
}

export const ensureLatest = action({
	args,
	returns: linkSummary,
	handler: async (ctx, args): Promise<Infer<typeof linkSummary>> => {
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				return await ctx.runMutation(internal.buyerLinks.capture, {
					...args,
					token: buyerCode()
				});
			} catch (error) {
				if (!(error instanceof ConvexError) || error.data !== buyerTokenCollision) throw error;
			}
		}
		throw new ConvexError('We couldn’t allocate a link code. Try again.');
	}
});
