import { snapshot } from "@/lib/repository";
import { requireUser } from "@/lib/auth";
import { nextStatus, type Action } from "@agent-city/core";
import { newMission, advanceMission, newWorkspace } from "../actions";
import { Button } from "@/components/ui/button";
export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser();
  const data = await snapshot(user);
  const { error } = await searchParams;
  return (
    <>
      <div className="mb-8">
        <p className="text-sm font-bold uppercase tracking-widest text-primary">
          Mission control
        </p>
        <h1 className="mt-2 text-3xl font-semibold">
          A clear plan. Your permission.
        </h1>
        <p className="mt-3 text-slate-600">
          Personal and business missions, with a human approval gate before
          every simulated run.
        </p>
      </div>
      {error && (
        <p
          role="alert"
          className="mb-6 rounded border border-red-300 bg-red-50 p-4 text-red-800"
        >
          {error}
        </p>
      )}
      {data.workspaces.length === 0 ? (
        <form action={newWorkspace} className="panel max-w-lg">
          <h2 className="mb-4 text-xl font-semibold">
            Create your first workspace
          </h2>
          <label>
            Workspace name
            <input name="name" required minLength={2} maxLength={80} />
          </label>
          <Button>Create workspace</Button>
        </form>
      ) : (
        <div className="grid items-start gap-8 lg:grid-cols-[340px_1fr]">
          <section className="panel">
            <h2 className="mb-5 text-xl font-semibold">New mission</h2>
            <form action={newMission}>
              <label>
                Workspace
                <select name="workspaceId">
                  {data.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Mission title
                <input
                  name="title"
                  required
                  minLength={3}
                  maxLength={120}
                  placeholder="What should we achieve?"
                />
              </label>
              <label>
                Purpose
                <select name="kind">
                  <option value="personal">Personal</option>
                  <option value="business">Business</option>
                </select>
              </label>
              <label>
                Objective
                <textarea
                  name="objective"
                  required
                  minLength={10}
                  maxLength={4000}
                  rows={5}
                  placeholder="Describe the outcome and boundaries."
                />
              </label>
              <Button>Create draft</Button>
            </form>
          </section>
          <section aria-label="Missions">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Missions</h2>
              <span className="text-sm text-slate-600">
                {data.missions.length} total
              </span>
            </div>
            {!data.missions.length && (
              <div className="panel">
                <h3 className="font-semibold">
                  Your first mission starts here
                </h3>
                <p className="mt-2 text-sm text-slate-600">
                  Create a draft, submit it for review, then approve a mock run.
                  No activity is generated until you act.
                </p>
              </div>
            )}
            <div className="space-y-4">
              {data.missions.map((m) => (
                <article key={m.id} className="panel">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-lg font-semibold">{m.title}</h3>
                    <span className="rounded-full bg-muted px-3 py-1 text-xs font-bold uppercase">
                      {m.status.replaceAll("_", " ")}
                    </span>
                  </div>
                  <p className="mt-2 text-xs uppercase tracking-wide text-slate-500">
                    {m.kind} ·{" "}
                    {data.workspaces.find((w) => w.id === m.workspaceId)?.name}
                  </p>
                  <p className="my-4 whitespace-pre-wrap text-sm text-slate-700">
                    {m.objective}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ["submit", "Request approval"],
                        ["approve", "Approve mock run"],
                        ["reject", "Reject"],
                        ["start", "Start mock run"],
                        ["complete", "Complete mock run"],
                        ["fail", "Simulate failure"],
                        ["cancel", "Cancel"],
                      ] as [Action, string][]
                    )
                      .filter(([a]) => {
                        try {
                          nextStatus(
                            m.status,
                            a,
                            data.members.find(
                              (member) =>
                                member.workspaceId === m.workspaceId &&
                                member.userId === user,
                            )?.role ?? "member",
                            data.approvals.find((p) => p.missionId === m.id),
                          );
                          return true;
                        } catch {
                          return false;
                        }
                      })
                      .map(([a, label]) => (
                        <form action={advanceMission} key={a}>
                          <input type="hidden" name="id" value={m.id} />
                          <input type="hidden" name="action" value={a} />
                          <Button
                            variant={
                              a === "reject" || a === "fail"
                                ? "destructive"
                                : "outline"
                            }
                          >
                            {label}
                          </Button>
                        </form>
                      ))}
                  </div>
                  {m.status === "completed" && (
                    <p className="mt-4 text-sm text-primary">
                      Mock lifecycle completed. No agent work or external
                      actions were performed.
                    </p>
                  )}
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
