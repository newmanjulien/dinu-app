# Tests

Tests are grouped by execution boundary, then feature. Existing performance and
snappiness checks are focused selections across these groups.

| Directory     | Purpose                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/`    | In-memory Convex operations, provider boundaries, Word generation and server endpoints. Files retain their Node or edge runtime.                |
| `client/`     | Client caches, scheduling, availability and download controllers. DOM-dependent files declare jsdom.                                            |
| `components/` | Browser-compiled Svelte owners, components and their lifecycle/interaction behavior in jsdom. Feature harnesses live beside the tests.          |
| `ssr/`        | Server-compiled pending frames and startup streams.                                                                                             |
| `support/`    | Shared synthetic data, controlled transport, Svelte scheduling, navigation and browser inputs. Feature-specific fixtures stay with their tests. |

No suite uses a real browser or live provider credentials. Controlled work counts,
ordering and ownership assertions do not measure real-world latency or appearance.

## Commands

| Command                    | Selection                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm test`                 | SSR → backend → client → components; every test file once.                                                      |
| `npm run verify`           | All tests, the focused performance checks, type checks, production build and emitted loading-module boundaries. |
| `npm run test:backend`     | All backend features.                                                                                           |
| `npm run test:hubspot`     | HubSpot installation, authorization, activity, delivery and Quotes.                                             |
| `npm run test:exports`     | Export acknowledgment/retention, Word actions/generation and buyer download endpoints.                          |
| `npm run test:client`      | All client state/controllers, including durable download acknowledgments.                                       |
| `npm run test:components`  | Svelte component/owner checks. Run SSR first for hydration.                                                     |
| `npm run test:ssr`         | Server rendering and startup streams; also generates the hydration fixture.                                     |
| `npm run test:perf`        | The original seven saving, creation, scheduling, caching, startup and CSM work/cost files.                      |
| `npm run test:snappiness`  | Component files ending in `snappiness.test.ts`.                                                                 |
| `npm run test:lifecycle`   | SSR → client → components.                                                                                      |
| `npm run test:loading:ssr` | Compatibility alias for `test:ssr`.                                                                             |

Append a path or filename filter to a direct suite command, for example:

```sh
npm run test:components -- tests/components/contracts
npm run test:backend -- saving.test.ts
```

## SSR and hydration ordering

`ssr/loading.test.ts` writes the actual server-rendered pending workspace HTML to
`.svelte-kit/loading-fixtures/workspace.html`. The component loading-boundary test
hydrates that exact HTML. The server and browser Svelte compilation modes require
separate configs, and SSR must run first. Use `npm test` or `test:lifecycle` for the
ordered run; for focused hydration work, run `test:ssr` before `test:components`.
Do not replace the generated HTML with a hand-written hydration fixture.

## Fixtures and assertions

Keep fixtures local unless multiple features need them. `support/transport.ts`
provides deferred responses and controlled subscriptions; `support/svelte.ts`
provides microtask settling and controlled animation frames; `support/document.ts`
provides synthetic document data. These helpers advance only the work explicitly
requested by a test.

The contract component suites share `components/contracts/fixtures.ts`, which
registers their mocks and cleanup. Import it before production modules in tests
that use it. The attachment test is independent of that fixture.

Preserve the existing performance assertions when refactoring saving, scheduling
or caching, and run `npm run test:perf`. Follow the repository's AGENTS.md policy
for adding tests and browser checks.
