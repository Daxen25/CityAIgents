// Integration fixture: real Next.js routes + Supabase SDK over loopback HTTP.
// Uses synthetic credentials and in-memory service data, NEVER the hosted project.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const planningTest = process.argv.includes("--planning");
const extensionTest=process.argv.includes("--extensions");
let extensionProviderFailure=false;
const extensionDocument={summary:"Offline additive proposal",tasks:[{title:"Additional fixture research",description:"Follow-up scope only",priority:"medium",suggested_agent_role:"researcher",expected_deliverable:"New input-derived brief",dependencies:[]},{title:"Additional prototype",description:"Future design only",priority:"low",suggested_agent_role:"developer",expected_deliverable:"Prototype proposal",dependencies:[]}]};
const researcherTest = process.argv.includes("--researcher");
const researcherRetry = process.argv.includes("--researcher-retry");
let transient503Remaining=researcherRetry?1:0;
const orchestrationTest = process.argv.includes("--orchestration") || researcherTest || extensionTest;
const finalizerUnavailable = process.argv.includes("--finalizer-unavailable");
const persistenceFailure = process.argv.includes("--persistence-failure") || finalizerUnavailable;
const provider = process.argv.includes("--openai") ? "openai" : "gemini";
const planningModel = provider === "gemini" ? "gemini-flash-latest" : "gpt-4.1-mini";
const root = fileURLToPath(new URL("../", import.meta.url));
const uid = "11111111-1111-4111-8111-111111111111",
  wid = "22222222-2222-4222-8222-222222222222",
  mid = "33333333-3333-4333-8333-333333333333";
const user = {
  id: uid,
  aud: "authenticated",
  role: "authenticated",
  email: "fixture@example.test",
  email_confirmed_at: "2026-01-01T00:00:00Z",
  app_metadata: {},
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
};
const state = {
  workspaces: [],
  missions: [],
  approvals: [],
  workspace_members: [],
  activity_events: [],
  mission_extensions:[],mission_extension_reviews:[],
};
const calls = [];
const planningMid = "55555555-5555-4555-8555-555555555555";
const planningRid = "66666666-6666-4666-8666-666666666666";
const offlinePlan = { summary: "Offline fixture plan", tasks: [{ title: "Review fixture evidence", suggested_agent_role: "researcher", expected_deliverable: "Human-reviewed fixture report" }, { title: "Review implementation proposal", suggested_agent_role: "developer", expected_deliverable: "Human-reviewed implementation outline" }], risks: ["Fixture evidence only"] };
const offlineResearch = { summary:"Offline generated requirements brief", requirements:[{title:"Fixture requirement",description:"Derived from the approved task only",acceptance_criteria:["Owner reviews this brief"]}],assumptions:[],open_questions:["What constraints apply?"],limitations:["No browsing or external verification"],sources:[],verification:"not_externally_verified" };
let researcherProviderFailure=false, researcherStartFailure=false;
let providerCalls = 0;
let planningHash;
if (planningTest || orchestrationTest) {
  state.artifacts = []; state.runs = []; state.tasks = []; state.task_plan_reviews = []; state.agents = []; state.task_execution_reviews = []; state.task_execution_authorizations = [];
}
function persistFixturePlan(missionId, runId) {
  state.artifacts.push({ id: crypto.randomUUID(), mission_id: missionId, run_id: runId, kind: "chief_of_staff_plan", content: offlinePlan });
  offlinePlan.tasks.forEach((task,index) => state.tasks.push({
    id: crypto.randomUUID(), workspace_id: wid, mission_id: missionId, plan_run_id: runId,
    title: task.title, suggested_agent_role: task.suggested_agent_role, expected_deliverable: task.expected_deliverable,
    proposal_position: index+1, status: "proposed", agent_id: null, review_id: null,
  }));
}
let refreshes = 0,
  logouts = 0,
  serial = 0,
  activeToken = "";
const jwt = () =>
  `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: uid, role: "authenticated", aud: "authenticated", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, jti: String(++serial) })).toString("base64url")}.fixture-signature`;
function session() {
  activeToken = jwt();
  return {
    access_token: activeToken,
    refresh_token: "fixture-refresh-token",
    token_type: "bearer",
    expires_in: 3600,
    user,
  };
}
const fixture = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    let raw = "";
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ path: url.pathname, method: req.method, body });
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    if (url.pathname === "/auth/v1/token") {
      if (url.searchParams.get("grant_type") === "password") {
        if (
          body.email !== "fixture@example.test" ||
          body.password !== "fixture-password"
        )
          return send(400, {
            code: "invalid_credentials",
            msg: "Invalid login credentials",
          });
        return send(200, session());
      }
      assert.equal(url.searchParams.get("grant_type"), "refresh_token");
      assert.equal(body.refresh_token, "fixture-refresh-token");
      refreshes++;
      return send(200, session());
    }
    if (url.pathname === "/openai-fixture") {
      assert.ok(planningTest);
      assert.equal(provider, "openai");
      assert.equal(req.headers.authorization, "Bearer offline-openai-fixture");
      providerCalls++;
      assert.equal(body.model, "gpt-4.1-mini");
      assert.equal(body.response_format.type, "json_schema");
      assert.equal(body.tools, undefined);
      return send(200, { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(offlinePlan), refusal: null } }] });
    }
    if (url.pathname === "/gemini-fixture") {
      assert.ok(planningTest || researcherTest || extensionTest);
      if(body.generationConfig.responseJsonSchema.properties.tasks?.items?.properties?.description){
        assert.ok(extensionTest);assert.equal(body.generationConfig.maxOutputTokens,4000);assert.equal(body.generationConfig.candidateCount,1);assert.equal(body.tools,undefined);
        assert.ok(JSON.parse(body.contents[0].parts[0].text).instruction);providerCalls++;
        if(extensionProviderFailure)return send(503,{error:{message:"private-extension-provider-error"}});
        return send(200,{modelVersion:"gemini-extension-fixture",candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(extensionDocument)}]}}]});
      }
      if (body.generationConfig.responseJsonSchema.properties.requirements) {
        assert.ok(researcherTest); assert.equal(req.headers["x-goog-api-key"],"offline-gemini-fixture");
        assert.equal(body.generationConfig.maxOutputTokens,4000); assert.equal(body.tools,undefined);
        providerCalls++;
        if(transient503Remaining>0){transient503Remaining--;return send(503,{error:{message:"private-transient-response"}});}
        if (researcherProviderFailure) return send(429,{error:{message:"private-provider-failure"}});
        return send(200,{modelVersion:"gemini-flash-fixture",candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(offlineResearch)}]}}]});
      }
      assert.equal(provider, "gemini");
      assert.equal(req.headers["x-goog-api-key"], "offline-gemini-fixture");
      assert.equal(body.generationConfig.responseMimeType, "application/json");
      assert.equal(body.generationConfig.maxOutputTokens, 6000);
      assert.equal(body.tools, undefined);
      providerCalls++;
      return send(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(offlinePlan) }] } }] });
    }
    if (url.pathname === "/rest/v1/rpc/finish_chief_plan") {
      assert.ok(planningTest);
      assert.equal(req.headers.authorization, "Bearer sb_secret_m11_fixture");
      assert.deepEqual(body, { rid: planningRid, token_hash: planningHash, plan: offlinePlan, error_code: null });
      assert.ok(!Object.hasOwn(body, "actor_id"));
      if (persistenceFailure) return send(finalizerUnavailable ? 503 : 400, { code: finalizerUnavailable ? "PGRST000" : "23514", message: "private-plan-sensitive-marker", details: planningHash, hint: "offline-gemini-fixture" });
      state.runs[0].status = "completed";
      state.missions.find((m) => m.id === planningMid).status = "awaiting_approval";
      persistFixturePlan(planningMid, planningRid);
      return send(200, null);
    }
    if(url.pathname==="/rest/v1/rpc/finish_mission_extension"){
      assert.ok(extensionTest);assert.equal(req.headers.authorization,"Bearer sb_secret_m11_fixture");
      assert.deepEqual(Object.keys(body).sort(),["doc","error_code","model_version","pid","token_hash"]);
      const p=state.mission_extensions.find(p=>p.id===body.pid);assert.equal(p.status,"running");assert.equal(p.lease_hash,body.token_hash);
      if(body.error_code){assert.equal(body.doc,null);p.status="failed";p.failure_code=body.error_code;}
      else{assert.deepEqual(body.doc,extensionDocument);p.proposal=body.doc;p.status="proposed";p.resolved_model=body.model_version;}
      return send(200,null);
    }
    if (["/rest/v1/rpc/start_researcher_execution","/rest/v1/rpc/finish_researcher_execution_with_diagnostics"].includes(url.pathname)) {
      assert.ok(researcherTest); assert.equal(req.headers.authorization,"Bearer sb_secret_m11_fixture");
      const run=state.runs.find((r)=>r.id===body.rid && r.purpose==="researcher");
      const task=state.tasks.find((t)=>t.id===run?.task_id);
      if (!run || run.lease_hash!==body.token_hash || run.status!=="running") return send(400,{code:"P0001",message:"Invalid execution lease"});
      if (url.pathname.endsWith("start_researcher_execution")) {
        assert.deepEqual(Object.keys(body).sort(),["rid","token_hash"]);
        if (researcherStartFailure) return send(503,{code:"PGRST202",message:"offline-start-failure"});
        assert.equal(task.execution_status,"authorized"); task.execution_status="running"; run.started_at=new Date().toISOString();
      } else {
        assert.deepEqual(Object.keys(body).sort(),["doc","error_code","execution_metadata","model_version","rid","token_hash"]);
        assert.equal(task.execution_status,"running");
        run.execution_metadata=body.execution_metadata;
        assert.ok([1,2].includes(body.execution_metadata.provider_requests));
        run.ended_at=new Date().toISOString(); run.failure_code=body.error_code; run.resolved_model=body.model_version;
        if (body.error_code) { assert.equal(body.doc,null); run.status="failed"; task.execution_status="failed"; }
        else {
          assert.deepEqual(body.doc,offlineResearch); run.status="completed"; task.execution_status="pending_review";
          state.artifacts.push({id:crypto.randomUUID(),workspace_id:wid,mission_id:task.mission_id,run_id:run.id,task_id:task.id,kind:"researcher_document",content:body.doc});
        }
      }
      return send(200,null);
    }
    if (req.headers.authorization !== `Bearer ${activeToken}` || !activeToken)
      return send(401, { code: "42501", message: "Authentication required" });
    if (url.pathname === "/auth/v1/user") return send(200, user);
    if (url.pathname === "/auth/v1/logout") {
      assert.equal(url.searchParams.get("scope"), "local");
      logouts++;
      activeToken = "";
      return send(204);
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const rpc = url.pathname.split("/").at(-1);
      if (rpc === "create_workspace") {
        assert.deepEqual(body, { workspace_name: "M0.4 fixture workspace" });
        state.workspaces.push({ id: wid, name: body.workspace_name });
        state.workspace_members.push({
          workspace_id: wid,
          user_id: uid,
          role: "owner",
        });
        if (state.agents) for (const key of ["chief-of-staff","researcher","developer"])
          state.agents.push({ id: crypto.randomUUID(), workspace_id: wid, definition_key: key, enabled: false });
        return send(200, wid);
      }
      if (rpc === "create_mission") {
        assert.deepEqual(body, {
          wid,
          mission_title: "M0.4 fixture mission",
          mission_objective:
            "Verify transport and persistence with a local HTTP fixture only.",
          mission_kind: "personal",
        });
        state.missions.push({
          id: mid,
          workspace_id: wid,
          title: body.mission_title,
          objective: body.mission_objective,
          kind: body.mission_kind,
          status: "draft",
          created_by: uid,
          created_at: new Date().toISOString(),
        });
        return send(200, mid);
      }
      if (rpc === "begin_chief_plan") {
        assert.ok(planningTest);
        assert.deepEqual(Object.keys(body).sort(), ["mid", "selected_model", "selected_provider", "token_hash"]);
        assert.equal(body.mid, planningMid);
        assert.equal(body.selected_model, planningModel);
        assert.equal(body.selected_provider, provider);
        assert.match(body.token_hash, /^[a-f0-9]{64}$/);
        planningHash = body.token_hash;
        const m = state.missions.find((m) => m.id === planningMid);
        if (m.status !== "draft") return send(400, { message: "Mission not eligible for planning" });
        m.status = "running";
        m.execution_mode = "chief_of_staff";
        state.runs.push({ id: planningRid, mission_id: planningMid, status: "running", failure_code: null, expires_at: new Date(Date.now()+120000).toISOString() });
        return send(200, { runId: planningRid, title: m.title, objective: m.objective });
      }
      if(rpc==="begin_mission_extension"){
        assert.ok(extensionTest);assert.deepEqual(Object.keys(body).sort(),["confirmed","instruction","mid","request_id","selected_model","token_hash"]);
        const mission=state.missions.find(m=>m.id===body.mid);
        if(!state.workspace_members.some(m=>m.workspace_id===mission.workspace_id&&m.user_id===uid&&m.role==="owner"))return send(403,{code:"42501"});
        if(mission.status!=="approved"||!body.confirmed||state.mission_extensions.some(p=>p.mission_id===body.mid&&["running","proposed"].includes(p.status))||state.mission_extensions.some(p=>p.request_id===body.request_id))return send(400,{code:"P0001"});
        const proposal={id:crypto.randomUUID(),mission_id:body.mid,workspace_id:wid,version:state.mission_extensions.length+1,request_id:body.request_id,requested_by:uid,instruction:body.instruction,model:body.selected_model,resolved_model:null,status:"running",created_at:new Date().toISOString(),expires_at:new Date(Date.now()+120000).toISOString(),proposal:null,failure_code:null,lease_hash:body.token_hash};
        state.mission_extensions.push(proposal);
        return send(200,{proposalId:proposal.id,context:{mission:{title:mission.title,objective:mission.objective},tasks:state.tasks.filter(t=>t.mission_id===body.mid).map(t=>({id:t.id,title:t.title,status:t.status,execution:t.execution_status})),instruction:body.instruction}});
      }
      if(rpc==="review_mission_extension"){
        const p=state.mission_extensions.find(p=>p.id===body.pid);const prior=state.mission_extension_reviews.find(r=>r.proposal_id===p.id);
        if(!state.workspace_members.some(m=>m.user_id===uid&&m.role==="owner"&&m.workspace_id===p.workspace_id)||!body.confirmed)return send(403,{code:"42501"});
        if(prior)return prior.request_id===body.request_id?send(200,prior.id):send(400,{code:"P0001"});
        if(p.status!=="proposed")return send(400,{code:"P0001"});
        const review={id:crypto.randomUUID(),proposal_id:p.id,request_id:body.request_id,accepted_positions:body.accepted_positions,decided_by:uid,decided_at:new Date().toISOString()};state.mission_extension_reviews.push(review);
        for(const position of body.accepted_positions){const task=p.proposal.tasks[position-1];state.tasks.push({id:crypto.randomUUID(),workspace_id:wid,mission_id:p.mission_id,extension_id:p.id,title:task.title,status:"approved",proposal_position:position,suggested_agent_role:task.suggested_agent_role,expected_deliverable:task.expected_deliverable,agent_id:state.agents.find(a=>a.definition_key===task.suggested_agent_role).id,plan_run_id:null,review_id:null,execution_status:"not_authorized",execution_run_id:null});}
        p.status=body.accepted_positions.length?"approved":"rejected";return send(200,review.id);
      }
      if(rpc==="recover_mission_extension"){
        const p=state.mission_extensions.find(p=>p.id===body.pid);
        if(Date.parse(p.expires_at)>Date.now())return send(400,{code:"P0001"});p.status="failed";p.failure_code="interrupted";return send(200,null);
      }
      if (rpc === "authorize_researcher_execution") {
        assert.deepEqual(Object.keys(body).sort(),["confirmed","request_id","selected_model","tid","token_hash"]);
        assert.equal(body.confirmed,true); assert.equal(body.selected_model,"gemini-flash-latest");
        const task=state.tasks.find((t)=>t.id===body.tid);
        if (!state.workspace_members.some((m)=>m.user_id===uid && m.workspace_id===task?.workspace_id && m.role==="owner")) return send(403,{code:"42501",message:"Owner required"});
        if (task.status!=="approved" || task.suggested_agent_role!=="researcher" || !["not_authorized","failed"].includes(task.execution_status??"not_authorized") || state.task_execution_authorizations.some((a)=>a.request_id===body.request_id)) return send(400,{code:"P0001",message:"Task not eligible"});
        const authorization={id:crypto.randomUUID(),task_id:task.id,request_id:body.request_id,authorized_by:uid}; state.task_execution_authorizations.push(authorization);
        const run={id:crypto.randomUUID(),mission_id:task.mission_id,task_id:task.id,purpose:"researcher",adapter:"gemini",status:"running",model:body.selected_model,lease_hash:body.token_hash,started_at:new Date().toISOString(),ended_at:null,expires_at:new Date(Date.now()+120000).toISOString(),failure_code:null};
        state.runs.push(run); task.execution_status="authorized"; task.execution_run_id=run.id;
        return send(200,{runId:run.id,objective:state.missions.find((m)=>m.id===task.mission_id).objective,title:task.title,expectedDeliverable:task.expected_deliverable});
      }
      if (rpc === "recover_researcher_execution") {
        const run=state.runs.find((r)=>r.id===body.rid && r.purpose==="researcher");
        if (!run || run.status!=="running" || Date.parse(run.expires_at)>Date.now()) return send(400,{code:"P0001",message:"No expired execution"});
        run.status="failed"; run.ended_at=new Date().toISOString(); run.failure_code="interrupted";
        state.tasks.find((t)=>t.id===run.task_id).execution_status="failed";
        return send(200,null);
      }
      if (rpc === "review_researcher_deliverable") {
        assert.deepEqual(Object.keys(body).sort(),["confirmed","decision","request_id","rid"]);
        const run=state.runs.find((r)=>r.id===body.rid && r.purpose==="researcher");
        if (!state.workspace_members.some((m)=>m.user_id===uid && m.workspace_id===wid && m.role==="owner")) return send(403,{code:"42501",message:"Owner required"});
        const previous=state.task_execution_reviews.find((r)=>r.run_id===body.rid);
        if (previous) return previous.request_id===body.request_id && previous.decision===body.decision ? send(200,previous.id) : send(400,{code:"P0001",message:"Already reviewed"});
        if (!run || run.status!=="completed" || body.confirmed!==true) return send(400,{code:"P0001",message:"Result not pending review"});
        const review={id:crypto.randomUUID(),run_id:run.id,decision:body.decision,request_id:body.request_id,decided_by:uid,decided_at:new Date().toISOString()};
        state.task_execution_reviews.push(review); state.tasks.find((t)=>t.id===run.task_id).execution_status=body.decision;
        return send(200,review.id);
      }
      if (rpc === "review_task_plan") {
        assert.deepEqual(Object.keys(body).sort(), ["accepted_ids","confirmed","decision","mid","request_id","rid"]);
        const m = state.missions.find((m) => m.id === body.mid);
        const member = state.workspace_members.find((x) => x.workspace_id === m?.workspace_id && x.user_id === uid);
        if (member?.role !== "owner") return send(403, { code: "42501", message: "Owner required" });
        if (body.confirmed !== true) return send(400, { code: "P0001", message: "Confirmation required" });
        const previous = state.task_plan_reviews.find((r) => r.mission_id === body.mid);
        if (previous) {
          if (previous.request_id === body.request_id && previous.decision === body.decision && JSON.stringify(previous.accepted_task_ids) === JSON.stringify(body.accepted_ids)) return send(200, previous.id);
          return send(400, { code: "P0001", message: "Already reviewed" });
        }
        const tasks = state.tasks.filter((t) => t.mission_id === body.mid && t.plan_run_id === body.rid);
        if (m.status !== "awaiting_approval" || !tasks.length || (body.decision === "approved" && !body.accepted_ids.length) || (body.decision === "rejected" && body.accepted_ids.length) || body.accepted_ids.some((id) => !tasks.some((t) => t.id === id))) return send(400, { code: "P0001", message: "Invalid plan review" });
        const review = { id: crypto.randomUUID(), mission_id: m.id, run_id: body.rid, request_id: body.request_id, decision: body.decision, accepted_task_ids: body.accepted_ids, decided_by: uid, decided_at: new Date().toISOString() };
        state.task_plan_reviews.push(review);
        for (const task of tasks) {
          task.status = body.accepted_ids.includes(task.id) ? "approved" : "rejected";
          task.agent_id = task.status === "approved" ? state.agents.find((a) => a.workspace_id === wid && a.definition_key === task.suggested_agent_role).id : null;
          task.review_id = review.id;
          state.activity_events.push({ id: crypto.randomUUID(), workspace_id: wid, mission_id: m.id, actor_id: uid, event: `task.${task.status}:${task.id}`, created_at: review.decided_at });
        }
        m.status = body.decision === "approved" ? "approved" : "cancelled";
        state.activity_events.push({ id: crypto.randomUUID(), workspace_id: wid, mission_id: m.id, actor_id: uid, event: `plan.review.${body.decision}`, created_at: review.decided_at });
        return send(200, review.id);
      }
      if (rpc === "recover_chief_plan") {
        assert.equal(body.mid, planningMid);
        if (Date.parse(state.runs[0].expires_at) > Date.now()) return send(400, { code: "P0001", message: "Planning lease has not expired" });
        state.runs[0].status = "failed";
        state.runs[0].failure_code = "interrupted";
        state.missions.find((m) => m.id === planningMid).status = "failed";
        return send(200, null);
      }
      assert.equal(rpc, "transition_mission");
      assert.equal(body.mid, mid);
      const statuses = {
        submit: "awaiting_approval",
        approve: "approved",
        start: "running",
        complete: "completed",
      };
      assert.ok(statuses[body.requested_action]);
      state.missions[0].status = statuses[body.requested_action];
      if (body.requested_action === "submit")
        state.approvals.push({
          id: "44444444-4444-4444-8444-444444444444",
          workspace_id: wid,
          mission_id: mid,
          status: "pending",
          decided_by: null,
        });
      if (body.requested_action === "approve")
        Object.assign(state.approvals[0], {
          status: "approved",
          decided_by: uid,
        });
      state.activity_events.push({
        id: String(calls.length),
        workspace_id: wid,
        mission_id: mid,
        actor_id: uid,
        event: `mock.${body.requested_action}`,
        created_at: new Date().toISOString(),
      });
      return send(200, state.missions[0].status);
    }
    assert.equal(req.method, "GET");
    const table = url.pathname.split("/").at(-1);
    if (table === "agent_definitions")
      return send(200, [
        {
          key: "chief-of-staff",
          version: 7,
          name: "Persisted fixture Chief",
          description:
            "Definition read from the isolated service, not a static template.",
        },
        { key: "researcher", version: 1, name: "Fixture Researcher", description: "Review-only researcher" },
        { key: "developer", version: 1, name: "Fixture Developer", description: "Review-only developer" },
      ]);
    assert.ok(Object.hasOwn(state, table), "Unexpected table " + table);
    let rows=state[table];
    if(table==="tasks"&&url.searchParams.get("extension_id")==="not.is.null")rows=rows.filter(t=>t.extension_id);
    if(table==="tasks"&&url.searchParams.get("plan_run_id")==="not.is.null")rows=rows.filter(t=>t.plan_run_id);
    if (table==="runs") {
      if (url.searchParams.get("purpose")==="eq.researcher") rows=rows.filter((r)=>r.purpose==="researcher");
      if (url.searchParams.get("task_id")==="is.null") rows=rows.filter((r)=>!r.task_id);
    }
    if (table==="artifacts" && url.searchParams.get("kind")) rows=rows.filter((a)=>"eq."+a.kind===url.searchParams.get("kind"));
    return send(200, rows);
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Fixture contract assertion failed" }));
  }
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const supabaseURL = `http://127.0.0.1:${fixture.address().port}`;
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((r) => reservation.close(r));
const base = `http://127.0.0.1:${port}`;
const jar = new Map();
const app = spawn(
  process.execPath,
  [
    ...((planningTest || researcherTest || extensionTest) ? ["--import", root + "tests/fixtures/openai-offline.mjs"] : []),
    root + "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: root + "apps/web",
    env: {
      ...process.env,
      AGENT_CITY_MODE: "supabase",
      AGENT_CITY_MISSION_EXTENSIONS_ENABLED: extensionTest ? "true" : "false",
      AGENT_CITY_RESEARCHER_EXECUTION_ENABLED: researcherTest ? "true" : "false",
      AGENT_CITY_RESEARCHER_503_RETRY_ENABLED: researcherRetry ? "true" : "false",
      AGENT_CITY_AI_PLANNING_ENABLED: planningTest ? "true" : "false",
      AGENT_CITY_AI_PROVIDER: provider,
      GEMINI_API_KEY: (orchestrationTest && !researcherTest && !extensionTest) ? "" : "offline-gemini-fixture",
      GEMINI_MODEL: "gemini-flash-latest",
      OPENAI_API_KEY: (orchestrationTest && !researcherTest && !extensionTest) ? "" : "offline-openai-fixture",
      OPENAI_MODEL: "gpt-4.1-mini",
      SUPABASE_SERVICE_ROLE_KEY: (orchestrationTest && !researcherTest && !extensionTest) ? "" : "sb_secret_m11_fixture",
      AGENT_CITY_TEST_OPENAI_URL: supabaseURL,
      SUPABASE_URL: supabaseURL,
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_m04_fixture_only",
      SUPABASE_PROJECT_REF: "fixture",
      SUPABASE_VERIFY_ACCESS_TOKEN: "",
      NODE_USE_ENV_PROXY: "0",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
app.stdout.on("data", (b) => {
  logs = (logs + b).slice(-30000);
});
app.stderr.on("data", (b) => {
  logs = (logs + b).slice(-30000);
});
async function request(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    redirect: "manual",
    headers: {
      Origin: base,
      Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      ...options.headers,
    },
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0],
      i = pair.indexOf("="),
      name = pair.slice(0, i),
      value = pair.slice(i + 1);
    if (!value || /max-age=0/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
  return response;
}
const forms = (html) =>
  [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]);
async function submit(path, form, extra = {}) {
  assert.ok(form, "Expected form");
  const body = new FormData();
  for (const match of form.matchAll(/<input\b[^>]*>/g)) {
    const name = match[0].match(/name="([^"]+)"/)?.[1];
    if (name && !match[0].includes('type="checkbox"')) body.set(name, match[0].match(/value="([^"]*)"/)?.[1] ?? "");
  }
  for (const [k,v] of Object.entries(extra)) {
    body.delete(k);
    for (const value of Array.isArray(v) ? v : [v]) body.append(k,value);
  }
  const response = await request(path, { method: "POST", body });
  assert.equal(response.status, 303, "Server action redirect");
  return response.headers.get("location");
}
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (app.exitCode !== null)
      throw new Error("Next.js fixture exited: " + logs);
    try {
      const r = await fetch(base + "/login", {
        signal: AbortSignal.timeout(1000),
      });
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await delay(200);
  }
  assert.ok(ready, "Fixture app readiness");
  for (const route of [
    "/dashboard",
    "/dashboard/agents",
    "/dashboard/activity",
  ])
    assert.equal((await request(route)).status, 307);
  let html = await (await request("/login")).text();
  assert.match(html, /name="password"/);
  assert.doesNotMatch(html, /Enter local workspace/);
  const invalid = await submit("/login", forms(html)[0], {
    email: "fixture@example.test",
    password: "wrong-fixture-password",
  });
  assert.match(invalid, /Unable/);
  assert.equal((await request("/dashboard")).status, 307);
  await submit("/login", forms(html)[0], {
    email: "fixture@example.test",
    password: "fixture-password",
  });
  html = await (await request("/dashboard")).text();
  assert.match(html, /SUPABASE/);
  assert.match(html, /Create your first workspace/);
  const definitions = await (await request("/dashboard/agents")).text();
  assert.match(definitions, /Persisted fixture Chief/);
  assert.match(definitions, /V<!-- -->7|V7/);
  console.log(
    "PASS (local HTTP fixture): password login, failed login, real-mode routes, database-backed agent definitions",
  );
  await submit(
    "/dashboard",
    forms(html).find((f) => f.includes('name="name"')),
    { name: "M0.4 fixture workspace" },
  );
  html = await (await request("/dashboard")).text();
  assert.match(html, /M0.4 fixture workspace/);
  await submit(
    "/dashboard",
    forms(html).find((f) => f.includes('name="objective"')),
    {
      workspaceId: wid,
      title: "M0.4 fixture mission",
      objective:
        "Verify transport and persistence with a local HTTP fixture only.",
      kind: "personal",
    },
  );
  for (const action of ["submit", "approve", "start", "complete"]) {
    html = await (await request("/dashboard")).text();
    await submit(
      "/dashboard",
      forms(html).find((f) => f.includes(`value="${action}"`)),
    );
  }
  html = await (await request("/dashboard")).text();
  assert.match(html, /M0.4 fixture mission/);
  assert.match(html, /completed/);
  assert.match(
    await (await request("/dashboard/activity")).text(),
    /mock.complete/,
  );
  assert.deepEqual(
    calls
      .filter((c) => c.path.startsWith("/rest/v1/rpc/"))
      .map((c) => c.path.split("/").at(-1)),
    [
      "create_workspace",
      "create_mission",
      "transition_mission",
      "transition_mission",
      "transition_mission",
      "transition_mission",
    ],
  );
  console.log(
    "PASS (local HTTP fixture): exact RPC routes/payloads, persisted dashboard reads, approved mock lifecycle and activity",
  );
  if (planningTest) {
    state.missions.push({ id: planningMid, workspace_id: wid, title: "M1.1 offline planning mission", objective: "Prepare proposals without executing any work.", kind: "business", status: "draft", execution_mode: "mock", created_by: uid, created_at: new Date().toISOString() });
    html = await (await request("/dashboard")).text();
    const planForm = forms(html).find((f) => f.includes('name="authorize"'));
    assert.ok(planForm);
    const before = calls.filter((c) => c.path.endsWith("begin_chief_plan")).length;
    const denied = await submit("/dashboard", planForm, { authorize: "" });
    assert.match(denied, /error=/);
    assert.equal(calls.filter((c) => c.path.endsWith("begin_chief_plan")).length, before);
    assert.equal(providerCalls, 0);
    const savedJar = new Map(jar);
    jar.clear();
    const unauthenticated = await submit("/dashboard", planForm, { authorize: "yes" });
    assert.match(unauthenticated, /login/);
    for (const [k,v] of savedJar) jar.set(k,v);
    assert.equal(providerCalls, 0);
    const planningResult = await submit("/dashboard", planForm, { authorize: "yes" });
    assert.equal(providerCalls, 1);
    if (persistenceFailure) {
      assert.match(decodeURIComponent(planningResult), /Plan persistence could not be confirmed/);
      assert.equal(state.runs[0].status, "running");
      assert.equal(state.artifacts.length, 0);
      const events = logs.split("\n").filter((line) => line.startsWith("agent_city.planning ")).map((line) => JSON.parse(line.slice("agent_city.planning ".length)));
      assert.ok(events.some((e) => e.stage === "generation" && e.outcome === "succeeded" && e.runId === planningRid));
      assert.ok(events.some((e) => e.stage === "finalize_plan" && e.outcome === "failed" && e.code === (finalizerUnavailable ? "PGRST000" : "23514") && e.httpStatus === (finalizerUnavailable ? 503 : 400) && e.runId === planningRid));
      const diagnosticText = JSON.stringify(events);
      assert.doesNotMatch(diagnosticText, /private-plan-sensitive-marker|Offline fixture plan|offline-gemini-fixture|sb_secret_m11_fixture/);
      assert.ok(!diagnosticText.includes(planningHash));
      html = await (await request("/dashboard")).text();
      assert.doesNotMatch(html, /Offline fixture plan|private-plan-sensitive-marker/);
      const recoverForm = forms(html).find((f) => f.includes("Recover interrupted plan"));
      assert.match(await submit("/dashboard", recoverForm), /error=/); // Active lease cannot be recovered.
      state.runs[0].expires_at = new Date(Date.now()-1000).toISOString();
      assert.equal(await submit("/dashboard", recoverForm), "/dashboard");
      assert.equal(state.runs[0].status, "failed");
      assert.equal(providerCalls, 1);
      assert.equal(calls.filter((c) => c.path.endsWith("finish_chief_plan")).length, 1);
      html = await (await request("/dashboard")).text();
      assert.ok(forms(html).some((f) => f.includes('name="authorize"'))); // Fresh consent required; no automatic retry.
      console.log("PASS (offline persistence failure): exact production message, sanitized SQLSTATE/stage, no artifact/retry, lease expiry and owner recovery");
    } else {
      assert.equal(planningResult, "/dashboard");
      assert.equal(providerCalls, 1);
      html = await (await request("/dashboard")).text();
      assert.match(html, /Offline fixture plan/);
      assert.match(html, /Review fixture evidence/);
      assert.match(html, /Human-reviewed fixture report/);
      assert.match(html, /human review required/);
      assert.match(html, /not executable/);
      assert.doesNotMatch(html, /offline-openai-fixture|offline-gemini-fixture|sb_secret_m11_fixture/);
      assert.doesNotMatch(html, new RegExp(planningHash));
      const duplicate = await submit("/dashboard", planForm, { authorize: "yes" });
      assert.match(duplicate, /error=/);
      assert.equal(providerCalls, 1);
      assert.equal(state.artifacts.length, 1);
      console.log(`PASS (offline planning HTTP, ${provider}): consent/session, provider transport, finalizer payload, UI proposals, no secret exposure, duplicate rejection`);
    }
  }
  if (orchestrationTest) {
    function seedReview(mid, rid) {
      state.missions.push({ id: mid, workspace_id: wid, title: "M1.3 review mission", objective: "Review existing proposals without any AI call.", kind: "business", status: "awaiting_approval", execution_mode: "chief_of_staff", created_by: uid, created_at: new Date().toISOString() });
      state.runs.push({ id: rid, mission_id: mid, status: "completed", failure_code: null });
      persistFixturePlan(mid,rid);
    }
    seedReview(planningMid,planningRid);
    html = await (await request("/dashboard")).text();
    assert.match(html, /AI mission/); assert.match(html, /Mock mission/);
    assert.match(html, /Review implementation proposal/);
    const approveForm = forms(html).find((f) => f.includes('value="approved"'));
    assert.ok(approveForm);
    const ids = state.tasks.filter((t) => t.mission_id === planningMid).map((t) => t.id);
    assert.match(await submit("/dashboard",approveForm,{ acceptedTaskIds: [ids[0]], confirmed: "" }), /error=/);
    assert.match(await submit("/dashboard",approveForm,{ acceptedTaskIds: [], confirmed: "yes" }), /error=/);
    const saved = new Map(jar); jar.clear();
    assert.match(await submit("/dashboard",approveForm,{ acceptedTaskIds: [ids[0]], confirmed: "yes" }), /login/);
    for (const [k,v] of saved) jar.set(k,v);
    state.workspace_members[0].role = "member";
    html = await (await request("/dashboard")).text();
    assert.doesNotMatch(html,/Confirm approved tasks/);
    assert.match(await submit("/dashboard",approveForm,{ acceptedTaskIds: [ids[0]], confirmed: "yes" }), /error=/);
    state.workspace_members[0].role = "owner";
    assert.equal(await submit("/dashboard",approveForm,{ acceptedTaskIds: [ids[0]], confirmed: "yes" }), "/dashboard");
    html = await (await request("/dashboard")).text();
    assert.match(html, /Assigned: .*Fixture Researcher/);
    assert.match(html, /review recorded/); assert.match(html, /Decision history/);
    assert.match(html, /Approved task list/); assert.match(html, /not executable/);
    assert.equal(state.tasks.find((t) => t.id === ids[0]).status, "approved");
    assert.equal(state.tasks.find((t) => t.id === ids[1]).status, "rejected");
    const before = state.activity_events.length;
    assert.equal(await submit("/dashboard",approveForm,{ acceptedTaskIds: [ids[0]], confirmed: "yes" }), "/dashboard");
    assert.equal(state.activity_events.length,before);
    assert.match(await submit("/dashboard",approveForm,{ acceptedTaskIds: [ids[1]], confirmed: "yes" }), /error=/);
    const rejectMid = crypto.randomUUID(), rejectRid = crypto.randomUUID();
    seedReview(rejectMid,rejectRid);
    html = await (await request("/dashboard")).text();
    const rejectForm = forms(html).find((f) => f.includes('value="'+rejectMid+'"') && f.includes('value="rejected"'));
    assert.equal(await submit("/dashboard",rejectForm,{ confirmed: "yes" }), "/dashboard");
    assert.equal(state.missions.find((m) => m.id === rejectMid).status, "cancelled");
    assert.ok(state.tasks.filter((t) => t.mission_id === rejectMid).every((t) => t.status === "rejected" && t.agent_id === null));
    assert.match(await (await request("/dashboard/activity")).text(),/plan.review.approved/);
    assert.equal(providerCalls,0);
    assert.ok(!calls.some((c) => c.path.endsWith("finish_chief_plan") || c.path.endsWith("begin_chief_plan")));
    console.log("PASS (M1.3 HTTP): individual acceptance/rejection, confirmation, member/session denial, assignment/history, idempotency and whole-plan rejection with AI disabled and no privileged key");
  }
  if (researcherTest) {
    const task=state.tasks.find((t)=>t.mission_id===planningMid && t.status==="approved");
    async function researcherForm(taskId) {
      const html=await (await request("/dashboard")).text();
      return forms(html).find((f)=>f.includes('name="taskId" value="'+taskId+'"'));
    }
    let form=await researcherForm(task.id); assert.ok(form);
    assert.match(await submit("/dashboard",form,{confirmed:""}),/error=/); assert.equal(providerCalls,0);
    state.workspace_members[0].role="member";
    assert.equal(await researcherForm(task.id),undefined);
    assert.match(await submit("/dashboard",form,{confirmed:"yes"}),/error=/); assert.equal(providerCalls,0);
    state.workspace_members[0].role="owner";
    assert.equal(await submit("/dashboard",form,{confirmed:"yes"}),"/dashboard"); assert.equal(providerCalls,1+(researcherRetry?1:0));
    assert.equal(task.status,"approved"); assert.equal(task.execution_status,"pending_review");
    assert.match(await submit("/dashboard",form,{confirmed:"yes"}),/error=/); assert.equal(providerCalls,1+(researcherRetry?1:0));
    html=await (await request("/dashboard")).text();
    assert.match(html,/Offline generated requirements brief/); assert.match(html,/not externally verified/); assert.match(html,/gemini-flash-latest/); assert.match(html,/gemini-flash-fixture/); assert.match(html,/elapsed at refresh/);
    assert.match(html,/Authorized attempts:/);assert.match(html,/pending human review/);
    assert.match(html,researcherRetry?/transient retry: <!-- -->performed/:/transient retry: <!-- -->not performed/);
    assert.doesNotMatch(html,/&#x20;/);
    assert.doesNotMatch(html,/offline-gemini-fixture|sb_secret_m11_fixture/);
    const run=state.runs.find((r)=>r.id===task.execution_run_id); assert.ok(!html.includes(run.lease_hash));
    const accept=forms(html).find((f)=>f.includes('value="'+run.id+'"') && f.includes('value="accepted"'));
    assert.match(await submit("/dashboard",accept,{confirmed:""}),/error=/);
    assert.equal(await submit("/dashboard",accept,{confirmed:"yes"}),"/dashboard"); assert.equal(task.execution_status,"accepted");
    assert.equal(await submit("/dashboard",accept,{confirmed:"yes"}),"/dashboard"); assert.equal(state.task_execution_reviews.length,1);
    function seedApprovedTask() {
      const missionId=crypto.randomUUID(), planRun=crypto.randomUUID(), reviewId=crypto.randomUUID();
      state.missions.push({...state.missions.find((m)=>m.id===task.mission_id),id:missionId});
      state.runs.push({id:planRun,mission_id:missionId,purpose:"mission",status:"completed"});
      persistFixturePlan(missionId,planRun);
      const proposed=state.tasks.filter((t)=>t.mission_id===missionId);
      proposed.forEach((t,i)=>{t.status=i===0?"approved":"rejected";t.agent_id=i===0?task.agent_id:null;t.review_id=reviewId;t.execution_status="not_authorized";t.execution_run_id=null;});
      state.task_plan_reviews.push({id:reviewId,mission_id:missionId,run_id:planRun,decision:"approved",accepted_task_ids:[proposed[0].id],decided_by:uid,decided_at:new Date().toISOString()});
      return proposed[0];
    }
    const rejected=seedApprovedTask(); form=await researcherForm(rejected.id);
    assert.equal(await submit("/dashboard",form,{confirmed:"yes"}),"/dashboard"); assert.equal(providerCalls,2+(researcherRetry?1:0));
    html=await (await request("/dashboard")).text();
    const reject=forms(html).find((f)=>f.includes('value="'+rejected.execution_run_id+'"') && f.includes('value="rejected"'));
    assert.equal(await submit("/dashboard",reject,{confirmed:"yes"}),"/dashboard"); assert.equal(rejected.execution_status,"rejected");
    const failed=seedApprovedTask(); researcherProviderFailure=true;
    assert.match(await submit("/dashboard",await researcherForm(failed.id),{confirmed:"yes"}),/error=/);
    assert.equal(providerCalls,3+(researcherRetry?1:0)); assert.equal(failed.execution_status,"failed");
    assert.equal(state.artifacts.filter((a)=>a.task_id===failed.id).length,0);
    const providerDiagnostic=logs.split("\n").filter(l=>l.startsWith("agent_city.researcher ")).map(l=>JSON.parse(l.slice("agent_city.researcher ".length))).find(e=>e.stage==="generation"&&e.outcome==="failed"&&e.httpStatus===429);
    assert.equal(providerDiagnostic?.httpStatus,429); assert.equal(providerDiagnostic?.failureClass,"quota_or_rate_limit");
    assert.ok(!logs.includes("private-provider-failure"));
    researcherProviderFailure=false;
    const interrupted=seedApprovedTask(); researcherStartFailure=true;
    assert.match(await submit("/dashboard",await researcherForm(interrupted.id),{confirmed:"yes"}),/error=/); assert.equal(providerCalls,3+(researcherRetry?1:0));
    researcherStartFailure=false;
    html=await (await request("/dashboard")).text();
    const recover=forms(html).find((f)=>f.includes('value="'+interrupted.execution_run_id+'"') && f.includes("Recover interrupted Researcher"));
    assert.match(await submit("/dashboard",recover),/error=/);
    state.runs.find((r)=>r.id===interrupted.execution_run_id).expires_at=new Date(Date.now()-1000).toISOString();
    assert.equal(await submit("/dashboard",recover),"/dashboard"); assert.equal(interrupted.execution_status,"failed"); assert.equal(providerCalls,3+(researcherRetry?1:0));
    assert.ok(await researcherForm(interrupted.id));
    assert.ok(!calls.some((c)=>c.path.endsWith("begin_chief_plan") || c.path.includes("openai-fixture")));
    console.log("PASS (M1.4 offline HTTP): explicit Researcher-only authorization, member denial, single Gemini call, real provenance/preview/model/time, acceptance/rejection, provider error and interruption recovery; planning disabled");
  }
  if(extensionTest){
    const originalTasks=JSON.stringify(state.tasks);const originalRuns=JSON.stringify(state.runs);const originalArtifacts=JSON.stringify(state.artifacts);
    const extensionForm=async()=>forms(await(await request("/dashboard")).text()).find(f=>f.includes('name="instruction"'));
    let form=await extensionForm();assert.ok(form);assert.equal(providerCalls,0);
    assert.match(await submit("/dashboard",form,{instruction:"Add new fixture work",confirmed:""}),/error=/);assert.equal(providerCalls,0);
    state.workspace_members[0].role="member";assert.equal(await extensionForm(),undefined);
    assert.match(await submit("/dashboard",form,{instruction:"Add work",confirmed:"yes"}),/error=/);assert.equal(providerCalls,0);state.workspace_members[0].role="owner";
    assert.equal(await submit("/dashboard",form,{instruction:"Add new fixture work",confirmed:"yes"}),"/dashboard");assert.equal(providerCalls,1);
    assert.equal(JSON.stringify(state.tasks),originalTasks);assert.equal(JSON.stringify(state.runs),originalRuns);assert.equal(JSON.stringify(state.artifacts),originalArtifacts);
    assert.match(await submit("/dashboard",form,{instruction:"Add new fixture work",confirmed:"yes"}),/error=/);assert.equal(providerCalls,1);
    html=await(await request("/dashboard")).text();assert.match(html,/Offline additive proposal/);assert.match(html,/gemini-extension-fixture/);assert.match(html,/Additional fixture research/);
    const proposal=state.mission_extensions[0];assert.ok(!html.includes(proposal.lease_hash));
    const review=forms(html).find(f=>f.includes('name="proposalId" value="'+proposal.id+'"')&&f.includes('name="acceptedPositions"'));
    assert.match(await submit("/dashboard",review,{acceptedPositions:["1"],confirmed:""}),/error=/);
    assert.equal(await submit("/dashboard",review,{acceptedPositions:["1"],confirmed:"yes"}),"/dashboard");assert.equal(providerCalls,1);
    assert.equal(state.tasks.filter(t=>t.extension_id===proposal.id).length,1);assert.equal(state.tasks.find(t=>t.extension_id===proposal.id).execution_status,"not_authorized");
    assert.equal(await submit("/dashboard",review,{acceptedPositions:["1"],confirmed:"yes"}),"/dashboard");assert.equal(state.tasks.filter(t=>t.extension_id===proposal.id).length,1);
    html=await(await request("/dashboard")).text();assert.match(html,/Execution unavailable for additions/);assert.match(html,/Decision: <!-- -->rejected/);
    assert.equal(JSON.stringify(state.runs),originalRuns);assert.equal(JSON.stringify(state.artifacts),originalArtifacts);
    form=await extensionForm();assert.ok(form);extensionProviderFailure=true;
    assert.match(await submit("/dashboard",form,{instruction:"Another follow-up",confirmed:"yes"}),/error=/);assert.equal(providerCalls,2);
    assert.equal(state.mission_extensions.at(-1).status,"failed");assert.equal(state.tasks.filter(t=>t.extension_id).length,1);
    assert.ok(!calls.some(c=>c.path.endsWith("authorize_researcher_execution")));
    console.log("PASS (M1.5A offline HTTP): owner consent, member denial, additive generation, partial review, idempotency, immutable original work, provider failure and no execution");
  }
  const cookieName = [...jar.keys()].find((k) => k.endsWith("-auth-token"));
  assert.ok(cookieName, "SSR session cookie");
  const current = jar.get(cookieName);
  assert.ok(current.startsWith("base64-"));
  const stored = JSON.parse(
    Buffer.from(current.slice(7), "base64url").toString("utf8"),
  );
  stored.expires_at = Math.floor(Date.now() / 1000) - 60;
  jar.set(
    cookieName,
    "base64-" + Buffer.from(JSON.stringify(stored)).toString("base64url"),
  );
  const before = refreshes;
  const refreshed = await request("/dashboard");
  assert.equal(refreshed.status, 200);
  assert.equal(refreshes, before + 1);
  assert.notEqual(jar.get(cookieName), current);
  assert.match(refreshed.headers.get("cache-control") ?? "", /no-store/);
  assert.match(await refreshed.text(), /M0.4 fixture mission/);
  console.log(
    "PASS (local HTTP fixture): expired session refresh, updated browser cookies and request propagation, no-store response",
  );
  html = await (await request("/dashboard")).text();
  await submit(
    "/dashboard",
    forms(html).find((f) => f.includes("Sign out")),
  );
  assert.equal(logouts, 1);
  assert.equal((await request("/dashboard")).status, 307);
  assert.ok(
    ![...jar.keys()].some((k) => k.endsWith("-auth-token")),
    "Session cookie removed",
  );
  html = await (await request("/login")).text();
  await submit("/login", forms(html)[0], {
    email: "fixture@example.test",
    password: "fixture-password",
  });
  html = await (await request("/dashboard")).text();
  assert.match(html, /M0.4 fixture mission/);
  assert.match(html, /completed/);
  assert.ok(
    !calls.some((c) => c.path.includes("signup") || c.path.includes("/admin/")),
  );
  console.log(
    "PASS (local HTTP fixture): logout removes session; fresh login reads retained service data; no Auth-user administration",
  );
} catch (error) {
  console.error(
    "Local HTTP integration failure:",
    error instanceof Error ? error.message : "unknown",
  );
  process.exitCode = 1;
} finally {
  try {
    process.kill(-app.pid, "SIGTERM");
  } catch {}
  await Promise.race([
    once(app, "exit"),
    delay(5000).then(() => {
      try {
        process.kill(-app.pid, "SIGKILL");
      } catch {}
    }),
  ]);
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
}
