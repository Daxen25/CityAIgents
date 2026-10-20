import { snapshot } from "@/lib/repository";
import { requireUser } from "@/lib/auth";
export default async function Activity() {
  const data = await snapshot(await requireUser());
  return (
    <>
      <h1 className="mb-3 text-3xl font-semibold">Activity</h1>
      <p className="mb-6 text-slate-600">
        Recorded user actions and mock lifecycle events. No synthetic production
        activity.
      </p>
      <section className="panel">
        {data.events.length ? (
          <ol className="divide-y divide-input">
            {data.events.map((e) => (
              <li key={e.id} className="py-3">
                <span className="font-mono text-sm">{e.event}</span>
                <p className="mt-1 text-xs text-slate-500">
                  Mission {e.missionId} · {e.createdAt}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p>
            No activity yet. Events appear when you create or update a mission.
          </p>
        )}
      </section>
    </>
  );
}
