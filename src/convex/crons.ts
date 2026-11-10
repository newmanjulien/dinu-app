import { terminologyTransition } from './terminologyMaintenance';
import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';
const crons = cronJobs();
if (!terminologyTransition) {
	crons.cron('expire buyer activity', '0 3 * * *', internal.buyerActivity.expire, {});
	crons.interval(
		'expire buyer activity quotas',
		{ minutes: 1 },
		internal.buyerActivityQuota.expire,
		{}
	);
	crons.interval(
		'repair setup appointment status',
		{ minutes: 1 },
		internal.csmSetupAppointments.repairDue,
		{}
	);
	crons.interval(
		'expire unfinished template source uploads',
		{ minutes: 30 },
		internal.templateUploads.expirePrepared,
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
	crons.interval('continue HubSpot quote pushes', { minutes: 1 }, internal.hubspotQuotes.pump, {});
	crons.interval(
		'expire HubSpot quote payloads',
		{ minutes: 15 },
		internal.hubspotQuotes.expire,
		{}
	);
	crons.interval('deliver HubSpot activity', { minutes: 1 }, internal.hubspotDelivery.pump, {});
	crons.interval('finish HubSpot removals', { minutes: 1 }, internal.hubspotUninstall.resume, {});
	crons.interval(
		'read HubSpot installation lifecycle',
		{ minutes: 1 },
		internal.hubspotJournal.poll,
		{}
	);
	crons.interval('expire HubSpot export bytes', { minutes: 5 }, internal.hubspotExports.expire, {});
	crons.interval(
		'expire HubSpot install states',
		{ minutes: 15 },
		internal.hubspotCleanup.expireStates,
		{}
	);
}
export default crons;
