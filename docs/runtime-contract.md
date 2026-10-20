# Runtime boundary v1

The web application owns authorization, mission status and approval decisions. The Python
service is a future worker boundary, not a public HTTP execution endpoint. No worker or
external tools run in M0. The OpenAI Agents SDK is pinned and import-tested only.

TypeScript uses camelCase and Python uses snake_case; a future transport must explicitly
map `workspaceId`, `missionId`, `runId`, `approvalId` and `version` to the dataclass fields.
No transport is implemented yet. `RuntimeRequest` and `RunRequest` describe the same IDs.
The adapter is chosen by trusted server configuration, never by an end user's request.

Before execution, a trusted repository must retrieve the approval by ID and validate its
workspace, mission, status and scope. A `mock_run` permission never authorizes external
work. The future runtime must recheck per-action permissions and support cancellation,
idempotency, retry limits, audit events and scoped credentials. Model instructions are
never authorization. M0 intentionally leaves real adapter execution disabled.

No n8n integration, tool invocation, background orchestration or network agent execution
is implemented. Mock completion records lifecycle behavior, not real work products.
