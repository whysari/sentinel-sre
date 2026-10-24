"""
Sentinel-SRE production API service.

Wires :class:`SentinelCoordinator`, :class:`IncidentPersistenceStore`,
:class:`PrometheusMetricsRegistry` and the SSE :class:`EventBroadcaster` together behind a
framework-agnostic :class:`SentinelService`, exposed through two interchangeable transports:

* **FastAPI / ASGI** (``create_fastapi_app``) when ``fastapi`` is installed —
  ``uvicorn sentinel.api:app``.
* **Standard-library WSGI** (``create_wsgi_app``) with zero third-party dependencies —
  ``python3 -m sentinel.api --server wsgi`` (also servable by gunicorn / uWSGI).

Both transports share the same route table, payload validation, CORS policy and handlers.

Endpoints
---------
``GET  /api/v1/healthz``                       service health, DB row counts, indexed runbooks
``GET  /api/v1/stats``                         aggregated executive-dashboard KPIs
``GET  /api/v1/incidents``                     persisted incident reports (``?limit=&offset=``)
``GET  /api/v1/incidents/{incident_id}``       full report + Wait-For Graph + guardrail + DR audit
``POST /api/v1/triage``                        ingest a ``TelemetrySnapshot`` JSON payload
``GET  /api/v1/chaos/scenarios``               catalog of the 24 chaos fault-injection scenarios
``POST /api/v1/chaos/inject/{scenario_id}``    run ``INC-001``..``INC-024`` or ``all``
``GET  /api/v1/chaos/stream/{scenario_id}``    same as inject, streamed live as SSE frames
``POST /api/v1/dr/drill``                      on-demand cryptographic backup/restore drill
``GET  /api/v1/dr/verifications``              persisted DR verification history
``GET  /api/v1/events/stream``                 live SSE feed of all triage / chaos / DR events
``GET  /metrics``                              Prometheus text exposition format
"""
from __future__ import annotations

import argparse
import dataclasses
import functools
import http
import importlib.util
import json
import logging
import math
import os
import re
import socketserver
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Pattern, Tuple
from urllib.parse import parse_qs, unquote

from sentinel import __version__
from sentinel.agents import DatabaseStorageAgent
from sentinel.coordinator import SentinelCoordinator
from sentinel.events import SSE_CONTENT_TYPE, SSE_HEADERS, EventBroadcaster, encode_sse
from sentinel.metrics import PROMETHEUS_CONTENT_TYPE, PrometheusMetricsRegistry
from sentinel.models import DrRestoreResult, IncidentDiagnosisReport, PgSessionNode, TelemetrySnapshot
from sentinel.store import IncidentPersistenceStore

logger = logging.getLogger("sentinel.api")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CHAOS_CATALOG_PATH = PROJECT_ROOT / "benchmarks" / "run_benchmark.py"
DEFAULT_CORS_ORIGINS: Tuple[str, ...] = ("http://localhost:3000", "http://127.0.0.1:3000")
MAX_BODY_BYTES = 1024 * 1024
MAX_TEXT_FIELD_CHARS = 100_000
MAX_LIST_ITEMS = 256
INCIDENT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

# Backwards-compatible module-level coordinator (pre-existing public symbol).
coordinator = SentinelCoordinator(run_dr_drills=True)


# =============================================================================================
# Errors & payload validation
# =============================================================================================


class ApiError(Exception):
    """Transport-agnostic HTTP error raised by service handlers."""

    def __init__(self, status: int, detail: Any) -> None:
        super().__init__(str(detail))
        self.status = status
        self.detail = detail


def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")


def _coerce_bool(name: str, value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    if isinstance(value, str) and value.strip().lower() in ("true", "1", "yes", "on", "false", "0", "no", "off"):
        return value.strip().lower() in ("true", "1", "yes", "on")
    raise ApiError(422, f"Field '{name}' must be a boolean")


def _coerce_int(name: str, value: Any) -> int:
    if isinstance(value, bool):
        raise ApiError(422, f"Field '{name}' must be an integer")
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            pass
    raise ApiError(422, f"Field '{name}' must be an integer")


def _coerce_float(name: str, value: Any) -> float:
    if isinstance(value, bool):
        raise ApiError(422, f"Field '{name}' must be a number")
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise ApiError(422, f"Field '{name}' must be a number") from None
    if not math.isfinite(out):
        raise ApiError(422, f"Field '{name}' must be finite")
    return out


def _coerce_str(name: str, value: Any) -> str:
    if isinstance(value, (dict, list)):
        raise ApiError(422, f"Field '{name}' must be a string")
    text = "" if value is None else str(value)
    if len(text) > MAX_TEXT_FIELD_CHARS:
        raise ApiError(422, f"Field '{name}' exceeds {MAX_TEXT_FIELD_CHARS} characters")
    return text


def _coerce_str_list(name: str, value: Any) -> List[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_LIST_ITEMS:
        raise ApiError(422, f"Field '{name}' must be a list of at most {MAX_LIST_ITEMS} strings")
    return [_coerce_str(f"{name}[{i}]", v) for i, v in enumerate(value)]


def _parse_pg_session(idx: int, raw: Any) -> PgSessionNode:
    if not isinstance(raw, dict):
        raise ApiError(422, f"pg_sessions[{idx}] must be an object")
    prefix = f"pg_sessions[{idx}]"
    try:
        blocking = raw.get("blocking_pids", []) or []
        if not isinstance(blocking, list):
            raise ApiError(422, f"{prefix}.blocking_pids must be a list of integers")
        wait_type = raw.get("wait_event_type")
        wait_event = raw.get("wait_event")
        return PgSessionNode(
            pid=_coerce_int(f"{prefix}.pid", raw["pid"]),
            usename=_coerce_str(f"{prefix}.usename", raw.get("usename", "")),
            application_name=_coerce_str(f"{prefix}.application_name", raw.get("application_name", "")),
            state=_coerce_str(f"{prefix}.state", raw.get("state", "active")),
            wait_event_type=None if wait_type is None else _coerce_str(f"{prefix}.wait_event_type", wait_type),
            wait_event=None if wait_event is None else _coerce_str(f"{prefix}.wait_event", wait_event),
            blocking_pids=[_coerce_int(f"{prefix}.blocking_pids", p) for p in blocking],
            query=_coerce_str(f"{prefix}.query", raw.get("query", "")),
            xact_duration_sec=_coerce_float(f"{prefix}.xact_duration_sec", raw.get("xact_duration_sec", 0.0)),
            lock_mode=_coerce_str(f"{prefix}.lock_mode", raw.get("lock_mode", "RowExclusiveLock")),
        )
    except KeyError as exc:
        raise ApiError(422, f"{prefix} is missing required field {exc}") from None


_STRING_FIELD_DEFAULTS: Dict[str, str] = {
    "alert_name": "UnknownAlert",
    "severity": "critical",
    "namespace": "production",
    "service": "api",
    "summary": "",
    "description": "",
}


def telemetry_from_payload(payload: Any) -> TelemetrySnapshot:
    """Validate and coerce an untrusted JSON payload into a :class:`TelemetrySnapshot`."""
    if not isinstance(payload, dict):
        raise ApiError(422, "Request body must be a JSON object")

    incident_id = payload.get("incident_id")
    if incident_id in (None, ""):
        incident_id = f"INC-API-{uuid.uuid4().hex[:10].upper()}"
    incident_id = _coerce_str("incident_id", incident_id)
    if not INCIDENT_ID_RE.match(incident_id):
        raise ApiError(422, "Field 'incident_id' must match [A-Za-z0-9][A-Za-z0-9._:-]{0,127}")

    kwargs: Dict[str, Any] = {"incident_id": incident_id}
    for f in dataclasses.fields(TelemetrySnapshot):
        name = f.name
        if name == "incident_id":
            continue
        if name in _STRING_FIELD_DEFAULTS:
            kwargs[name] = _coerce_str(name, payload.get(name, _STRING_FIELD_DEFAULTS[name]))
        elif name == "pg_sessions":
            sessions = payload.get("pg_sessions") or []
            if not isinstance(sessions, list) or len(sessions) > MAX_LIST_ITEMS:
                raise ApiError(422, f"Field 'pg_sessions' must be a list of at most {MAX_LIST_ITEMS} objects")
            kwargs[name] = [_parse_pg_session(i, s) for i, s in enumerate(sessions)]
        elif name == "proposed_commands":
            kwargs[name] = _coerce_str_list(name, payload.get(name))
        elif name in payload and payload[name] is not None:
            default = f.default
            value = payload[name]
            if isinstance(default, bool):
                kwargs[name] = _coerce_bool(name, value)
            elif isinstance(default, int):
                kwargs[name] = _coerce_int(name, value)
            elif isinstance(default, float):
                kwargs[name] = _coerce_float(name, value)
            else:
                kwargs[name] = _coerce_str(name, value)
    return TelemetrySnapshot(**kwargs)


# =============================================================================================
# Chaos scenario catalog (single source of truth: benchmarks/run_benchmark.py)
# =============================================================================================

ChaosScenario = Tuple[TelemetrySnapshot, str, str, bool]


@functools.lru_cache(maxsize=1)
def _chaos_catalog_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("_sentinel_chaos_catalog", CHAOS_CATALOG_PATH)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise RuntimeError(f"Unable to load chaos scenario catalog from {CHAOS_CATALOG_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_chaos_scenarios() -> List[ChaosScenario]:
    """Fresh copies of the 24 fault-injection scenarios defined by the benchmark harness."""
    return list(_chaos_catalog_module().build_24_chaos_scenarios())


# =============================================================================================
# Service layer
# =============================================================================================


def _build_wait_for_graph(snap: TelemetrySnapshot) -> Dict[str, Any]:
    """Materialise the PostgreSQL Wait-For Graph from ``pg_stat_activity`` / ``pg_locks`` sessions.

    The returned payload is what the Next.js ``<WaitForGraphVisualizer />`` renders: every backend
    session becomes a node, every ``waiter -> blocker`` relationship an edge, DFS-detected circular
    deadlocks are surfaced in ``deadlock_cycles`` and head-of-line blockers in ``root_blockers``.
    """
    sessions = list(snap.pg_sessions or [])
    cycles, root_blockers = DatabaseStorageAgent._analyze_wait_for_graph(sessions)
    cycle_members = {pid for cycle in cycles for pid in cycle}
    blocked_counts = {blocker_pid: count for blocker_pid, count, _ in root_blockers}
    root_blocker_pids = [blocker_pid for blocker_pid, _, _ in root_blockers]

    nodes: List[Dict[str, Any]] = []
    for session in sessions:
        nodes.append(
            {
                "pid": int(session.pid),
                "usename": session.usename,
                "application_name": session.application_name,
                "state": session.state,
                "wait_event_type": session.wait_event_type,
                "wait_event": session.wait_event,
                "blocking_pids": [int(pid) for pid in session.blocking_pids],
                "query": session.query,
                "xact_duration_sec": float(session.xact_duration_sec),
                "lock_mode": session.lock_mode,
                "is_cycle_member": session.pid in cycle_members,
                "is_root_blocker": session.pid in blocked_counts,
                "blocked_count": int(blocked_counts.get(session.pid, 0)),
            }
        )

    edges: List[Dict[str, Any]] = []
    by_pid = {session.pid: session for session in sessions}
    for session in sessions:
        for blocker_pid in session.blocking_pids:
            blocker = by_pid.get(blocker_pid)
            edges.append(
                {
                    "waiter_pid": int(session.pid),
                    "blocker_pid": int(blocker_pid),
                    "waiter_application": session.application_name,
                    "blocker_application": None if blocker is None else blocker.application_name,
                    "lock_mode": None if blocker is None else blocker.lock_mode,
                    "wait_event": session.wait_event,
                    "wait_event_type": session.wait_event_type,
                }
            )

    return {
        "nodes": nodes,
        "edges": edges,
        "deadlock_cycles": [list(map(int, cycle)) for cycle in cycles],
        "root_blockers": [
            {
                "pid": int(blocker_pid),
                "blocked_count": int(count),
                "state": node.state,
                "lock_mode": node.lock_mode,
                "xact_duration_sec": float(node.xact_duration_sec),
                "query": node.query,
                "application_name": node.application_name,
            }
            for blocker_pid, count, node in root_blockers
        ],
        "deadlock_cycles_found": len(cycles),
        "root_blocker_pids": [int(pid) for pid in root_blocker_pids],
        "pg_connection_ratio": round(
            snap.pg_active_connections / max(snap.pg_max_connections, 1), 4
        ),
        "lock_evidence": [],
        "source": "pg_stat_activity+pg_locks",
    }


def _wait_for_graph_view(report: Dict[str, Any], materialised: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    view: Dict[str, Any] = {
        "deadlock_cycles_found": 0,
        "root_blocker_pids": [],
        "pg_connection_ratio": 0.0,
        "lock_evidence": [],
    }
    for finding in report.get("agent_findings", []):
        if finding.get("agent_name") == "DatabaseStorageAgent":
            metrics = finding.get("structured_metrics", {}) or {}
            view = {
                "deadlock_cycles_found": int(metrics.get("deadlock_cycles_found", 0) or 0),
                "root_blocker_pids": list(metrics.get("root_blocker_pids", []) or []),
                "pg_connection_ratio": float(metrics.get("pg_connection_ratio", 0.0) or 0.0),
                "lock_evidence": [
                    ev for ev in finding.get("evidence", []) if "Wait-For Graph" in ev or "blocker PID" in ev
                ],
            }
            break
    if materialised:
        merged = {**view, **materialised}
        merged["lock_evidence"] = view["lock_evidence"] or materialised.get("lock_evidence", [])
        return merged
    return view


class SentinelService:
    """Framework-agnostic orchestration of triage, persistence, metrics and event streaming."""

    def __init__(
        self,
        store: Optional[IncidentPersistenceStore] = None,
        coordinator: Optional[SentinelCoordinator] = None,
        metrics: Optional[PrometheusMetricsRegistry] = None,
        events: Optional[EventBroadcaster] = None,
        database_url: Optional[str] = None,
    ) -> None:
        self.coordinator = coordinator or SentinelCoordinator(run_dr_drills=True)
        self.store = store or IncidentPersistenceStore(database_url)
        self.metrics = metrics or PrometheusMetricsRegistry(runbooks_indexed=self.runbooks_indexed)
        self.metrics.runbooks_indexed.set(self.runbooks_indexed)
        self.events = events or EventBroadcaster()
        self.started_at = time.time()

    @property
    def runbooks_indexed(self) -> int:
        return len(self.coordinator.rag.docs)

    # ---- Read endpoints --------------------------------------------------------------------

    def healthz(self) -> Dict[str, Any]:
        try:
            rows = self.store.table_counts()
            db = {
                "backend": self.store.backend,
                "status": "ok",
                "journal_mode": self.store.journal_mode,
                "foreign_keys": self.store.foreign_keys_enabled,
                "rows": rows,
            }
            status = "ok"
        except Exception as exc:  # pragma: no cover - exercised only on DB failure
            logger.exception("Health check database probe failed")
            db = {"backend": self.store.backend, "status": "error", "error": str(exc), "rows": {}}
            status = "degraded"
        body = {
            "status": status,
            "service": "sentinel-sre",
            "version": __version__,
            "uptime_seconds": round(time.time() - self.started_at, 3),
            "runbooks_indexed": self.runbooks_indexed,
            "sse_subscribers": self.events.subscriber_count,
            "database": db,
        }
        if status != "ok":
            raise ApiError(503, body)
        return body

    def stats(self) -> Dict[str, Any]:
        stats = self.store.get_summary_stats()
        stats["runbooks_indexed"] = self.runbooks_indexed
        stats["chaos_scenarios_available"] = len(load_chaos_scenarios())
        stats["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        return stats

    def list_incidents(self, limit: int = 50, offset: int = 0) -> Dict[str, Any]:
        if not 1 <= limit <= 500:
            raise ApiError(422, "Query parameter 'limit' must be between 1 and 500")
        if offset < 0:
            raise ApiError(422, "Query parameter 'offset' must be >= 0")
        incidents = self.store.list_incidents(limit=limit, offset=offset)
        total = self.store.table_counts()["incidents"]
        return {"total": total, "count": len(incidents), "limit": limit, "offset": offset, "incidents": incidents}

    def get_incident(self, incident_id: str) -> Dict[str, Any]:
        report = self.store.get_incident(incident_id)
        if report is None:
            raise ApiError(404, f"Incident '{incident_id}' not found")
        report["wait_for_graph"] = _wait_for_graph_view(report, report.get("wait_for_graph"))
        return report

    def list_dr_verifications(self, limit: int = 50) -> Dict[str, Any]:
        if not 1 <= limit <= 500:
            raise ApiError(422, "Query parameter 'limit' must be between 1 and 500")
        rows = self.store.list_dr_verifications(limit)
        return {"count": len(rows), "verifications": rows}

    def chaos_catalog(self) -> Dict[str, Any]:
        scenarios = [
            {
                "scenario_id": snap.incident_id,
                "alert_name": snap.alert_name,
                "severity": snap.severity,
                "service": snap.service,
                "summary": snap.summary,
                "expected_category": exp_cat,
                "expected_runbook_id": exp_rb,
                "is_adversarial": is_adv,
            }
            for snap, exp_cat, exp_rb, is_adv in load_chaos_scenarios()
        ]
        return {"count": len(scenarios), "scenarios": scenarios}

    def metrics_text(self) -> str:
        return self.metrics.render()

    # ---- Write endpoints -------------------------------------------------------------------

    def _ingest(
        self,
        snap: TelemetrySnapshot,
        source: str,
        expected_category: Optional[str] = None,
    ) -> Tuple[IncidentDiagnosisReport, Dict[str, Any]]:
        try:
            report = self.coordinator.diagnose(snap)
        except RuntimeError as exc:
            # CryptographicDrEngine raises RuntimeError when restore integrity verification fails.
            self.metrics.record_dr_drill(None, passed=False)
            self.events.publish("dr.drill.failed", {"incident_id": snap.incident_id, "error": str(exc)})
            raise ApiError(500, f"Triage failed for {snap.incident_id}: {exc}") from exc

        # Materialise the pg_locks Wait-For Graph before persisting so it survives in raw_report_json.
        report.wait_for_graph = _build_wait_for_graph(snap)
        self.store.save_diagnosis(report, snapshot=snap, expected_category=expected_category)
        self.metrics.record_triage(report, severity=snap.severity)

        body = report.to_dict()
        body.update(
            {
                "severity": snap.severity,
                "namespace": snap.namespace,
                "service": snap.service,
                "expected_category": expected_category,
                "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "wait_for_graph": _wait_for_graph_view(body, body.get("wait_for_graph")),
            }
        )
        dr = report.dr_drill_result
        self.events.publish(
            "incident.triaged",
            {
                "source": source,
                "incident_id": report.incident_id,
                "alert_name": report.alert_name,
                "severity": snap.severity,
                "service": snap.service,
                "diagnosed_category": report.diagnosed_category,
                "confidence": report.confidence,
                "cited_runbook_id": report.cited_runbook_id,
                "prompt_injection_neutralized": report.prompt_injection_neutralized,
                "blocked_command_count": len(report.blocked_unsafe_commands),
                "dr_drill_passed": None if dr is None else dr.foreign_key_check_passed,
                "triage_latency_ms": report.triage_latency_ms,
            },
        )
        return report, body

    def triage(self, payload: Any) -> Dict[str, Any]:
        snap = telemetry_from_payload(payload)
        _, body = self._ingest(snap, source="api")
        return body

    def _select_scenarios(self, scenario_id: str) -> List[ChaosScenario]:
        catalog = load_chaos_scenarios()
        wanted = scenario_id.strip().upper()
        if wanted == "ALL":
            return catalog
        selected = [s for s in catalog if s[0].incident_id.upper() == wanted]
        if not selected:
            valid = ", ".join(s[0].incident_id for s in catalog)
            raise ApiError(404, f"Unknown chaos scenario '{scenario_id}'. Valid: all, {valid}")
        return selected

    def _run_chaos(self, scenarios: List[ChaosScenario]) -> Iterator[Dict[str, Any]]:
        for snap, exp_cat, exp_rb, is_adv in scenarios:
            report, body = self._ingest(snap, source="chaos", expected_category=exp_cat)
            body.update(
                {
                    "expected_category": exp_cat,
                    "expected_runbook_id": exp_rb,
                    "is_adversarial": is_adv,
                    "diagnosis_correct": report.diagnosed_category == exp_cat,
                    "runbook_correct": report.cited_runbook_id == exp_rb,
                    "adversarial_intercepted": (
                        report.prompt_injection_neutralized and bool(report.blocked_unsafe_commands)
                    )
                    if is_adv
                    else None,
                }
            )
            yield body

    @staticmethod
    def _evaluate(reports: List[Dict[str, Any]]) -> Dict[str, Any]:
        n = len(reports)
        correct = sum(1 for r in reports if r["diagnosis_correct"])
        rb_correct = sum(1 for r in reports if r["runbook_correct"])
        adv = [r for r in reports if r["is_adversarial"]]
        adv_ok = sum(1 for r in adv if r["adversarial_intercepted"])
        dr = [r["dr_drill_result"] for r in reports if r.get("dr_drill_result")]
        return {
            "total": n,
            "correct_category": correct,
            "correct_runbook": rb_correct,
            "accuracy": round(correct / n, 4) if n else 0.0,
            "runbook_recall_at_1": round(rb_correct / n, 4) if n else 0.0,
            "adversarial_total": len(adv),
            "adversarial_intercepted": adv_ok,
            "dr_drills_passed": sum(1 for d in dr if d["foreign_key_check_passed"]),
        }

    def inject_chaos(self, scenario_id: str) -> Dict[str, Any]:
        scenarios = self._select_scenarios(scenario_id)
        reports = list(self._run_chaos(scenarios))
        evaluation = self._evaluate(reports)
        self.events.publish("chaos.run.completed", {"scenario_id": scenario_id, **evaluation})
        return {"scenario_id": scenario_id, "count": len(reports), "evaluation": evaluation, "reports": reports}

    def stream_chaos(self, scenario_id: str) -> Iterator[str]:
        """Validate eagerly (so 404s surface before headers are sent), then stream SSE frames."""
        scenarios = self._select_scenarios(scenario_id)

        def frames() -> Iterator[str]:
            yield encode_sse("chaos.run.started", {"scenario_id": scenario_id, "total": len(scenarios)}, 0)
            reports: List[Dict[str, Any]] = []
            try:
                for idx, body in enumerate(self._run_chaos(scenarios), start=1):
                    reports.append(body)
                    yield encode_sse("incident.triaged", {"index": idx, "total": len(scenarios), "report": body}, idx)
            except ApiError as exc:
                yield encode_sse("error", {"status": exc.status, "detail": exc.detail})
                return
            evaluation = self._evaluate(reports)
            self.events.publish("chaos.run.completed", {"scenario_id": scenario_id, **evaluation})
            yield encode_sse("chaos.run.completed", {"scenario_id": scenario_id, **evaluation}, len(reports) + 1)

        return frames()

    def run_dr_drill(self, payload: Any = None) -> Dict[str, Any]:
        payload = payload or {}
        if not isinstance(payload, dict):
            raise ApiError(422, "Request body must be a JSON object")
        incident_id = payload.get("incident_id")
        if incident_id is not None:
            incident_id = _coerce_str("incident_id", incident_id)
            if not self.store.incident_exists(incident_id):
                raise ApiError(404, f"Incident '{incident_id}' not found; cannot link DR drill")
        label = f"{incident_id or 'DRILL'}-{_utc_stamp()}-{uuid.uuid4().hex[:6]}"
        try:
            result: DrRestoreResult = self.coordinator.dr_engine.run_verified_restore_drill(label)
        except RuntimeError as exc:
            self.metrics.record_dr_drill(None, passed=False)
            self.events.publish("dr.drill.failed", {"incident_id": incident_id, "error": str(exc)})
            raise ApiError(500, f"DR restore verification failed: {exc}") from exc
        self.store.save_dr_verification(result, incident_id=incident_id)
        self.metrics.record_dr_drill(result)
        body = {**dataclasses.asdict(result), "incident_id": incident_id}
        self.events.publish("dr.drill.completed", body)
        return body

    def event_stream(self, last_event_id: Optional[str] = None, heartbeat_seconds: float = 15.0) -> Iterator[str]:
        last_id: Optional[int] = None
        if last_event_id not in (None, ""):
            try:
                last_id = int(str(last_event_id))
            except ValueError:
                raise ApiError(422, "Last-Event-ID must be an integer") from None
        return self.events.stream(last_event_id=last_id, heartbeat_seconds=heartbeat_seconds)


# =============================================================================================
# Transport-agnostic routing
# =============================================================================================


@dataclass
class ApiRequest:
    method: str
    path: str
    query: Dict[str, List[str]] = field(default_factory=dict)
    headers: Dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    params: Dict[str, str] = field(default_factory=dict)

    def json(self, required: bool = True) -> Any:
        if not self.body.strip():
            if required:
                raise ApiError(422, "A JSON object request body is required")
            return None
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"Malformed JSON body: {exc}") from None

    def query_int(self, name: str, default: int) -> int:
        values = self.query.get(name)
        if not values:
            return default
        try:
            return int(values[-1])
        except ValueError:
            raise ApiError(422, f"Query parameter '{name}' must be an integer") from None

    def query_float(self, name: str, default: float) -> float:
        values = self.query.get(name)
        if not values:
            return default
        try:
            return float(values[-1])
        except ValueError:
            raise ApiError(422, f"Query parameter '{name}' must be a number") from None


@dataclass
class ApiResponse:
    status: int = 200
    body: Any = None
    text: Optional[str] = None
    stream: Optional[Iterator[str]] = None
    content_type: str = "application/json"
    headers: Dict[str, str] = field(default_factory=dict)


Handler = Callable[[SentinelService, ApiRequest], ApiResponse]


def _json(body: Any, status: int = 200) -> ApiResponse:
    return ApiResponse(status=status, body=body)


def _sse(stream: Iterator[str]) -> ApiResponse:
    return ApiResponse(stream=stream, content_type=SSE_CONTENT_TYPE, headers=dict(SSE_HEADERS))


ROUTES: List[Tuple[str, str, Handler]] = [
    ("GET", "/api/v1/healthz", lambda s, r: _json(s.healthz())),
    ("GET", "/api/v1/stats", lambda s, r: _json(s.stats())),
    (
        "GET",
        "/api/v1/incidents",
        lambda s, r: _json(s.list_incidents(r.query_int("limit", 50), r.query_int("offset", 0))),
    ),
    ("GET", "/api/v1/incidents/{incident_id}", lambda s, r: _json(s.get_incident(r.params["incident_id"]))),
    ("POST", "/api/v1/triage", lambda s, r: _json(s.triage(r.json()))),
    ("GET", "/api/v1/chaos/scenarios", lambda s, r: _json(s.chaos_catalog())),
    ("POST", "/api/v1/chaos/inject/{scenario_id}", lambda s, r: _json(s.inject_chaos(r.params["scenario_id"]))),
    ("GET", "/api/v1/chaos/stream/{scenario_id}", lambda s, r: _sse(s.stream_chaos(r.params["scenario_id"]))),
    ("POST", "/api/v1/chaos/stream/{scenario_id}", lambda s, r: _sse(s.stream_chaos(r.params["scenario_id"]))),
    ("POST", "/api/v1/dr/drill", lambda s, r: _json(s.run_dr_drill(r.json(required=False)))),
    ("GET", "/api/v1/dr/verifications", lambda s, r: _json(s.list_dr_verifications(r.query_int("limit", 50)))),
    (
        "GET",
        "/api/v1/events/stream",
        lambda s, r: _sse(
            s.event_stream(
                r.headers.get("last-event-id") or (r.query.get("last_event_id") or [None])[-1],
                heartbeat_seconds=max(0.05, r.query_float("heartbeat", 15.0)),
            )
        ),
    ),
    (
        "GET",
        "/metrics",
        lambda s, r: ApiResponse(text=s.metrics_text(), content_type=PROMETHEUS_CONTENT_TYPE),
    ),
]


class Router:
    def __init__(self, routes: Iterable[Tuple[str, str, Handler]] = ROUTES) -> None:
        self._routes: List[Tuple[str, Pattern[str], Handler]] = []
        for method, template, handler in routes:
            pattern = "^" + re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", template) + "/?$"
            self._routes.append((method, re.compile(pattern), handler))

    def dispatch(self, service: SentinelService, request: ApiRequest) -> ApiResponse:
        allowed: List[str] = []
        for method, pattern, handler in self._routes:
            match = pattern.match(request.path)
            if not match:
                continue
            if method != request.method:
                allowed.append(method)
                continue
            request.params = {k: unquote(v) for k, v in match.groupdict().items()}
            return handler(service, request)
        if allowed:
            resp = _json({"detail": f"Method {request.method} not allowed"}, 405)
            resp.headers["Allow"] = ", ".join(sorted(set(allowed + ["OPTIONS"])))
            return resp
        raise ApiError(404, f"No route for {request.method} {request.path}")


def resolve_cors_origins(origins: Optional[Iterable[str]] = None) -> List[str]:
    if origins is not None:
        return [o.strip() for o in origins if o.strip()]
    env = os.environ.get("SENTINEL_CORS_ORIGINS")
    if env:
        return [o.strip() for o in env.split(",") if o.strip()]
    return list(DEFAULT_CORS_ORIGINS)


# =============================================================================================
# Standard-library WSGI transport
# =============================================================================================


class _ClosingStream:
    """WSGI iterable that encodes SSE text chunks and propagates ``close()`` to the generator."""

    def __init__(self, stream: Iterator[str]) -> None:
        self._stream = stream

    def __iter__(self) -> Iterator[bytes]:
        for chunk in self._stream:
            yield chunk.encode("utf-8")

    def close(self) -> None:
        close = getattr(self._stream, "close", None)
        if close is not None:
            close()


def create_wsgi_app(
    service: Optional[SentinelService] = None,
    cors_origins: Optional[Iterable[str]] = None,
) -> Callable[..., Iterable[bytes]]:
    """Build a PEP 3333 WSGI application exposing the full Sentinel-SRE API."""
    svc = service or get_service()
    router = Router()
    allowed_origins = resolve_cors_origins(cors_origins)
    allow_any = "*" in allowed_origins

    def cors_headers(origin: Optional[str]) -> List[Tuple[str, str]]:
        if allow_any:
            return [("Access-Control-Allow-Origin", "*")]
        if origin and origin in allowed_origins:
            return [("Access-Control-Allow-Origin", origin), ("Vary", "Origin")]
        return []

    def status_line(code: int) -> str:
        try:
            return f"{code} {http.HTTPStatus(code).phrase}"
        except ValueError:  # pragma: no cover
            return f"{code} Unknown"

    def app(environ: Dict[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
        method = str(environ.get("REQUEST_METHOD", "GET")).upper()
        path = environ.get("PATH_INFO") or "/"
        origin = environ.get("HTTP_ORIGIN")
        cors = cors_headers(origin)

        if method == "OPTIONS":
            req_headers = environ.get("HTTP_ACCESS_CONTROL_REQUEST_HEADERS") or "Content-Type, Last-Event-ID"
            start_response(
                status_line(204),
                cors
                + [
                    ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
                    ("Access-Control-Allow-Headers", req_headers),
                    ("Access-Control-Max-Age", "600"),
                    ("Content-Length", "0"),
                ],
            )
            return [b""]

        try:
            try:
                length = int(environ.get("CONTENT_LENGTH") or 0)
            except ValueError:
                raise ApiError(400, "Invalid Content-Length header") from None
            if length > MAX_BODY_BYTES:
                raise ApiError(413, f"Request body exceeds {MAX_BODY_BYTES} bytes")
            body = environ["wsgi.input"].read(length) if length > 0 else b""
            headers = {
                k[5:].replace("_", "-").lower(): str(v) for k, v in environ.items() if k.startswith("HTTP_")
            }
            request = ApiRequest(
                method=method,
                path=path,
                query=parse_qs(environ.get("QUERY_STRING", ""), keep_blank_values=False),
                headers=headers,
                body=body,
            )
            resp = router.dispatch(svc, request)
        except ApiError as exc:
            resp = _json({"detail": exc.detail}, exc.status)
        except Exception:  # pragma: no cover - defensive catch-all
            logger.exception("Unhandled error serving %s %s", method, path)
            resp = _json({"detail": "Internal server error"}, 500)

        out_headers = [("Content-Type", resp.content_type)] + cors + list(resp.headers.items())
        if resp.stream is not None:
            start_response(status_line(resp.status), out_headers)
            return _ClosingStream(resp.stream)

        if resp.text is not None:
            payload = resp.text.encode("utf-8")
        else:
            payload = json.dumps(resp.body, default=str).encode("utf-8")
        out_headers.append(("Content-Length", str(len(payload))))
        start_response(status_line(resp.status), out_headers)
        return [payload]

    app.service = svc  # type: ignore[attr-defined]
    return app


# =============================================================================================
# FastAPI / ASGI transport (optional dependency)
# =============================================================================================


def fastapi_available() -> bool:
    return importlib.util.find_spec("fastapi") is not None


def create_fastapi_app(
    service: Optional[SentinelService] = None,
    cors_origins: Optional[Iterable[str]] = None,
) -> Any:
    """Build the FastAPI application. Raises ``RuntimeError`` if FastAPI is not installed."""
    try:
        from fastapi import Body, FastAPI, Header, Query
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
    except ImportError as exc:
        raise RuntimeError("FastAPI is not installed; use create_wsgi_app() instead") from exc

    svc = service or get_service()
    origins = resolve_cors_origins(cors_origins)
    api = FastAPI(
        title="Sentinel-SRE",
        version=__version__,
        description="Multi-agent incident triage, zero-trust guardrails and verified DR drills.",
    )
    api.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials="*" not in origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )
    api.state.service = svc

    @api.exception_handler(ApiError)
    async def _api_error_handler(_request, exc):  # type: ignore[no-untyped-def]
        return JSONResponse(status_code=exc.status, content={"detail": exc.detail})

    def sse_response(stream: Iterator[str]):  # type: ignore[no-untyped-def]
        return StreamingResponse(stream, media_type="text/event-stream", headers=dict(SSE_HEADERS))

    @api.get("/api/v1/healthz", tags=["ops"])
    def healthz() -> Dict[str, Any]:
        return svc.healthz()

    @api.get("/api/v1/stats", tags=["dashboard"])
    def stats() -> Dict[str, Any]:
        return svc.stats()

    @api.get("/api/v1/incidents", tags=["incidents"])
    def list_incidents(
        limit: int = Query(50, ge=1, le=500),
        offset: int = Query(0, ge=0),
    ) -> Dict[str, Any]:
        return svc.list_incidents(limit, offset)

    @api.get("/api/v1/incidents/{incident_id}", tags=["incidents"])
    def get_incident(incident_id: str) -> Dict[str, Any]:
        return svc.get_incident(incident_id)

    @api.post("/api/v1/triage", tags=["incidents"])
    def triage(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
        return svc.triage(payload)

    @api.get("/api/v1/chaos/scenarios", tags=["chaos"])
    def chaos_scenarios() -> Dict[str, Any]:
        return svc.chaos_catalog()

    @api.post("/api/v1/chaos/inject/{scenario_id}", tags=["chaos"])
    def chaos_inject(scenario_id: str) -> Dict[str, Any]:
        return svc.inject_chaos(scenario_id)

    @api.api_route("/api/v1/chaos/stream/{scenario_id}", methods=["GET", "POST"], tags=["chaos"])
    def chaos_stream(scenario_id: str):  # type: ignore[no-untyped-def]
        return sse_response(svc.stream_chaos(scenario_id))

    @api.post("/api/v1/dr/drill", tags=["dr"])
    def dr_drill(payload: Optional[Dict[str, Any]] = Body(None)) -> Dict[str, Any]:
        return svc.run_dr_drill(payload)

    @api.get("/api/v1/dr/verifications", tags=["dr"])
    def dr_verifications(limit: int = Query(50, ge=1, le=500)) -> Dict[str, Any]:
        return svc.list_dr_verifications(limit)

    @api.get("/api/v1/events/stream", tags=["stream"])
    def events_stream(  # type: ignore[no-untyped-def]
        last_event_id: Optional[str] = Header(None, alias="Last-Event-ID"),
        last_event_id_q: Optional[str] = Query(None, alias="last_event_id"),
        heartbeat: float = Query(15.0, gt=0.0, le=300.0),
    ):
        return sse_response(svc.event_stream(last_event_id or last_event_id_q, heartbeat_seconds=heartbeat))

    @api.get("/metrics", tags=["ops"], response_class=PlainTextResponse)
    def metrics():  # type: ignore[no-untyped-def]
        return PlainTextResponse(svc.metrics_text(), media_type=PROMETHEUS_CONTENT_TYPE)

    return api


# =============================================================================================
# Default service singleton, backwards-compatible webhook handler & lazy module attributes
# =============================================================================================

_default_service: Optional[SentinelService] = None
_default_lock = threading.Lock()
_lazy_apps: Dict[str, Any] = {}


def get_service() -> SentinelService:
    """Process-wide default service (DB from ``SENTINEL_DATABASE_URL`` or ``data/sentinel.db``)."""
    global _default_service
    with _default_lock:
        if _default_service is None:
            _default_service = SentinelService(coordinator=coordinator)
        return _default_service


def handle_incident_webhook(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Triage + persist an incident webhook payload; returns the enriched diagnosis report dict."""
    return get_service().triage(payload)


def __getattr__(name: str) -> Any:
    """Lazily build ``app`` (FastAPI, or WSGI fallback) and ``wsgi_app`` so imports stay side-effect free."""
    if name in ("app", "wsgi_app"):
        with _default_lock:
            cached = _lazy_apps.get(name)
        if cached is None:
            if name == "app" and fastapi_available():
                cached = create_fastapi_app()
            else:
                cached = create_wsgi_app()
            with _default_lock:
                _lazy_apps.setdefault(name, cached)
                cached = _lazy_apps[name]
        return cached
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def serve_wsgi(host: str = "127.0.0.1", port: int = 8000, service: Optional[SentinelService] = None) -> None:
    from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

    class ThreadingWSGIServer(socketserver.ThreadingMixIn, WSGIServer):
        daemon_threads = True

    class LoggingHandler(WSGIRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
            logger.info("%s - %s", self.address_string(), format % args)

    httpd = make_server(
        host, port, create_wsgi_app(service), server_class=ThreadingWSGIServer, handler_class=LoggingHandler
    )
    logger.info("Sentinel-SRE WSGI server listening on http://%s:%d", host, port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover - interactive
        pass
    finally:
        httpd.server_close()


def main(argv: Optional[List[str]] = None) -> None:
    parser = argparse.ArgumentParser(description="Run the Sentinel-SRE API service.")
    parser.add_argument("--host", default=os.environ.get("SENTINEL_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("SENTINEL_PORT", "8000")))
    parser.add_argument("--server", choices=("auto", "fastapi", "wsgi"), default="auto")
    parser.add_argument(
        "--seed-chaos",
        action="store_true",
        help="Seed all 24 chaos & adversarial incident scenarios into the store on startup.",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    service = get_service()
    if args.seed_chaos or service.store.table_counts()["incidents"] == 0:
        result = service.inject_chaos("all")
        logger.info(
            "Seeded %d chaos scenarios (accuracy=%.1f%%, DR drills=%d)",
            result["count"],
            result["evaluation"]["accuracy"] * 100.0,
            result["evaluation"]["dr_drills_passed"],
        )

    use_fastapi = args.server == "fastapi" or (
        args.server == "auto" and fastapi_available() and importlib.util.find_spec("uvicorn") is not None
    )
    if use_fastapi:
        import uvicorn  # type: ignore[import-not-found]

        uvicorn.run(create_fastapi_app(service), host=args.host, port=args.port)
    else:
        serve_wsgi(args.host, args.port, service=service)


if __name__ == "__main__":
    main()
