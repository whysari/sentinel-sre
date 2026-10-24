"""Validation tests for Docker, PostgreSQL, Prometheus, Grafana, and Kubernetes deployment configs."""

from __future__ import annotations

import json
from pathlib import Path
import unittest


PROJECT_ROOT = Path(__file__).resolve().parent.parent


class TestDeployConfigs(unittest.TestCase):
    """Ensure container, observability, and Kubernetes manifests meet production SRE hardening standards."""

    def test_required_deploy_files_exist_and_non_empty(self) -> None:
        required_files = [
            "Dockerfile.backend",
            "frontend/Dockerfile",
            "docker-compose.yml",
            "deploy/postgres/init.sql",
            "deploy/prometheus/prometheus.yml",
            "deploy/prometheus/alert_rules.yml",
            "deploy/grafana/provisioning/datasources/datasource.yml",
            "deploy/grafana/provisioning/dashboards/dashboard.yml",
            "deploy/grafana/dashboards/sentinel-sre.json",
            "deploy/k8s/sentinel-sre.yaml",
        ]
        for rel_path in required_files:
            file_path = PROJECT_ROOT / rel_path
            self.assertTrue(file_path.exists(), f"Missing file: {rel_path}")
            self.assertGreater(file_path.stat().st_size, 0, f"File is empty: {rel_path}")

    def test_dockerfile_backend_installs_production_dependencies_and_non_root_uid(self) -> None:
        dockerfile_text = (PROJECT_ROOT / "Dockerfile.backend").read_text(encoding="utf-8")
        self.assertIn("fastapi", dockerfile_text)
        self.assertIn("uvicorn", dockerfile_text)
        self.assertIn("psycopg", dockerfile_text)
        self.assertIn("redis", dockerfile_text)
        self.assertIn("10001", dockerfile_text)
        self.assertIn("HEALTHCHECK", dockerfile_text)

    def test_docker_compose_defines_all_six_services(self) -> None:
        compose_text = (PROJECT_ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        services = ["sentinel-api", "sentinel-web", "postgres", "redis", "prometheus", "grafana"]
        for svc in services:
            self.assertIn(f"{svc}:", compose_text, f"Missing service {svc} in docker-compose.yml")

    def test_grafana_dashboard_json_and_metrics(self) -> None:
        dash_path = PROJECT_ROOT / "deploy/grafana/dashboards/sentinel-sre.json"
        content = dash_path.read_text(encoding="utf-8")
        data = json.loads(content)
        self.assertEqual(data.get("title"), "Sentinel-SRE Multi-Agent Operations & Zero-Trust Guardrails")
        self.assertGreaterEqual(len(data.get("panels", [])), 6)

        expected_metrics = [
            "sentinel_incidents_triaged_total",
            "sentinel_prompt_injections_neutralized_total",
            "sentinel_guardrail_blocked_commands_total",
            "sentinel_dr_restore_drills_total",
            "sentinel_dr_restore_rto_milliseconds_bucket",
            "sentinel_triage_latency_milliseconds_bucket",
        ]
        for metric in expected_metrics:
            self.assertIn(metric, content, f"Metric {metric} missing from Grafana dashboard")

    def test_k8s_manifest_security_mounts_and_network_policy(self) -> None:
        k8s_text = (PROJECT_ROOT / "deploy/k8s/sentinel-sre.yaml").read_text(encoding="utf-8")
        self.assertIn("kind: Namespace", k8s_text)
        self.assertIn("name: sentinel-sre", k8s_text)
        self.assertIn("runAsNonRoot: true", k8s_text)
        self.assertIn("readOnlyRootFilesystem: true", k8s_text)
        self.assertIn("seccompProfile:", k8s_text)
        self.assertIn("RuntimeDefault", k8s_text)
        self.assertIn("emptyDir:", k8s_text)
        self.assertIn("mountPath: /data", k8s_text)
        self.assertIn("kind: NetworkPolicy", k8s_text)
        self.assertIn("/api/v1/healthz", k8s_text)


if __name__ == "__main__":
    unittest.main()
