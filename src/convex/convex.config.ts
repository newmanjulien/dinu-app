import { defineApp } from 'convex/server';
import { v } from 'convex/values';
import rateLimiter from '@convex-dev/rate-limiter/convex.config';

const app = defineApp({
	env: {
		CLERK_SECRET_KEY: v.optional(v.string()),
		CLERK_WEBHOOK_SIGNING_SECRET: v.optional(v.string()),
		CLERK_JWT_ISSUER_DOMAIN: v.optional(v.string()),
		APP_URL: v.optional(v.string()),
		LOOPS_API_KEY: v.optional(v.string()),
		LOOPS_INVITATION_ID: v.optional(v.string()),
		LOOPS_APPROVAL_ID: v.optional(v.string()),
		LOOPS_DECISION_ID: v.optional(v.string())
	}
});

app.use(rateLimiter);
export default app;
