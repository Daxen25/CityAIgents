import "server-only";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertMember,
  nextStatus,
  missionInput,
  mockResult,
  type Mission,
  type Approval,
  type Run,
  type Activity,
  type Action,
  type Role,
} from "@agent-city/core";
export const localWorkspace = "22222222-2222-4222-8222-222222222222";
interface State {
  workspaces: { id: string; name: string }[];
  members: { workspaceId: string; userId: string; role: Role }[];
  missions: Mission[];
  approvals: Approval[];
  runs: Run[];
  events: Activity[];
  artifacts: {
    id: string;
    workspaceId: string;
    missionId: string;
    runId: string;
    content: ReturnType<typeof mockResult>;
  }[];
}
const dir =
  process.env.AGENT_CITY_MOCK_DATA_DIR ?? join(process.cwd(), ".data");
const file = join(dir, "mock.json");
function load(): State {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file))
    save({
      workspaces: [{ id: localWorkspace, name: "Local workspace" }],
      members: [
        {
          workspaceId: localWorkspace,
          userId: "11111111-1111-4111-8111-111111111111",
          role: "owner",
        },
      ],
      missions: [],
      approvals: [],
      runs: [],
      events: [],
      artifacts: [],
    });
  return JSON.parse(readFileSync(file, "utf8"));
}
function save(s: State) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}
export function localSnapshot(user: string) {
  const s = load();
  const ids = s.members
    .filter((m) => m.userId === user)
    .map((m) => m.workspaceId);
  return {
    ...s,
    artifacts: s.artifacts.filter((a) => ids.includes(a.workspaceId)),
    workspaces: s.workspaces.filter((w) => ids.includes(w.id)),
    members: s.members.filter((m) => ids.includes(m.workspaceId)),
    missions: s.missions.filter((m) => ids.includes(m.workspaceId)),
    approvals: s.approvals.filter((a) => ids.includes(a.workspaceId)),
    runs: s.runs.filter((r) => ids.includes(r.workspaceId)),
    events: s.events.filter((e) => ids.includes(e.workspaceId)),
  };
}
function event(s: State, m: Mission, user: string, action: string) {
  s.events.push({
    id: randomUUID(),
    workspaceId: m.workspaceId,
    missionId: m.id,
    actorId: user,
    event: `mock.${action}`,
    createdAt: new Date().toISOString(),
  });
}
export function localCreate(user: string, input: unknown) {
  const s = load();
  const data = missionInput.parse(input);
  assertMember(s.members, data.workspaceId, user);
  const m: Mission = {
    ...data,
    id: randomUUID(),
    status: "draft",
    createdBy: user,
    createdAt: new Date().toISOString(),
  };
  s.missions.push(m);
  event(s, m, user, "created");
  save(s);
}
// Synchronous read/modify/atomic-rename in one Node process; not a multi-process database.
export function localTransition(user: string, id: string, action: Action) {
  const s = load();
  const m = s.missions.find((m) => m.id === id);
  if (!m) throw new Error("Mission not found");
  const role = assertMember(s.members, m.workspaceId, user);
  const approval = s.approvals.find((a) => a.missionId === id);
  m.status = nextStatus(m.status, action, role, approval);
  if (action === "submit")
    s.approvals.push({
      id: randomUUID(),
      workspaceId: m.workspaceId,
      missionId: id,
      status: "pending",
      decidedBy: null,
    });
  if (action === "approve" || action === "reject") {
    if (!approval || approval.status !== "pending")
      throw new Error("Pending approval required");
    approval.status = action === "approve" ? "approved" : "rejected";
    approval.decidedBy = user;
  }
  if (action === "start")
    s.runs.push({
      id: randomUUID(),
      workspaceId: m.workspaceId,
      missionId: id,
      adapter: "mock",
      status: "running",
    });
  if (action === "complete" || action === "fail") {
    const run = s.runs.find(
      (r) => r.missionId === id && r.status === "running",
    );
    if (!run) throw new Error("Running mock execution required");
    run.status = action === "complete" ? "completed" : "failed";
    if (action === "complete")
      s.artifacts.push({
        id: randomUUID(),
        workspaceId: m.workspaceId,
        missionId: id,
        runId: run.id,
        content: mockResult(),
      });
  }
  event(s, m, user, action);
  save(s);
}
