import { listAgentDefinitions } from "@/lib/repository";
import { requireUser } from "@/lib/auth";
export default async function Agents() {
  await requireUser();
  const definitions = await listAgentDefinitions();
  return (
    <>
      <h1 className="text-3xl font-semibold">Agent definitions</h1>
      <p className="my-4 text-slate-600">
        Versioned templates. No live agents or external tools are active in M0.
      </p>
      {!definitions.length && (
        <p>No agent definitions are available in this workspace service.</p>
      )}
      <div className="grid gap-5 md:grid-cols-3">
        {definitions.map((a) => (
          <article className="panel" key={a.key}>
            <span className="text-xs font-bold text-primary">
              DEFINITION · V{a.version}
            </span>
            <h2 className="my-3 text-xl font-semibold">{a.name}</h2>
            <p className="text-sm text-slate-600">{a.description}</p>
          </article>
        ))}
      </div>
    </>
  );
}
