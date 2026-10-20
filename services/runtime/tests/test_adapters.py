import asyncio
import sys
import unittest
from dataclasses import replace
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent_city_runtime.contracts import RunRequest, Permission
from agent_city_runtime.adapters import MockAdapter, OpenAIAgentsAdapter

class Permissions:
    def __init__(self, permission): self.permission = permission
    def get_permission(self, approval_id): return self.permission

class AdapterTests(unittest.TestCase):
    request = RunRequest("1", "workspace", "mission", "run", "approval")
    permission = Permission("workspace", "mission", "approval", "approved", "mock_run")

    def test_deterministic_mock(self):
        adapter = MockAdapter(Permissions(self.permission))
        first = asyncio.run(adapter.execute(self.request))
        self.assertEqual(first, asyncio.run(adapter.execute(self.request)))
        self.assertEqual(first.status, "completed")
        self.assertIn("No agent work", first.summary)

    def test_invalid_permissions(self):
        for field, value in [("workspace_id", "other"), ("mission_id", "other"),
                             ("approval_id", "other"), ("status", "pending"),
                             ("status", "rejected"), ("scope", "external_action")]:
            with self.subTest(field=field, value=value), self.assertRaises(PermissionError):
                asyncio.run(MockAdapter(Permissions(replace(self.permission, **{field:value}))).execute(self.request))

    def test_real_adapter_disabled(self):
        with self.assertRaises(NotImplementedError):
            asyncio.run(OpenAIAgentsAdapter().execute(self.request))

    def test_sdk_import(self):
        from agents import Agent
        self.assertTrue(callable(Agent))
