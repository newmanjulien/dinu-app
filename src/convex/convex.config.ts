import { defineApp } from 'convex/server';
import { v } from 'convex/values';
import workpool from '@convex-dev/workpool/convex.config.js';
import rateLimiter from '@convex-dev/rate-limiter/convex.config';

const app = defineApp({
	env: {
		HUBSPOT_CLIENT_ID: v.optional(v.string()),
		HUBSPOT_CLIENT_SECRET: v.optional(v.string()),
		HUBSPOT_REDIRECT_URI: v.optional(v.string()),
		HUBSPOT_SCOPES: v.optional(v.string()),
		HUBSPOT_ENABLED: v.optional(v.string()),
		HUBSPOT_DELIVERY_ENABLED: v.optional(v.string()),
		CLERK_SECRET_KEY: v.optional(v.string()),
		CLERK_WEBHOOK_SIGNING_SECRET: v.optional(v.string()),
		CLERK_JWT_ISSUER_DOMAIN: v.optional(v.string()),
		CAL_WEBHOOK_SECRET: v.optional(v.string()),
		CAL_API_KEY: v.optional(v.string()),
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
