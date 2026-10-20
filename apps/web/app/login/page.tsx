import { login } from "../actions";
import { mode } from "@/lib/config";
import { Button } from "@/components/ui/button";
export const dynamic = "force-dynamic";
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const local = mode() === "mock";
  const { error } = await searchParams;
  return (
    <main className="mx-auto max-w-md px-6 py-24">
      <p className="text-sm font-bold tracking-widest text-primary">
        AGENT CITY / M0
      </p>
      <h1 className="my-5 text-3xl font-semibold">Your supervised workforce</h1>
      <p className="mb-8 text-slate-600">
        Plan missions. Review permissions. Stay in control.
      </p>
      <form action={login} className="panel">
        {error && (
          <p role="alert" className="mb-4 text-red-700">
            {error}
          </p>
        )}
        {local ? (
          <>
            <h2 className="mb-2 font-semibold">Local simulation</h2>
            <p className="mb-6 text-sm text-slate-600">
              Enter a single-user development workspace. This is mock
              authentication, not a production account. No AI work or external
              actions will run.
            </p>
          </>
        ) : (
          <>
            <label>
              Email
              <input
                name="email"
                type="email"
                required
                autoComplete="username"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
            </label>
          </>
        )}
        <Button type="submit">
          {local ? "Enter local workspace" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
