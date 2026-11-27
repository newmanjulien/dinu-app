import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();
crons.interval('recover due work', { minutes: 10 }, internal.recovery.sweep, {});
crons.cron('expire buyer activity quotas', '45 3 * * *', internal.buyerActivityQuota.expire, {});
crons.cron('prune expired receipts', '30 3 * * *', internal.operationReceipts.pruneExpired, {});
crons.cron('clean completed booking evidence', '15 3 * * *', internal.csmEvidence.cleanup, {});
crons.cron('expire buyer activity', '0 3 * * *', internal.buyerActivity.expire, {});
crons.interval(
	'expire unfinished template source uploads',
	{ minutes: 30 },
	internal.templateSetup.expirePending,
	{}
);
crons.cron(
	'clean orphan storage files',
	'0 4 * * *',
	internal.storageOwnership.cleanOrphanFiles,
	{}
);
crons.interval(
	'reconcile Clerk accounts and resume cleanup',
	{ minutes: 15 },
	internal.clerk.reconcile,
	{}
);
crons.interval('expire HubSpot quote payloads', { minutes: 15 }, internal.hubspotQuotes.expire, {});
crons.interval(
	'read HubSpot installation lifecycle',
	{ minutes: 5 },
	internal.hubspotJournal.probe,
	{}
);
crons.interval('expire export bytes', { minutes: 5 }, internal.contractExports.expire, {});
crons.interval(
	'expire HubSpot install states',
	{ minutes: 15 },
	internal.hubspotCleanup.expireStates,
	{}
);
export default crons;
