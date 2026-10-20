import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextStatus,
  assertMember,
  missionInput,
  mockResult,
  type Approval,
  type Status,
  type Action,
} from "../src/index";
const approval: Approval = {
  id: "a",
  workspaceId: "w",
  missionId: "m",
  status: "approved",
  decidedBy: "owner",
};
test("deterministic approved lifecycle", () => {
  let status: Status = "draft";
  for (const a of ["submit", "approve", "start", "complete"] as Action[])
    status = nextStatus(status, a, "owner", approval);
  assert.equal(status, "completed");
  assert.deepEqual(mockResult(), mockResult());
});
test("no execution without approval, including forged approved state", () => {
  assert.throws(() => nextStatus("draft", "start", "owner"));
  assert.throws(() => nextStatus("awaiting_approval", "start", "owner"));
  assert.throws(() => nextStatus("approved", "start", "owner"));
  assert.throws(() =>
    nextStatus("approved", "start", "owner", {
      ...approval,
      status: "rejected",
    }),
  );
});
test("member cannot decide approval and nonmember cannot access workspace", () => {
  assert.throws(() => nextStatus("awaiting_approval", "approve", "member"));
  assert.throws(() => nextStatus("awaiting_approval", "reject", "member"));
  assert.throws(() =>
    assertMember(
      [{ workspaceId: "w", userId: "u", role: "owner" }],
      "other",
      "u",
    ),
  );
  assert.throws(() => assertMember([], "w", "u"));
});
test("terminal states reject every action", () => {
  for (const status of ["completed", "failed", "cancelled"] as Status[])
    for (const action of [
      "submit",
      "approve",
      "reject",
      "start",
      "complete",
      "fail",
      "cancel",
    ] as Action[])
      assert.throws(() => nextStatus(status, action, "owner", approval));
});
test("rejection, cancellation and failure are explicit", () => {
  assert.equal(nextStatus("awaiting_approval", "reject", "owner"), "cancelled");
  assert.equal(nextStatus("approved", "cancel", "owner"), "cancelled");
  assert.equal(nextStatus("running", "fail", "owner"), "failed");
});
test("mission schema rejects missing scope and empty objectives", () => {
  assert.equal(
    missionInput.safeParse({
      title: "Mission",
      objective: "",
      kind: "business",
    }).success,
    false,
  );
  assert.equal(
    missionInput.safeParse({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      title: " Plan ",
      objective: "A useful objective",
      kind: "personal",
    }).success,
    true,
  );
});
