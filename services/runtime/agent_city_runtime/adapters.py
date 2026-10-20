from .contracts import RunRequest, RunResult, PermissionRepository, require_mock_permission

class MockAdapter:
    def __init__(self, permissions: PermissionRepository):
        self.permissions = permissions

    async def execute(self, request: RunRequest) -> RunResult:
        # Retrieve permission from the trusted repository, never from caller-supplied approval flags.
        require_mock_permission(request, self.permissions.get_permission(request.approval_id))
        return RunResult("mock", "completed", "Mock lifecycle completed. No agent work or external actions were performed.")

class OpenAIAgentsAdapter:
    """Future integration point for the pinned OpenAI Agents SDK.

    M1 must supply a trusted permission repository, tenant isolation, idempotency,
    tool allowlists and approval checks for every external action before enabling it.
    """
    async def execute(self, request: RunRequest) -> RunResult:
        raise NotImplementedError("Real agent execution is disabled in M0")
