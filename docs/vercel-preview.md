# M0.4 HTTPS browser preview through Vercel

This Codex session exposes no supported browser-preview or port-forwarding tool. Environment
publication does not host the Next.js website. No accessible preview URL can be issued here.
This guide does not perform deployments or Supabase setting changes.

## 1. Make this task's code available on GitHub

Use the Codex/GitHub PR workflow to publish the current changes to `Daxen25/CityAIgents`
and merge the reviewed branch, or select that branch explicitly in Vercel. Importing
main before the PR is merged will not include the M0.4 changes. Include the shared
package, root package-lock.json,
web app, and current Auth/persistence fixes. Never include `.env.local` or token values.
Do not add migration execution to a build, install command or GitHub workflow.

## 2. Import/configure in Vercel, then deploy manually

| Setting | Value |
| --- | --- |
| Repository | `Daxen25/CityAIgents`, branch containing the current changes |
| Root Directory | `apps/web` |
| Include source files outside Root Directory in Build Step | Enabled; required for `packages/core` and the workspace lockfile |
| Framework Preset | Next.js |
| Node.js | 24.x |
| Install Command | `cd ../.. && npm ci --ignore-scripts` |
| Build Command | `npm run build` (runs `next build` inside `apps/web`) |
| Output Directory | Leave Next.js framework default (`.next`) |

Existing `next.config.ts` already transpiles `@agent-city/core`. No vercel.json, static
export, custom start command, Python runtime or n8n service is needed. Vercel hosts the
Next.js server functions; it does not run the loopback-bound local start script.
`npm run check` is a development/CI command, not the Vercel build command.

Before pressing Deploy, enter these Environment Variables in Vercel for **Preview** and,
if deploying the stable project domain, **Production**:

```dotenv
AGENT_CITY_MODE=supabase
AGENT_CITY_ALLOW_LOCAL_MOCK=false
SUPABASE_URL=https://atbksxlqgfxvetsgusek.supabase.co
SUPABASE_PROJECT_REF=atbksxlqgfxvetsgusek
SUPABASE_PUBLISHABLE_KEY=<project publishable key or legacy anon key>
```

Enter the actual key directly in Vercel settings. Codex environment values do not
transfer automatically. Do not add a service-role/secret key, OpenAI key, test credentials,
verification access token or the Codex HTTPS proxy variables. No NEXT_PUBLIC variables
are required. Missing/invalid mode fails closed; Supabase errors never fall back to mock.

You perform the deployment manually. After Vercel reports Ready, copy its actual HTTPS
Visit URL; a URL cannot be predicted or claimed working before deployment. Keep preview
access limited to intended testers using the available Vercel protection settings.
Environment changes require a new deployment to take effect.

## 3. Supabase Auth URL configuration

Remote Auth URL configuration cannot be inspected or changed with the publishable key.
In Supabase project `atbksxlqgfxvetsgusek`, open Authentication -> URL Configuration:

- For a dedicated Agent City project, set Site URL to the exact stable deployed HTTPS
  origin (no localhost). If an existing production application shares this project,
  preserve its Site URL and use the Redirect URLs allowlist for this preview instead.
- Add the actual selected HTTPS preview origin and its `/**` path pattern to Redirect URLs,
  e.g. `https://<actual-deployment-host>/**`. Replace the placeholder with Vercel's real
  hostname. Add each new deployment origin you intend to use; avoid a blanket
  `https://*.vercel.app/**` allowance.
- The implemented email/password `signInWithPassword` flow returns directly to a server
  action and does not require an OAuth/email callback route or redirect allowlist entry.
  These settings are for correct email-link origins and future redirects; no
  `/auth/callback`, signup, password-recovery or OAuth handler is implemented in M0.4.
- Use an existing confirmed email/password account. No account needs to be created or
  changed by this deployment preparation.

## 4. HTTPS cookie and acceptance checks

Both the SSR action client and refresh proxy now set `Secure` on cookies in production.
Supabase's existing SameSite=Lax, Path=/ and host-only scope are preserved. No cookie
Domain override is needed; never set it to the Supabase hostname or `.vercel.app`.
Each preview hostname has a separate browser session, so sign in on the URL being tested.
The SDK's default HttpOnly=false remains unchanged. Auth is verified with server-side
`getUser()`, and session responses prohibit caching. Real hosted refresh/logout still
need browser acceptance; the code's local HTTP fixture tests already cover these flows.

After deployment, on the actual HTTPS URL:

1. Open `/login`: expect email/password fields, no mock-entry button. Unauthenticated
   `/dashboard` must redirect to login.
2. Sign in with the existing confirmed account. Confirm the SUPABASE banner and three
   persisted agent definitions. Inspect cookies locally for Secure and SameSite=Lax;
   do not share their values.
3. Follow `docs/m0.4-authentication-persistence.md` to create a workspace and test mission,
   reload, approve and complete a mock lifecycle, then sign out and sign in again.
4. Verify refresh across access-token expiry and protection after logout. Confirm records
   persist, no unrelated workspace appears, and no real AI work executes.

Deployment readiness and these browser checks remain unverified until you deploy and
visit the actual URL. Do not rerun migrations or alter migration history for deployment.
