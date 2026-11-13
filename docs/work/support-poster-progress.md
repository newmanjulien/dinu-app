# Support video poster

Scope: show an app-controlled image before Play, prepare it after primary paint, and keep calendar readiness independent.

Decisions:

- Add a required poster URL to configured videos and use a small local SVG placeholder.
- Extend the existing preparation coordinator with an image preload hint; use the browser's cache.
- Render the poster and an accessible Play button immediately; create the YouTube iframe only on activation.
- Preserve owner/paint gates, calendar caching, and player teardown. No new tests or browser automation.

Completed:

- Added a 600-byte SVG placeholder imported as a Vite asset URL, and an explicit `poster` URL for every configured video.
- The host asks the coordinator for a high-priority image preload after safe primary paint. The visible image uses that same URL, eager loading and high priority, without waiting for calendar or player readiness.
- Play replaces the poster with a privacy-enhanced YouTube iframe, requests playback, and moves focus into the player. Existing dialog teardown returns reopening to the poster.
- Updated delegation and activity documentation; retained independent calendar caching, provider preconnects, and ownership/paint guards.
- `npm run test:perf`: 7 files / 37 tests passed; existing cache, ownership, scheduling and saving guarantees retained. Log: `/tmp/oceans-support-poster-perf.log`.
- Existing `tests/lifecycle/csm-preload.test.ts`: 13 tests passed; paint gates, warm/read sharing, live receipt gating and ownership transitions retained. Log: `/tmp/oceans-support-poster-lifecycle.log`.
- `npm run build` passed: Svelte check reported zero errors/warnings, tools TypeScript check passed, and client/server production compilation plus the Vercel adapter completed. Confirmed the poster emits as a hashed external asset (`support-video-placeholder.Dj4uqEcZ.svg`) for browser reuse. Log: `/tmp/oceans-support-poster-build.log`.
- Targeted Prettier and diff whitespace checks passed. No new or expanded tests and no browser checks.

Unverified: browser image paint timing, keyboard focus behavior in a live iframe, one-click playback under browser/provider restrictions and real network latency. Existing tests do not assert the new poster/preload or playback path.

Complete: implementation, documentation, existing automated checks, build and final diff review.

Evidence: `csm-support.ts`, `csm-preload.svelte.ts`, `CsmDialogHost.svelte`, `CsmSupportVideo.svelte`, `docs/delegation.md`.
