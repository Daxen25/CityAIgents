"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto max-w-xl p-10">
      <h1 className="text-2xl font-semibold">Unable to load Agent City</h1>
      <p className="my-4">
        Check the server configuration and database connection. Details are
        available in the server log.
      </p>
      <button onClick={reset}>Try again</button>
    </main>
  );
}
