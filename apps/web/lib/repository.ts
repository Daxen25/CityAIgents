import "server-only";
import { mode } from "./config";
import { readAgentDefinitions } from "./agent-definitions";
import { supabase } from "./supabase";
import { localCreate, localSnapshot, localTransition } from "./mock-store";
import {
  agentDefinitions,
  missionInput,
  type Action,
  type Mission,
  type Approval,
  type Activity,
  type Role,
} from "@agent-city/core";
function check(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}
export async function snapshot(user: string) {
  if (mode() === "mock") return localSnapshot(user);
  const db = await supabase();
  const [w, m, a, e, members] = await Promise.all([
    db.from("workspaces").select("id,name"),
    db.from("missions").select("*").order("created_at", { ascending: false }),
    db.from("approvals").select("*"),
    db
      .from("activity_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50),
    db.from("workspace_members").select("workspace_id,user_id,role"),
  ]);
  [w, m, a, e, members].forEach((r) => check(r.error));
  return {
    members: (members.data ?? []).map((x) => ({
      workspaceId: x.workspace_id,
      userId: x.user_id,
      role: x.role as Role,
    })),
    workspaces: w.data ?? [],
    missions: (m.data ?? []).map(
      (x) =>
        ({
          id: x.id,
          workspaceId: x.workspace_id,
          title: x.title,
          objective: x.objective,
          kind: x.kind,
          status: x.status,
          executionMode: x.execution_mode ?? "mock",
          createdBy: x.created_by,
          createdAt: x.created_at,
        }) as Mission,
    ),
    approvals: (a.data ?? []).map(
      (x) =>
        ({
          id: x.id,
          workspaceId: x.workspace_id,
          missionId: x.mission_id,
          status: x.status,
          decidedBy: x.decided_by,
        }) as Approval,
    ),
    events: (e.data ?? []).map(
      (x) =>
        ({
          id: x.id,
          workspaceId: x.workspace_id,
          missionId: x.mission_id,
          actorId: x.actor_id,
          event: x.event,
          createdAt: x.created_at,
        }) as Activity,
    ),
  };
}
export async function createWorkspace(name: string) {
  const { error } = await (
    await supabase()
  ).rpc("create_workspace", { workspace_name: name });
  check(error);
}
export async function createMission(user: string, input: unknown) {
  const data = missionInput.parse(input);
  if (mode() === "mock") return localCreate(user, data);
  const { error } = await (
    await supabase()
  ).rpc("create_mission", {
    wid: data.workspaceId,
    mission_title: data.title,
    mission_objective: data.objective,
    mission_kind: data.kind,
  });
  check(error);
}
export async function transition(user: string, id: string, action: Action) {
  if (mode() === "mock") return localTransition(user, id, action);
  const { error } = await (
    await supabase()
  ).rpc("transition_mission", { mid: id, requested_action: action });
  check(error);
}

export async function listAgentDefinitions() {
  if (mode() === "mock")
    return agentDefinitions.map((definition) => ({
      ...definition,
      version: 1,
    }));
  return readAgentDefinitions(await supabase());
}
