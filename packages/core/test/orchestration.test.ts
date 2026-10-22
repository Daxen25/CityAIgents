import { test } from "node:test";
import assert from "node:assert/strict";
import { planReviewInput } from "../src/index";
const id = "11111111-1111-4111-8111-111111111111";
const input = { missionId: id, runId: id, requestId: id, decision: "approved", acceptedTaskIds: [id], confirmed: true };
test("plan review input requires explicit task selection and confirmation", () => {
  assert.equal(planReviewInput.safeParse(input).success, true);
  assert.equal(planReviewInput.safeParse({ ...input, decision: "rejected", acceptedTaskIds: [] }).success, true);
  for (const change of [
    { confirmed: false }, { confirmed: undefined }, { acceptedTaskIds: [] },
    { acceptedTaskIds: [id,id] }, { acceptedTaskIds: Array(13).fill(id) },
    { acceptedTaskIds: ["not-a-task"] }, { runId: "not-a-run" }, { requestId: undefined },
    { decision: "running" }, { decision: "rejected" }, { actorId: id }, { agentId: id },
  ]) assert.equal(planReviewInput.safeParse({ ...input, ...change }).success, false);
});
