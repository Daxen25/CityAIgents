# Agent City — M0 foundation

A minimal, supervised workforce application for personal and business missions. M0 runs
locally without credentials, with clearly labeled mock identity and execution. It never
runs external tools, starts real agents, or generates pretend production activity.

## Start locally

Prerequisites: **Node.js 24**, **Python 3.12**, **uv** (tested 0.12.23). Docker is optional,
only needed for the separate local Supabase integration workflow.

```bash
cd /workspace/CityAIgents  # or your own checkout path
bash scripts/setup.sh
npm run dev
```

Open your local application on port **3000** and choose **Enter local workspace**. There
is no username, password, API key, Supabase account or paid resource needed in mock mode.
The dev server binds to the loopback interface. This cloud onboarding interface does not
provide a web preview; HTTP checks can still validate it internally.

Setup preserves an existing `apps/web/.env.local`. If it already exists, set
`AGENT_CITY_MODE=mock` there to select local simulation. Never copy real secrets into
tracked files. Mock state is persisted to ignored `apps/web/.data/mock.json`. Mock sessions
expire after eight hours or a server restart; state persists. This file store supports one
Node process only. To isolate test data, set `AGENT_CITY_MOCK_DATA_DIR` to a separate local
folder when starting the server.

1. Create a mission with its workspace, purpose, title and objective.
2. Request approval, then explicitly approve or reject it.
3. Start the approved mock run and choose completion or simulated failure.
4. Inspect Activity to see only actions that actually happened.

Both mission kinds use the same workflow. Approval authorizes **only a mock run**. It
never grants permission to execute a tool, call a model, spend money or modify a system.

## Validate

```bash
npm run check  # TypeScript, Node/Postgres tests, Python tests, production build
# In a second terminal, while npm run dev is running:
npm run smoke
```

The smoke test requires local mock mode. It creates a clearly labeled test mission,
checks protected navigation, invalid sessions, scope denial, creation, approval/run
transitions, activity, agent definitions and logout. It intentionally retains the mission
as an audit record. For clean manual development, start its server with a separate
`AGENT_CITY_MOCK_DATA_DIR`.

Production build verification (still local simulation; never deploy this configuration):

```bash
npm run build
AGENT_CITY_MODE=mock AGENT_CITY_ALLOW_LOCAL_MOCK=true npm start
```

Production mode refuses mock authentication unless the explicit local-only override is
set. `npm run dev` does not need the override. The mock store and authentication are not
suitable for production or shared hosting.

## M0.4 authenticated workflow

See [the M0.4 browser checklist](docs/m0.4-authentication-persistence.md) for exact sign-in,
workspace/mission creation, persistence, refresh and logout steps. The Agents page now
reads stored definitions in Supabase mode. The application transport is tested against
an isolated local HTTP fixture (`npm run test:auth-persistence`); hosted signed-in
acceptance still requires an existing confirmed account. Stop development servers before
running that test. It never uses the hosted project or real credentials.

## Existing hosted Supabase project

Project **atbksxlqgfxvetsgusek** is reachable and its publishable key is accepted.
The user confirmed M0.3 database activation. Remote versions differ from the original
local filenames: **do not reapply the foundation or run migration repair**. See the
[current integration report and reconciliation plan](docs/m0.3-post-activation.md).
Signed-in verification still requires an existing user session; no remote writes were
performed during the post-activation checks.

Set these in secure environment settings or ignored `apps/web/.env.local`:

```dotenv
AGENT_CITY_MODE=supabase
SUPABASE_URL=https://atbksxlqgfxvetsgusek.supabase.co
SUPABASE_PROJECT_REF=atbksxlqgfxvetsgusek
SUPABASE_PUBLISHABLE_KEY=<project publishable key or legacy anon key>
```

Restart the app after changing variables. Use your existing Supabase email/password
account. Do not put a service-role/secret key here; configuration rejects privileged keys.
The environment must allow HTTPS to `atbksxlqgfxvetsgusek.supabase.co`.

```bash
npm run verify
```

This command performs GET requests only. An optional `SUPABASE_VERIFY_ACCESS_TOKEN`
provided securely lets it verify an **existing** user session and a zero-row database
SELECT. It never signs in, refreshes tokens, calls mutation RPCs, or applies migrations.
Without a valid existing session, signed-in verification remains incomplete (exit code 2).
It logs status codes, never keys, tokens, user records or response bodies. Migration history
requires separate SQL access; a publishable key cannot read internal migration catalogs.

See [Supabase connection report](docs/supabase-connection.md) for the migration preflight,
workspace ownership/security review and approval-gated application procedure.

## Supabase mode (optional; not required for local mock development)

Migrations are in `supabase/migrations`. The hosted project is already activated, as
reported by the user. Do not replay those files, run remote `db push`, or deploy without
a reviewed reconciliation plan and approval.
For a disposable **local** stack with Docker, use the pinned CLI:

```bash
npx --yes supabase@2.121.0 start
npx --yes supabase@2.121.0 db reset --local
npx --yes supabase@2.121.0 status
```

`db reset --local` destroys data in that local Supabase instance and applies migrations;
use it only for a disposable development stack. These optional CLI steps have not been
executed as part of M0. Auth and Storage are emulated only in database tests, not validated
against a complete Supabase service stack.

Configure `apps/web/.env.local` from the local stack's status:

```dotenv
AGENT_CITY_MODE=supabase
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_PUBLISHABLE_KEY=<your local publishable key or legacy anon key>
```

Use an existing confirmed Supabase email/password account. The M0 UI implements sign-in
and sign-out; sign-up, password recovery and user administration are deferred. For a local
stack, create a test Auth user in local Studio, then sign in and create your first
workspace in the app. Workspace creation assigns you its owner role and seeds three
disabled agent instances. There is no invitation/membership-management UI yet.

`SUPABASE_PUBLISHABLE_KEY` is a public application identifier, not a service-role key. All
Supabase traffic in M0 comes from server code with the user's session. **Do not configure
a service-role key.** No OpenAI key is required; the Python real adapter is disabled.
No values are embedded in frontend code. Supabase Auth refreshes use cookie-aware SSR
clients and a Next.js proxy; authenticated responses are marked private/no-store.

## Repository map

- `apps/web`: Next.js App Router, TypeScript, Tailwind, local shadcn/ui Button component,
  server actions, session checks and mock/Supabase repository adapters.
- `packages/core`: Zod input schemas, typed statuses, transition rules and agent templates.
- `services/runtime`: pinned OpenAI Agents SDK, Python contracts, mock adapter and disabled
  real adapter; `uv.lock` captures Python dependencies.
- `supabase`: configuration, three ordered migrations and an intentionally empty seed file.
- `tests`: database behavior and RLS tests using embedded PostgreSQL (PGlite).
- `scripts`: repeatable dependency setup and HTTP smoke checks.
- `docs`: architecture, runtime boundary, verification evidence and acceptance checklist.

See [Architecture decisions](docs/architecture.md), [Runtime contract](docs/runtime-contract.md)
and [M0 acceptance report](docs/m0-report.md). n8n and external integrations are reserved
for later milestones; no daemon or integration is installed for M0.
