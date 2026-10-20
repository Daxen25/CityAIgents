# M0 architecture decisions

## ADR-001: Small monorepo, one web application

npm workspaces hold the Next.js app and shared TypeScript domain package. The Python
runtime has an independent uv environment and lockfile. Tailwind CSS handles styling;
a local shadcn/ui-style Button uses CVA, clsx and tailwind-merge. No component CLI or
large UI framework is needed at runtime. n8n is a future integration boundary only.
No separate backend API service is needed: Next.js server actions own web mutations.
The app uses server components by default and no browser Supabase client.

## ADR-002: Explicit local simulation

`AGENT_CITY_MODE` selects the repository adapter. Missing or invalid mode fails closed.
Mock mode offers a single developer identity through a signed, HTTP-only, SameSite=Strict
cookie; it is not a production authentication mechanism. Signing material is generated
server-side on process start. The local server binds to loopback, and production runtime
requires an explicit local-only override to allow mock mode. Do not expose mock mode to
untrusted users. JSON state is atomic-renamed synchronously within one Node process;
multiple processes, distributed storage and concurrent workers require PostgreSQL.
No initial missions, tasks, runs or activity are generated. All recorded mock activity
results from an explicit user action. The agent cards are definitions, not active agents.

Supabase mode validates identity with `auth.getUser()` on the server, rather than trusting
an unverified cookie or `getSession()` result. `proxy.ts` refreshes tokens and writes
cookies plus private/no-store response headers. Server actions use the per-request session
and the publishable key. No service-role key or model credential is sent to a client.

## ADR-003: Workspace-scoped, read-only direct table access

Workspaces have owner/member membership. Every tenant entity has a workspace ID, indexed
for policy lookup. Scoped foreign keys prevent attaching projects, agents, missions,
tasks, runs or artifacts from another workspace. RLS is enabled on every public table.
Only authenticated workspace members can read their workspace data. Template definitions
are intentionally shared read-only reference data for authenticated users.

Authenticated users have SELECT grants only. Mutations go through three narrow RPCs:
create workspace, create mission, transition mission. Privileged implementations live in
`private`, outside the exposed API schema, with fixed empty `search_path`, qualified table
references and revoked PUBLIC execution. Public wrappers are SECURITY INVOKER. Every
privileged mutation checks `auth.uid()` and current membership; no user-supplied actor or
role is trusted. New workspace ownership is assigned atomically to its creator; clients
cannot edit membership, approval records, runs, artifacts or audit events directly.
`private.workspace_role` avoids recursive membership policy evaluation.

Supabase's default privileged backend roles can bypass RLS; never expose those keys to the
app. Table owners are trusted migration administrators. Local database tests run as the
actual non-owner `authenticated`/`anon` roles to verify policies rather than bypass them.
The private Storage bucket grants member reads by the first object-path component (the
workspace UUID); M0 adds no upload/update/delete policy or storage write interface.

## ADR-004: Approval is an enforced lifecycle gate

```
draft -> awaiting_approval -> approved -> running -> completed
                    |                        |
                    +-> cancelled            +-> failed
```

Explicit actions are submit, approve, reject, start, complete, fail and cancel. Draft,
awaiting approval and approved states may be cancelled. Rejection cancels the mission.
Terminal states cannot restart. Only workspace owners decide pending approvals; any
workspace member may create, submit, cancel or operate an already approved mock run.
M0 permits an owner to approve their own mission (appropriate for personal use); a future
business separation-of-duties policy must be added explicitly rather than assumed.
Cancelling a mission makes any associated approval unusable through terminal-state checks.

The SQL transition RPC locks the mission row and writes state, approval, mock run and audit
event changes in a single transaction. Starting independently requires an approved
`mock_run` approval belonging to that workspace and mission, even if mission state was
corrupted. A run can complete only while running and only with the mock adapter. No API
accepts arbitrary status updates. Mock completion creates a labeled simulation artifact,
not fabricated research or software. Node and Python boundaries repeat permission checks.
Schema constraints reject unsupported statuses. TypeScript transition rules and SQL
transitions have behavior tests; they are deliberately duplicated across trust boundaries.

## ADR-005: Runtime prepared, external execution disabled

Python protocols and dataclasses define a versioned request/permission/result boundary.
The SDK is pinned and import-tested, but `OpenAIAgentsAdapter.execute` always raises
`NotImplementedError`. No web-to-worker transport, queue, model call, tool runner or n8n
workflow exists. External actions will need new granular approval scopes and per-action
checks; the existing `mock_run` approval cannot be reused. See runtime-contract.md.

## ADR-006: Reproducible validation without external credentials

npm direct dependencies are exact pins and package-lock.json locks transitive versions.
The Python manifest pins the SDK and uv.lock captures the full resolution. Setup uses
`npm ci` and `uv sync --frozen`; package/TLS/integrity verification stays enabled. Native
optional npm packages supply the Next.js/Tailwind binaries; arbitrary lifecycle scripts
are not needed for this repository and installation uses `--ignore-scripts`.
Next.js's standard TypeScript configuration skips third-party declaration checking while
strict checking remains enabled for application code.

PGlite executes the actual migration SQL and RLS in a PostgreSQL engine. Auth identity and
Storage schemas/functions are minimal test fixtures, so these tests do not prove GoTrue,
PostgREST, session refresh or Storage API compatibility. The HTTP smoke test exercises the
real Next.js app in local mock mode. A full local Supabase integration run is a remaining
acceptance condition before enabling Supabase for real users. No deployment is part of M0.

## Documentation verification

Reviewed current official Supabase documentation source on 2026-10-20:

- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
  ([source](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/database/postgres/row-level-security.mdx)):
  authenticated policies, auth.uid(), recursive membership policies, private security
  definer helpers and pinned search_path.
- [Creating a server-side client](https://supabase.com/docs/guides/auth/server-side/creating-a-client)
  ([source](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/auth/server-side/creating-a-client.mdx)):
  per-request SSR clients, Next.js 16 proxy, cookie refresh and cache-control headers.

The direct docs domain was blocked by this environment's egress proxy; the current source
was retrieved from the official repository through the permitted GitHub raw endpoint.
