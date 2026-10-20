from dataclasses import dataclass
from typing import Literal, Protocol

@dataclass(frozen=True)
class RunRequest:
    version: Literal["1"]
    workspace_id: str
    mission_id: str
    run_id: str
    approval_id: str

@dataclass(frozen=True)
class Permission:
    workspace_id: str
    mission_id: str
    approval_id: str
    status: Literal["pending", "approved", "rejected"]
    scope: Literal["mock_run", "external_action"]

@dataclass(frozen=True)
class RunResult:
    adapter: Literal["mock", "python"]
    status: Literal["completed", "failed"]
    summary: str

class PermissionRepository(Protocol):
    def get_permission(self, approval_id: str) -> Permission: ...

class RuntimeAdapter(Protocol):
    async def execute(self, request: RunRequest) -> RunResult: ...

def require_mock_permission(request: RunRequest, permission: Permission) -> None:
    if (request.version != "1" or permission.status != "approved" or
        permission.scope != "mock_run" or
        (request.workspace_id, request.mission_id, request.approval_id) !=
        (permission.workspace_id, permission.mission_id, permission.approval_id)):
        raise PermissionError("An approved, workspace-scoped mock permission is required")
