import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';
const crons = cronJobs();
crons.interval(
	'expire staged delegation attachments',
	{ minutes: 30 },
	internal.delegation.expireAttachments,
	{}
);
crons.interval(
	'expire delegation cancellations',
	{ minutes: 30 },
	internal.delegation.expireCancellations,
	{}
);
crons.interval(
	'expire unfinished baseline uploads',
	{ minutes: 30 },
	internal.baselineUploads.expirePrepared,
	{}
);
crons.cron(
	'clean orphan baseline files',
	'0 4 * * *',
	internal.baselineUploads.cleanOrphanFiles,
	{}
);
crons.interval(
	'reconcile Clerk accounts and resume cleanup',
	{ minutes: 15 },
	internal.clerk.reconcile,
	{}
);
export default crons;
