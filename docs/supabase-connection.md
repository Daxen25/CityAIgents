# Existing Supabase project connection

> Historical pre-activation report. Database activation has since been confirmed by the
> user under different remote version IDs. Follow [the current reconciliation plan](m0.3-post-activation.md);
> do not execute the old activation/application instructions again.

Project: `atbksxlqgfxvetsgusek`

API origin: `https://atbksxlqgfxvetsgusek.supabase.co`

## Minimal changes

Reused the existing M0 server client, Next.js proxy, Supabase repository and three SQL
migrations. No replacement schema or migration was generated. Added project-aware URL
validation and a guard rejecting privileged keys, validated password login inputs and
handled sign-out errors. Added a read-only verification script, configuration tests and
catalog inspection SQL. The known project origin/ref were added to ignored local
configuration; local mock mode remains usable until credentials/network access are ready.

Supabase clients read `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`; optional
`SUPABASE_PROJECT_REF` detects accidental project mismatch. A publishable key is the
intended API identifier. A legacy anon JWT is accepted only with the anon role and,
when present, a matching project-ref claim. This key parsing is a configuration guard,
not JWT authentication. Supabase Auth verifies actual user tokens server-side.
No service-role or management token is needed for the app. No credential values were
printed, embedded in frontend code, or added to tracked files.

## Security and ownership review (local implementation)

- Every application table has RLS. Tenant tables filter on the caller's workspace
  membership. Agent templates are intentionally shared authenticated reference data.
- Authenticated clients have SELECT grants only. Workspace/mission creation and state
  transitions go through narrow RPCs with checked `auth.uid()` and current membership.
- Private SECURITY DEFINER functions have empty pinned search paths and qualified
  references; exposed RPC wrappers are SECURITY INVOKER. PUBLIC execution is revoked.
- Workspace creation atomically assigns its creator the owner role. Clients cannot
  insert, modify or delete memberships, change ownership, or forge approvals/runs/events.
  There is no ownership-transfer or invitation UI in M0. Privileged database admins are
  trusted and can alter these records; the application never uses those privileges.
- Owners decide approvals. An owner may approve their own mission; member roles cannot
  approve/reject. Members may operate an already approved mock lifecycle. No mock
  permission enables external execution. Terminal missions cannot restart.
- Composite workspace foreign keys block cross-workspace entity references. Mission
  transitions use row locking and transactional approval/run/event writes.
- Supabase password authentication uses cookie-aware SSR and `auth.getUser()` checks.
  Proxy responses are private/no-store; invalid sessions cannot reach dashboard actions.
  Mock cookies are ignored entirely in Supabase mode. Sign-out targets the current session.
- The artifacts bucket migration requests a private bucket and adds a workspace read
  policy. It intentionally adds no upload/update/delete policy. On an **existing** project,
  a pre-existing public bucket or broad Storage policy can bypass these intentions:
  inspect them before applying. `ON CONFLICT DO NOTHING` does not privatize an existing
  bucket. Existing grants/policies/functions and exposed schemas must be compared, not
  assumed to match this repository. In particular, keep `private` out of exposed schemas.

The local migration tests pass; this review does not establish that remote RLS, ownership,
Auth settings, grants or Storage configuration currently match the repository.

## Verification evidence and blockers

- Inspected runtime variable names/presence and environment draft requirements. No
  Supabase publishable/anon key, access token, database URL or DB password was provided.
- No Supabase connector is available in this session.
- A read-only GET to the project's Auth health endpoint failed at the egress proxy:
  CONNECT rejected with HTTP 403; no upstream Supabase response was received. A second
  attempt after saving the network requirement was also blocked, so draft persistence
  has not changed the running network policy.
- `npm run verify:supabase` correctly reports missing configuration and exits 2.
  Live database connectivity, sign-in, token refresh and authenticated SELECT remain
  unverified. No remote database SQL, migration, user creation or mutation RPC was run.
- Environment draft saved: project origin, project mode, publishable-key requirement and
  exact project-host egress allowance. Values must be entered securely in settings;
  saving a draft does not apply it to this running machine or publish it.

## Migration status: remote history unknown

| Local version  | Purpose                                                       | Remote pending status |
| -------------- | ------------------------------------------------------------- | --------------------- |
| `202610200001` | Foundation tables, indexes, scoped foreign keys, RLS and RPCs | Unknown               |
| `202610200002` | Three v1 agent definitions                                    | Unknown               |
| `202610200003` | Private artifacts bucket and member read policy               | Unknown               |

Do not assume all three are pending just because this environment has no credentials.
Do not recreate objects, replay applied SQL or use migration repair to conceal drift.
A publishable key does not grant access to `supabase_migrations.schema_migrations`.
Use `supabase/inspect.sql` with the project's SQL editor or an authorized read-only
connection to retrieve migration versions, RLS, grants, function definitions, constraints
and bucket privacy. It contains SELECT statements only. If the migration-history schema
is absent, run the remaining queries separately and inspect existing objects; absent
history alone does not establish an empty schema. Share version IDs/metadata only, never
credentials, if a reviewer needs to compare the results.

## How to apply, only after explicit approval

1. Inspect remote migration history and existing schema with the read-only SQL file.
   Compare every local object and check existing broad policies/grants and bucket privacy.
2. In a secure terminal, use the pinned Supabase CLI with an authorized database
   connection to list migration history and preview changes. Supply the connection URL
   securely as `SUPABASE_DB_URL`, never in source, chat or a pasted shell literal:

   ```bash
   npx --yes supabase@2.121.0 migration list --db-url "$SUPABASE_DB_URL"
   npx --yes supabase@2.121.0 db push --dry-run --db-url "$SUPABASE_DB_URL"
   ```

3. Review the exact pending set and SQL, preserve existing data and obtain approval for
   that concrete change. If existing objects conflict, prepare a separate reviewed
   additive reconciliation migration; do not reset the project or recreate working tables.
4. **Only after approval**, apply the reviewed pending migrations with the same pinned
   CLI (`db push --db-url "$SUPABASE_DB_URL"`). Never use `db reset` on this hosted project.
5. Re-read migration history and policies; verify real Auth, owner/member separation,
   workspace isolation and application flows. Do not infer success from command submission.

The CLI procedures above are documented only; none has been run against this project.
No additional remote database approval is being requested now because the pending set
cannot yet be established. First supply the publishable key securely and enable the
saved network allowance; read-only migration metadata is also required for exact status.
