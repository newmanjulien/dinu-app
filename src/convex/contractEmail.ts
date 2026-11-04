import { internalAction } from './_generated/server';
import { v } from 'convex/values';
import { emailAttempt } from './emailValidators';
import { deliverEmail } from './emailSender';
import { contractNotification } from './emailNotifications';

export const send = internalAction({
	args: emailAttempt.fields,
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		await deliverEmail(ctx, args, (config, delivery, selections) => {
			const event = delivery.event;
			if (event.kind === 'invitation')
				throw new Error('Invitations are sent by their inline worker.');
			return contractNotification(config.appUrl, event, selections);
		});
		return null;
	}
});
