"""
Comprehensive Unit & Integration Test Suite for Sentinel-SRE:
1. IncidentPersistenceStore (SQLite WAL, foreign keys, atomic transactions, cascade deletes, summary KPIs)
2. PrometheusMetricsRegistry (exposition format, counter/gauge/histogram math, triage recording)
3. SentinelService & WSGI/FastAPI API Endpoints:
   - GET /api/v1/healthz
   - GET /api/v1/stats
   - POST /api/v1/chaos/inject/INC-001 (VXLAN MTU mismatch)
   - POST /api/v1/chaos/inject/INC-004 (Postgres lock deadlock)
   - POST /api/v1/chaos/inject/INC-007 (adversarial prompt injection)
   - GET /api/v1/incidents & GET /api/v1/incidents/{incident_id}
   - POST /api/v1/triage
   - POST /api/v1/dr/drill & GET /api/v1/dr/verifications
   - GET /metrics
   - GET /api/v1/chaos/stream/{scenario_id} & GET /api/v1/events/stream (SSE streaming)
   - CORS OPTIONS preflight
"""
from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from sentinel.api import SentinelService, create_wsgi_app
from sentinel.coordinator import SentinelCoordinator
from sentinel.events import EventBroadcaster
from sentinel.metrics import PrometheusMetricsRegistry
from sentinel.models import DrRestoreResult, IncidentDiagnosisReport, PgSessionNode, TelemetrySnapshot
from sentinel.store import IncidentPersistenceStore


class WsgiTestClient:
    """Lightweight zero-dependency WSGI test harness."""

    def __init__(self, app: Any) -> None:
        self.app = app

    def request(
        self,
        method: str,
        path: str,
        body: Optional[Any] = None,
        headers: Optional[Dict[str, str]] = None,
        query_string: str = "",
    ) -> Tuple[int, Dict[str, str], bytes]:
        headers = headers or {}
        if body is not None and not isinstance(body, bytes):
            body_bytes = json.dumps(body).encode("utf-8")
            if "Content-Type" not in headers:
                headers["Content-Type"] = "application/json"
        elif body is not None:
            body_bytes = body
        else:
            body_bytes = b""

        status_box: List[str] = []
        headers_box: List[List[Tuple[str, str]]] = []

        def start_response(status: str, response_headers: List[Tuple[str, str]], exc_info: Any = None) -> Any:
            status_box.append(status)
            headers_box.append(response_headers)

        environ = {
            "REQUEST_METHOD": method.upper(),
            "PATH_INFO": path,
            "QUERY_STRING": query_string,
            "wsgi.input": io.BytesIO(body_bytes),
            "CONTENT_LENGTH": str(len(body_bytes)),
            "wsgi.url_scheme": "http",
            "SERVER_NAME": "localhost",
            "SERVER_PORT": "8000",
        }
        for k, v in headers.items():
            key = "HTTP_" + k.upper().replace("-", "_")
            environ[key] = v
        if "Content-Type" in headers:
            environ["CONTENT_TYPE"] = headers["Content-Type"]

        res_iter = self.app(environ, start_response)
        try:
            content = b"".join(res_iter)
        finally:
            if hasattr(res_iter, "close"):
                res_iter.close()

        status_code = int(status_box[0].split()[0])
        resp_headers = {k.lower(): v for k, v in headers_box[0]}
        return status_code, resp_headers, content

    def get(self, path: str, headers: Optional[Dict[str, str]] = None, query: str = "") -> Tuple[int, Dict[str, str], bytes]:
        return self.request("GET", path, headers=headers, query_string=query)

    def post(self, path: str, body: Optional[Any] = None, headers: Optional[Dict[str, str]] = None) -> Tuple[int, Dict[str, str], bytes]:
        return self.request("POST", path, body=body, headers=headers)

    def options(self, path: str, headers: Optional[Dict[str, str]] = None) -> Tuple[int, Dict[str, str], bytes]:
        return self.request("OPTIONS", path, headers=headers)


class TestIncidentPersistenceStore(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory(prefix="sentinel_test_store_")
        self.db_path = Path(self.tmp_dir.name) / "test.db"
        self.store = IncidentPersistenceStore(str(self.db_path))

    def tearDown(self) -> None:
        self.store.close()
        self.tmp_dir.cleanup()

    def test_sqlite_pragmas_wal_and_foreign_keys(self) -> None:
        self.assertEqual(self.store.journal_mode.lower(), "wal")
        self.assertTrue(self.store.foreign_keys_enabled)
        counts = self.store.table_counts()
        self.assertEqual(counts["incidents"], 0)
        self.assertEqual(counts["dr_verifications"], 0)
        self.assertEqual(counts["guardrail_audit_log"], 0)

    def test_atomic_persistence_and_retrieval(self) -> None:
        dr = DrRestoreResult(
            snapshot_id="snap-TEST-001",
            sha256_digest="abcdef0123456789",
            tables_restored=2,
            rows_verified=50,
            foreign_key_check_passed=True,
            rto_ms=3.45,
            rpo_seconds=0,
        )
        report = IncidentDiagnosisReport(
            incident_id="TEST-INC-001",
            alert_name="TestHighLatency",
            diagnosed_category="VxlanMtuMismatch",
            confidence=0.92,
            cited_runbook_id="RB-004",
            cited_runbook_title="OpenStack Neutron OVS VXLAN MTU Mismatch",
            root_cause_summary="VXLAN encapsulation drop",
            agent_findings=[],
            approved_readonly_commands=["ping -M do -s 1422 -c 3 10.0.10.15"],
            blocked_unsafe_commands=["kubectl delete namespace prod", "rm -rf /data"],
            prompt_injection_neutralized=True,
            dr_drill_result=dr,
            triage_latency_ms=2.15,
        )
        snap = TelemetrySnapshot(
            incident_id="TEST-INC-001",
            alert_name="TestHighLatency",
            severity="critical",
            namespace="prod",
            service="api-gateway",
            summary="VXLAN drop",
            description="Packet drop test",
        )

        self.store.save_diagnosis(report, snapshot=snap, expected_category="VxlanMtuMismatch")

        counts = self.store.table_counts()
        self.assertEqual(counts["incidents"], 1)
        self.assertEqual(counts["dr_verifications"], 1)
        self.assertEqual(counts["guardrail_audit_log"], 2)

        retrieved = self.store.get_incident("TEST-INC-001")
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved["incident_id"], "TEST-INC-001")
        self.assertEqual(retrieved["severity"], "critical")
        self.assertEqual(retrieved["namespace"], "prod")
        self.assertEqual(retrieved["service"], "api-gateway")
        self.assertEqual(retrieved["diagnosed_category"], "VxlanMtuMismatch")
        self.assertTrue(retrieved["prompt_injection_neutralized"])
        self.assertEqual(len(retrieved["dr_verifications"]), 1)
        self.assertEqual(retrieved["dr_verifications"][0]["snapshot_id"], "snap-TEST-001")
        self.assertEqual(len(retrieved["guardrail_audit_log"]), 2)

    def test_foreign_key_cascade_deletion(self) -> None:
        dr = DrRestoreResult(
            snapshot_id="snap-CASCADE-001",
            sha256_digest="1234567890abcdef",
            tables_restored=2,
            rows_verified=50,
            foreign_key_check_passed=True,
            rto_ms=2.8,
            rpo_seconds=0,
        )
        report = IncidentDiagnosisReport(
            incident_id="INC-CASCADE",
            alert_name="CascadeAlert",
            diagnosed_category="NodeDiskPressure",
            confidence=0.88,
            cited_runbook_id="RB-003",
            cited_runbook_title="Node Disk Pressure",
            root_cause_summary="Disk full",
            agent_findings=[],
            approved_readonly_commands=[],
            blocked_unsafe_commands=["rm -rf /var/lib/containerd/*"],
            prompt_injection_neutralized=True,
            dr_drill_result=dr,
            triage_latency_ms=1.5,
        )
        self.store.save_diagnosis(report)
        self.assertEqual(self.store.table_counts()["incidents"], 1)
        self.assertEqual(self.store.table_counts()["dr_verifications"], 1)
        self.assertEqual(self.store.table_counts()["guardrail_audit_log"], 1)

        # Deleting the parent incident row must cascade to DR & audit logs
        with self.store._transaction() as cur:
            cur.execute("DELETE FROM incidents WHERE incident_id = 'INC-CASCADE'")

        counts = self.store.table_counts()
        self.assertEqual(counts["incidents"], 0)
        self.assertEqual(counts["dr_verifications"], 0)
        self.assertEqual(counts["guardrail_audit_log"], 0)

    def test_summary_stats_calculation(self) -> None:
        # Initially empty stats
        stats = self.store.get_summary_stats()
        self.assertEqual(stats["total_incidents_triaged"], 0)
        self.assertEqual(stats["dr_drills_total"], 0)

        # Insert two incidents
        r1 = IncidentDiagnosisReport(
            incident_id="INC-S1",
            alert_name="A1",
            diagnosed_category="OOMKilled",
            confidence=0.95,
            cited_runbook_id="RB-002",
            cited_runbook_title="Cgroup OOM",
            root_cause_summary="OOMKilled",
            agent_findings=[],
            approved_readonly_commands=[],
            blocked_unsafe_commands=[],
            prompt_injection_neutralized=False,
            dr_drill_result=None,
            triage_latency_ms=1.2,
        )
        r2 = IncidentDiagnosisReport(
            incident_id="INC-S2",
            alert_name="A2",
            diagnosed_category="PostgresConnectionExhaustion",
            confidence=0.85,
            cited_runbook_id="RB-005",
            cited_runbook_title="Postgres Connections",
            root_cause_summary="Deadlock",
            agent_findings=[],
            approved_readonly_commands=[],
            blocked_unsafe_commands=["DROP TABLE test;"],
            prompt_injection_neutralized=True,
            dr_drill_result=DrRestoreResult(
                snapshot_id="snap-S2",
                sha256_digest="digest-s2",
                tables_restored=2,
                rows_verified=50,
                foreign_key_check_passed=True,
                rto_ms=4.0,
                rpo_seconds=0,
            ),
            triage_latency_ms=3.8,
        )
        self.store.save_diagnosis(r1, expected_category="OOMKilled")
        self.store.save_diagnosis(r2, expected_category="PostgresConnectionExhaustion")

        updated = self.store.get_summary_stats()
        self.assertEqual(updated["total_incidents_triaged"], 2)
        self.assertEqual(updated["labeled_incidents"], 2)
        self.assertEqual(updated["correct_diagnoses"], 2)
        self.assertEqual(updated["accuracy"], 1.0)
        self.assertEqual(updated["prompt_injections_neutralized"], 1)
        self.assertEqual(updated["guardrail_blocked_commands_total"], 1)
        self.assertEqual(updated["dr_drills_passed"], 1)
        self.assertAlmostEqual(updated["mean_rto_ms"], 4.0, places=2)
        self.assertAlmostEqual(updated["mean_confidence"], 0.90, places=2)


class TestPrometheusMetricsRegistry(unittest.TestCase):
    def setUp(self) -> None:
        self.reg = PrometheusMetricsRegistry(runbooks_indexed=8)

    def test_basic_counters_gauges_and_histograms(self) -> None:
        rendered = self.reg.render()
        self.assertIn("# HELP sentinel_incidents_triaged_total", rendered)
        self.assertIn("# TYPE sentinel_incidents_triaged_total counter", rendered)
        self.assertIn("sentinel_runbooks_indexed 8", rendered)
        self.assertIn("sentinel_up 1", rendered)

    def test_record_triage_and_dr_drill(self) -> None:
        dr = DrRestoreResult(
            snapshot_id="snap-REG-01",
            sha256_digest="digest-reg",
            tables_restored=2,
            rows_verified=50,
            foreign_key_check_passed=True,
            rto_ms=5.2,
            rpo_seconds=0,
        )
        report = IncidentDiagnosisReport(
            incident_id="INC-REG-01",
            alert_name="RegAlert",
            diagnosed_category="PostgresConnectionExhaustion",
            confidence=0.91,
            cited_runbook_id="RB-005",
            cited_runbook_title="Postgres Connections",
            root_cause_summary="Lock contention",
            agent_findings=[],
            approved_readonly_commands=[],
            blocked_unsafe_commands=["rm -rf /", "DROP TABLE users;"],
            prompt_injection_neutralized=True,
            dr_drill_result=dr,
            triage_latency_ms=4.8,
        )
        self.reg.record_triage(report, severity="critical")

        out = self.reg.render()
        self.assertIn('sentinel_incidents_triaged_total{category="PostgresConnectionExhaustion",severity="critical"} 1', out)
        self.assertIn("sentinel_guardrail_blocked_commands_total 2", out)
        self.assertIn("sentinel_prompt_injections_neutralized_total 1", out)
        self.assertIn('sentinel_dr_restore_drills_total{status="passed"} 1', out)
        self.assertIn("sentinel_dr_restore_rto_milliseconds_count 1", out)
        self.assertIn("sentinel_triage_latency_milliseconds_count 1", out)


class TestSentinelApiAndService(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory(prefix="sentinel_test_api_")
        self.db_path = Path(self.tmp_dir.name) / "sentinel.db"
        self.store = IncidentPersistenceStore(str(self.db_path))
        self.coordinator = SentinelCoordinator(run_dr_drills=True)
        self.metrics = PrometheusMetricsRegistry(runbooks_indexed=8)
        self.events = EventBroadcaster()
        self.service = SentinelService(
            store=self.store,
            coordinator=self.coordinator,
            metrics=self.metrics,
            events=self.events,
        )
        self.app = create_wsgi_app(self.service)
        self.client = WsgiTestClient(self.app)

    def tearDown(self) -> None:
        self.store.close()
        self.tmp_dir.cleanup()

    def test_healthz_endpoint(self) -> None:
        code, headers, body = self.client.get("/api/v1/healthz")
        self.assertEqual(code, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["service"], "sentinel-sre")
        self.assertEqual(data["runbooks_indexed"], 8)
        self.assertEqual(data["database"]["backend"], "sqlite")
        self.assertEqual(data["database"]["journal_mode"].lower(), "wal")
        self.assertTrue(data["database"]["foreign_keys"])

    def test_stats_endpoint(self) -> None:
        code, _, body = self.client.get("/api/v1/stats")
        self.assertEqual(code, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data["total_incidents_triaged"], 0)
        self.assertEqual(data["runbooks_indexed"], 8)
        self.assertEqual(data["chaos_scenarios_available"], 24)

    def test_chaos_inject_inc_001_vxlan_mtu_blackhole(self) -> None:
        code, _, body = self.client.post("/api/v1/chaos/inject/INC-001")
        self.assertEqual(code, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data["scenario_id"], "INC-001")
        self.assertEqual(data["count"], 1)
        report = data["reports"][0]
        self.assertEqual(report["incident_id"], "INC-001")
        self.assertEqual(report["diagnosed_category"], "VxlanMtuMismatch")
        self.assertEqual(report["cited_runbook_id"], "RB-004")
        self.assertTrue(report["diagnosis_correct"])
        self.assertTrue(report["runbook_correct"])

        # Check persistence in store
        persisted = self.store.get_incident("INC-001")
        self.assertIsNotNone(persisted)
        self.assertEqual(persisted["diagnosed_category"], "VxlanMtuMismatch")
        self.assertEqual(persisted["cited_runbook_id"], "RB-004")

    def test_chaos_inject_inc_004_postgres_deadlock(self) -> None:
        code, _, body = self.client.post("/api/v1/chaos/inject/INC-004")
        self.assertEqual(code, 200)
        data = json.loads(body.decode("utf-8"))
        report = data["reports"][0]
        self.assertEqual(report["incident_id"], "INC-004")
        self.assertEqual(report["diagnosed_category"], "PostgresConnectionExhaustion")
        self.assertEqual(report["cited_runbook_id"], "RB-005")
        # Must have triggered a cryptographic DR verification drill
        self.assertIsNotNone(report["dr_drill_result"])
        self.assertTrue(report["dr_drill_result"]["foreign_key_check_passed"])
        self.assertEqual(report["dr_drill_result"]["tables_restored"], 2)
        self.assertEqual(report["dr_drill_result"]["rows_verified"], 50)

        # Wait-For Graph metrics must be surfaced
        wfg = report["wait_for_graph"]
        self.assertGreaterEqual(wfg["deadlock_cycles_found"], 1)

    def test_chaos_inject_inc_007_adversarial_prompt_injection(self) -> None:
        code, _, body = self.client.post("/api/v1/chaos/inject/INC-007")
        self.assertEqual(code, 200)
        data = json.loads(body.decode("utf-8"))
        report = data["reports"][0]
        self.assertEqual(report["incident_id"], "INC-007")
        self.assertTrue(report["prompt_injection_neutralized"])
        self.assertGreaterEqual(len(report["blocked_unsafe_commands"]), 1)
        self.assertTrue(any("DROP TABLE" in cmd for cmd in report["blocked_unsafe_commands"]))
        self.assertTrue(report["adversarial_intercepted"])

        # Verify audit log in store
        persisted = self.store.get_incident("INC-007")
        self.assertIsNotNone(persisted)
        audit_log = persisted["guardrail_audit_log"]
        self.assertGreaterEqual(len(audit_log), 1)
        self.assertTrue(any("DROP TABLE" in str(entry["blocked_command"]) for entry in audit_log))

    def test_chaos_inject_unknown_scenario_returns_404(self) -> None:
        code, _, body = self.client.post("/api/v1/chaos/inject/INC-999")
        self.assertEqual(code, 404)
        data = json.loads(body.decode("utf-8"))
        self.assertIn("Unknown chaos scenario", data["detail"])

    def test_list_and_get_incidents(self) -> None:
        self.client.post("/api/v1/chaos/inject/INC-001")
        self.client.post("/api/v1/chaos/inject/INC-004")

        code, _, body = self.client.get("/api/v1/incidents")
        self.assertEqual(code, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data["total"], 2)
        self.assertEqual(len(data["incidents"]), 2)

        code_single, _, body_single = self.client.get("/api/v1/incidents/INC-001")
        self.assertEqual(code_single, 200)
        inc = json.loads(body_single.decode("utf-8"))
        self.assertEqual(inc["incident_id"], "INC-001")
        self.assertIn("wait_for_graph", inc)
        self.assertIn("agent_findings", inc)

        code_404, _, _ = self.client.get("/api/v1/incidents/NOT-FOUND")
        self.assertEqual(code_404, 404)

    def test_custom_telemetry_triage_endpoint(self) -> None:
        payload = {
            "incident_id": "CUSTOM-OOM-01",
            "alert_name": "ContainerOOMKilled",
            "severity": "critical",
            "namespace": "production",
            "service": "batch-processor",
            "summary": "Process terminated with exit code 137",
            "description": "Kernel invoked OOM killer",
            "cgroup_memory_current_mb": 512,
            "cgroup_memory_max_mb": 512,
            "cgroup_oom_kill_count": 4,
            "container_exit_code": 137,
        }
        code, _, body = self.client.post("/api/v1/triage", body=payload)
        self.assertEqual(code, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data["incident_id"], "CUSTOM-OOM-01")
        self.assertEqual(data["diagnosed_category"], "OOMKilled")
        self.assertEqual(data["cited_runbook_id"], "RB-002")

        # Persistence check
        self.assertTrue(self.store.incident_exists("CUSTOM-OOM-01"))

    def test_on_demand_dr_drill_endpoint(self) -> None:
        # Standalone on-demand drill without linked incident
        code, _, body = self.client.post("/api/v1/dr/drill", body={})
        self.assertEqual(code, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertTrue(data["foreign_key_check_passed"])
        self.assertEqual(data["tables_restored"], 2)
        self.assertEqual(data["rows_verified"], 50)
        self.assertGreater(data["rto_ms"], 0.0)

        # Check list DR endpoint
        code_dr, _, body_dr = self.client.get("/api/v1/dr/verifications")
        self.assertEqual(code_dr, 200)
        dr_data = json.loads(body_dr.decode("utf-8"))
        self.assertEqual(dr_data["count"], 1)

    def test_metrics_endpoint(self) -> None:
        self.client.post("/api/v1/chaos/inject/INC-001")
        code, headers, body = self.client.get("/metrics")
        self.assertEqual(code, 200)
        self.assertIn("text/plain", headers["content-type"])
        text = body.decode("utf-8")
        self.assertIn('sentinel_incidents_triaged_total{category="VxlanMtuMismatch",severity="critical"} 1', text)
        self.assertIn("sentinel_runbooks_indexed 8", text)

    def test_sse_streaming_chaos(self) -> None:
        code, headers, body = self.client.get("/api/v1/chaos/stream/INC-001")
        self.assertEqual(code, 200)
        self.assertIn("text/event-stream", headers["content-type"])
        raw = body.decode("utf-8")
        self.assertIn("event: chaos.run.started", raw)
        self.assertIn("event: incident.triaged", raw)
        self.assertIn("event: chaos.run.completed", raw)

    def test_cors_options_preflight(self) -> None:
        code, headers, _ = self.client.options(
            "/api/v1/triage",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
        self.assertEqual(code, 204)
        self.assertEqual(headers.get("access-control-allow-origin"), "http://localhost:3000")
        self.assertIn("POST", headers.get("access-control-allow-methods", ""))


if __name__ == "__main__":
    unittest.main()
