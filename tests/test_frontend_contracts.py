"""Cross-stack contract tests verifying Python API payloads against Next.js TypeScript schemas."""

from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from sentinel.api import SentinelService
from sentinel.store import IncidentPersistenceStore


FRONTEND_ROOT = Path(__file__).resolve().parents[1] / "frontend"


class TestFrontendContracts(unittest.TestCase):
    """Ensure the Next.js TypeScript frontend and Python backend stay in strict contract lockstep."""

    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory()
        db_path = Path(self.tmp_dir.name) / "contracts.db"
        self.store = IncidentPersistenceStore(f"sqlite:///{db_path}")
        self.service = SentinelService(store=self.store)

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def test_frontend_source_tree_completeness(self) -> None:
        required_files = [
            "package.json",
            "tsconfig.json",
            "next.config.mjs",
            "tailwind.config.ts",
            "src/types/sentinel.ts",
            "src/lib/api-client.ts",
            "src/lib/wfg-layout.ts",
            "src/lib/console-store.ts",
            "src/lib/demo-fixtures.ts",
            "src/hooks/useSentinelConsole.ts",
            "src/components/DashboardShell.tsx",
            "src/components/WaitForGraphVisualizer.tsx",
            "src/components/AgentFindingsMatrix.tsx",
            "src/components/ChaosFaultInjectorPanel.tsx",
            "src/components/GuardrailAndDrAuditPanel.tsx",
            "src/components/IncidentQueuePanel.tsx",
            "src/components/KpiHeaderBar.tsx",
            "src/app/layout.tsx",
            "src/app/page.tsx",
            "src/__tests__/sentinel-frontend.test.ts",
        ]
        for rel in required_files:
            target = FRONTEND_ROOT / rel
            self.assertTrue(target.is_file(), f"Missing required frontend file: {rel}")

    def test_chaos_inject_payload_matches_typescript_incident_detail_contract(self) -> None:
        injected = self.service.inject_chaos("INC-004")
        self.assertEqual(injected["scenario_id"], "INC-004")
        self.assertEqual(injected["count"], 1)
        report = injected["reports"][0]
        required_detail_keys = {
            "incident_id",
            "alert_name",
            "diagnosed_category",
            "confidence",
            "cited_runbook_id",
            "cited_runbook_title",
            "root_cause_summary",
            "agent_findings",
            "approved_readonly_commands",
            "blocked_unsafe_commands",
            "prompt_injection_neutralized",
            "dr_drill_result",
            "triage_latency_ms",
            "severity",
            "namespace",
            "service",
            "expected_category",
            "created_at",
            "wait_for_graph",
        }
        self.assertTrue(required_detail_keys.issubset(report.keys()))
        wfg = report["wait_for_graph"]
        self.assertGreaterEqual(len(wfg["nodes"]), 2)
        self.assertGreaterEqual(len(wfg["edges"]), 2)
        self.assertEqual(wfg["deadlock_cycles_found"], 1)


if __name__ == "__main__":
    unittest.main()
