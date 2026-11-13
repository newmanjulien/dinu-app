import { defineApp } from 'convex/server';
import { v } from 'convex/values';
import workpool from '@convex-dev/workpool/convex.config.js';
import rateLimiter from '@convex-dev/rate-limiter/convex.config';

const app = defineApp({
	env: {
		BUYER_LINK_INGEST_SECRET: v.optional(v.string()),
		HUBSPOT_CLIENT_ID: v.optional(v.string()),
		HUBSPOT_CLIENT_SECRET: v.optional(v.string()),
		HUBSPOT_REDIRECT_URI: v.optional(v.string()),
		HUBSPOT_SCOPES: v.optional(v.string()),
		HUBSPOT_ENABLED: v.optional(v.string()),
		HUBSPOT_QUOTES_ENABLED: v.optional(v.string()),
		HUBSPOT_QUOTES_PUSH_ENABLED: v.optional(v.string()),
		HUBSPOT_DELIVERY_ENABLED: v.optional(v.string()),
		HUBSPOT_APP_ID: v.optional(v.string()),
		HUBSPOT_JOURNAL_ENABLED: v.optional(v.string()),
		CLERK_SECRET_KEY: v.optional(v.string()),
		CLERK_WEBHOOK_SIGNING_SECRET: v.optional(v.string()),
		CLERK_JWT_ISSUER_DOMAIN: v.optional(v.string()),
		CAL_WEBHOOK_SECRET: v.optional(v.string()),
		CAL_API_KEY: v.optional(v.string()),
		CAL_EVENT_TYPE_ID: v.optional(v.string()),
		CAL_ORGANIZER_ID: v.optional(v.string()),
		CAL_METADATA_SIGNING_SECRET: v.optional(v.string()),
		CAL_LEGACY_METADATA_SECRET: v.optional(v.string()),
		APP_URL: v.optional(v.string()),
		LOOPS_API_KEY: v.optional(v.string()),
		LOOPS_INVITATION_ID: v.optional(v.string()),
		LOOPS_APPROVAL_ID: v.optional(v.string()),
		LOOPS_DECISION_ID: v.optional(v.string())
	}
});

app.use(rateLimiter);
app.use(workpool, { name: 'hubspotPool' });
export default app;
