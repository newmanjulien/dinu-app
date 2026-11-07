import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';
const crons = cronJobs();
crons.interval(
	'repair setup appointment status',
	{ minutes: 1 },
	internal.csmSetupAppointments.repairDue,
	{}
);
crons.interval(
	'expire unfinished baseline uploads',
	{ minutes: 30 },
	internal.baselineUploads.expirePrepared,
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
crons.interval('deliver HubSpot activity', { minutes: 1 }, internal.hubspotDelivery.pump, {});
crons.interval('expire HubSpot export bytes', { minutes: 5 }, internal.hubspotExports.expire, {});
crons.interval(
	'expire HubSpot install states',
	{ minutes: 15 },
	internal.hubspotCleanup.expireStates,
	{}
);
export default crons;
