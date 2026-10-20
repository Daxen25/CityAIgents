# M0 acceptance report

## Changes

The initial repository contained only a two-line README. This increment adds the complete
monorepo described in README.md: root npm workspace/configuration/lockfile; Next.js app,
server auth, server actions, dashboard pages, repository adapters and shadcn-compatible
UI configuration; shared schemas/transitions and tests; Python runtime manifest/lockfile,
contracts/adapters/tests; SQL migrations/config/seed; setup/smoke scripts and architecture
and runtime documentation. README.md is replaced with local setup instructions. No existing
application or user configuration was overwritten. No secrets or generated state are tracked.

## Database migrations

1. `202610200001_foundation.sql`: workspaces, memberships, projects, agent definitions,
   workspace agents, missions, tasks, approvals, runs, artifacts, activity events; scope
   indexes, constraints, RLS, private permission functions and three mutation RPCs.
2. `202610200002_agent_definitions.sql`: v1 Chief of Staff, Researcher and Developer
   templates. New workspaces receive disabled instances. No production activity is seeded.
3. `202610200003_storage.sql`: private artifacts bucket and workspace member read policy.
   No client upload, update or delete policy is created in M0.

These are committed-source candidates for review, not remotely applied migrations.

## Acceptance criteria

| Criterion                                             | Current result                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Monorepo foundation and architecture documented       | Satisfied                                                                                           |
| Authenticated dashboard navigation                    | Verified with signed local mock sessions; Supabase SSR implementation added, integration unverified |
| Versioned tables for all requested entities           | Satisfied; migrations execute in embedded PostgreSQL                                                |
| Secure workspace RLS and scoped references            | Behavioral SQL tests pass under authenticated/anon roles; live Supabase integration remains         |
| Mission creation and listing                          | Verified over HTTP in local mock mode; Supabase RPC/repository path implemented                     |
| Chief of Staff, Researcher, Developer definitions     | Satisfied; versioned templates, no active/fake agents                                               |
| Deterministic mock execution with status transitions  | Satisfied; explicit approval, start, completion/failure/cancellation                                |
| Interfaces for real Python runtime                    | Satisfied; SDK import tested; real execution explicitly disabled                                    |
| Automated authorization, lifecycle and approval tests | Satisfied; domain, PostgreSQL and Python checks plus HTTP smoke                                     |
| External integrations, deployment or paid resources   | None created or executed                                                                            |

## Test results

- Lockfile-only setup rerun succeeded (`npm ci --ignore-scripts`, `uv sync --frozen`).
- Node/domain/PostgreSQL/configuration suite: 21 tests passed, zero failed/skipped.
- Python runtime boundary and SDK import: 4 tests passed.
- TypeScript strict application checks and Next.js production build passed.
- HTTP mock smoke passed for protected navigation, forged sessions, workspace denial,
  mission creation, approval/run completion, activity, definitions and logout.
- Hosted Supabase checks remain blocked; see [connection report](supabase-connection.md).

## Verification and limitations

The automated suite runs real migration SQL with emulated auth/storage fixtures in PGlite,
not a full Supabase stack. No live Supabase project credentials were available/configured.
Supabase sign-in, token refresh, PostgREST RPC invocation and Storage API behavior still
need end-to-end validation. The local CLI commands in README.md are optional and unrun.
No deployment has been attempted or claimed.

Mock identity is intentionally single-user and development-only; its JSON store requires
one process. Mock runs require explicit UI actions; no scheduler, actual research, actual
code generation or background agent orchestration exists. Project/task/artifact management
UIs, invitations, signup/recovery, real tools, n8n and multi-user governance are deferred.
An owner can approve their own mission. Runtime transport serialization is documented but
not implemented. No external action permission scope is enabled in the database.

## Environment variables

- `AGENT_CITY_MODE=mock`: all that is needed for development, supplied by setup.
- `AGENT_CITY_MODE=supabase`: selects server-side Supabase Auth and persistence.
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`: only for Supabase mode; use an existing
  confirmed email/password Auth account. Never configure a service-role key for the web app.
- `AGENT_CITY_ALLOW_LOCAL_MOCK=true`: opt-in only for testing the production build locally.
- `AGENT_CITY_MOCK_DATA_DIR`: optional separate mock data directory for smoke testing.
- `SMOKE_BASE_URL`: optional loopback HTTP origin for the smoke script (default port 3000).

No OpenAI key or n8n credential is needed in M0. Secret values belong in ignored local
configuration or secure environment settings, not chat or tracked files.

## Next increment (requires approval)

First validate this foundation against a disposable local Supabase stack: migrations,
real Auth sessions/refresh, RPC calls and Storage authorization, with two separate users.
Then define M1 tool permission scopes, worker transport and idempotency before implementing
any real agent orchestration. Stop at M0 now; no external database changes or deployment
are authorized.
