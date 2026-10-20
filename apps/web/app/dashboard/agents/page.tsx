import { agentDefinitions } from "@agent-city/core";
export default function Agents() {
  return (
    <>
      <h1 className="text-3xl font-semibold">Agent definitions</h1>
      <p className="my-4 text-slate-600">
        Version 1 templates. No live agents or external tools are active in M0.
      </p>
      <div className="grid gap-5 md:grid-cols-3">
        {agentDefinitions.map((a) => (
          <article className="panel" key={a.key}>
            <span className="text-xs font-bold text-primary">
              DEFINITION · V1
            </span>
            <h2 className="my-3 text-xl font-semibold">{a.name}</h2>
            <p className="text-sm text-slate-600">{a.description}</p>
          </article>
        ))}
      </div>
    </>
  );
}
