"""
Transactional incident persistence for Sentinel-SRE.

``IncidentPersistenceStore`` persists every ``IncidentDiagnosisReport`` together with its
cryptographic DR verification result and the zero-trust guardrail audit trail in a single
atomic transaction.

Backends
--------
* **SQLite** (default, zero dependencies): WAL journal mode, ``foreign_keys=ON``,
  ``BEGIN IMMEDIATE`` write transactions and a process-wide re-entrant lock so a single
  connection can be safely shared across FastAPI / WSGI worker threads.
* **PostgreSQL** (optional): selected with a ``postgresql://`` URL when ``psycopg`` (v3) or
  ``psycopg2`` is installed. The schema below is written in the portable SQL subset shared
  by both engines (``TEXT`` timestamps in ISO-8601 UTC, ``ON CONFLICT ... DO UPDATE`` upserts,
  ``CASE WHEN`` boolean aggregation), so the same queries run on either backend.

Configuration: pass ``database_url`` explicitly, or set ``SENTINEL_DATABASE_URL``. Accepted
forms: ``sqlite:///relative/path.db``, ``sqlite:////abs/path.db``, ``sqlite:///:memory:``,
``:memory:``, a bare filesystem path, or ``postgresql://user:pass@host/db``.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

from sentinel.models import DrRestoreResult, IncidentDiagnosisReport, TelemetrySnapshot

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SQLITE_PATH = PROJECT_ROOT / "data" / "sentinel.db"
TABLES: Tuple[str, ...] = ("incidents", "dr_verifications", "guardrail_audit_log")

_SQLITE_SCHEMA: Tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS incidents (
        incident_id                  TEXT PRIMARY KEY,
        alert_name                   TEXT NOT NULL,
        severity                     TEXT NOT NULL,
        namespace                    TEXT NOT NULL,
        service                      TEXT NOT NULL,
        diagnosed_category           TEXT NOT NULL,
        confidence                   REAL NOT NULL,
        cited_runbook_id             TEXT NOT NULL,
        root_cause_summary           TEXT NOT NULL,
        prompt_injection_neutralized INTEGER NOT NULL DEFAULT 0
                                     CHECK (prompt_injection_neutralized IN (0, 1)),
        triage_latency_ms            REAL NOT NULL,
        expected_category            TEXT,
        raw_report_json              TEXT NOT NULL,
        created_at                   TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS dr_verifications (
        snapshot_id              TEXT PRIMARY KEY,
        incident_id              TEXT,
        sha256_digest            TEXT NOT NULL,
        tables_restored          INTEGER NOT NULL,
        rows_verified            INTEGER NOT NULL,
        foreign_key_check_passed INTEGER NOT NULL CHECK (foreign_key_check_passed IN (0, 1)),
        rto_ms                   REAL NOT NULL,
        created_at               TEXT NOT NULL,
        FOREIGN KEY (incident_id) REFERENCES incidents(incident_id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS guardrail_audit_log (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id        TEXT NOT NULL,
        blocked_command    TEXT,
        injection_detected INTEGER NOT NULL CHECK (injection_detected IN (0, 1)),
        created_at         TEXT NOT NULL,
        FOREIGN KEY (incident_id) REFERENCES incidents(incident_id) ON DELETE CASCADE
    )
    """,
)

_POSTGRES_SCHEMA: Tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS incidents (
        incident_id                  TEXT PRIMARY KEY,
        alert_name                   TEXT NOT NULL,
        severity                     TEXT NOT NULL,
        namespace                    TEXT NOT NULL,
        service                      TEXT NOT NULL,
        diagnosed_category           TEXT NOT NULL,
        confidence                   DOUBLE PRECISION NOT NULL,
        cited_runbook_id             TEXT NOT NULL,
        root_cause_summary           TEXT NOT NULL,
        prompt_injection_neutralized BOOLEAN NOT NULL DEFAULT FALSE,
        triage_latency_ms            DOUBLE PRECISION NOT NULL,
        expected_category            TEXT,
        raw_report_json              TEXT NOT NULL,
        created_at                   TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS dr_verifications (
        snapshot_id              TEXT PRIMARY KEY,
        incident_id              TEXT,
        sha256_digest            TEXT NOT NULL,
        tables_restored          INTEGER NOT NULL,
        rows_verified            INTEGER NOT NULL,
        foreign_key_check_passed BOOLEAN NOT NULL,
        rto_ms                   DOUBLE PRECISION NOT NULL,
        created_at               TEXT NOT NULL,
        FOREIGN KEY (incident_id) REFERENCES incidents(incident_id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS guardrail_audit_log (
        id                 BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        incident_id        TEXT NOT NULL,
        blocked_command    TEXT,
        injection_detected BOOLEAN NOT NULL,
        created_at         TEXT NOT NULL,
        FOREIGN KEY (incident_id) REFERENCES incidents(incident_id) ON DELETE CASCADE
    )
    """,
)

_INDEXES: Tuple[str, ...] = (
    "CREATE INDEX IF NOT EXISTS idx_incidents_created_at ON incidents (created_at)",
    "CREATE INDEX IF NOT EXISTS idx_incidents_category ON incidents (diagnosed_category)",
    "CREATE INDEX IF NOT EXISTS idx_dr_incident ON dr_verifications (incident_id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_incident ON guardrail_audit_log (incident_id)",
)

_UPSERT_INCIDENT = """
    INSERT INTO incidents (
        incident_id, alert_name, severity, namespace, service, diagnosed_category, confidence,
        cited_runbook_id, root_cause_summary, prompt_injection_neutralized, triage_latency_ms,
        expected_category, raw_report_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (incident_id) DO UPDATE SET
        alert_name = excluded.alert_name,
        severity = excluded.severity,
        namespace = excluded.namespace,
        service = excluded.service,
        diagnosed_category = excluded.diagnosed_category,
        confidence = excluded.confidence,
        cited_runbook_id = excluded.cited_runbook_id,
        root_cause_summary = excluded.root_cause_summary,
        prompt_injection_neutralized = excluded.prompt_injection_neutralized,
        triage_latency_ms = excluded.triage_latency_ms,
        expected_category = excluded.expected_category,
        raw_report_json = excluded.raw_report_json,
        created_at = excluded.created_at
"""

_UPSERT_DR = """
    INSERT INTO dr_verifications (
        snapshot_id, incident_id, sha256_digest, tables_restored, rows_verified,
        foreign_key_check_passed, rto_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (snapshot_id) DO UPDATE SET
        incident_id = excluded.incident_id,
        sha256_digest = excluded.sha256_digest,
        tables_restored = excluded.tables_restored,
        rows_verified = excluded.rows_verified,
        foreign_key_check_passed = excluded.foreign_key_check_passed,
        rto_ms = excluded.rto_ms,
        created_at = excluded.created_at
"""

_INSERT_AUDIT = """
    INSERT INTO guardrail_audit_log (incident_id, blocked_command, injection_detected, created_at)
    VALUES (?, ?, ?, ?)
"""

_INCIDENT_SUMMARY_COLUMNS = (
    "incident_id, alert_name, severity, namespace, service, diagnosed_category, confidence, "
    "cited_runbook_id, root_cause_summary, prompt_injection_neutralized, triage_latency_ms, "
    "expected_category, created_at"
)

_BOOL_COLUMNS = frozenset({"prompt_injection_neutralized", "foreign_key_check_passed", "injection_detected"})


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _percentile(sorted_values: Sequence[float], q: float) -> float:
    """Nearest-rank percentile, identical to the formula used by ``benchmarks/run_benchmark.py``."""
    if not sorted_values:
        return 0.0
    return float(sorted_values[int(q * (len(sorted_values) - 1))])


class IncidentPersistenceStore:
    """Thread-safe transactional store for incident triage reports, DR drills and guardrail audits."""

    def __init__(self, database_url: Optional[str] = None) -> None:
        url = database_url or os.environ.get("SENTINEL_DATABASE_URL") or str(DEFAULT_SQLITE_PATH)
        self._lock = threading.RLock()
        self._closed = False
        if url.startswith(("postgresql://", "postgres://")):
            self.backend = "postgresql"
            self.database_url = url
            self._conn = self._connect_postgres(url)
        else:
            self.backend = "sqlite"
            self.database_path = self._resolve_sqlite_path(url)
            self.database_url = f"sqlite:///{self.database_path}"
            self._conn = self._connect_sqlite(self.database_path)
        self._init_schema()

    # ---- Connection management -------------------------------------------------------------

    @staticmethod
    def _resolve_sqlite_path(url: str) -> str:
        path = url[len("sqlite:///"):] if url.startswith("sqlite:///") else url
        if path in ("", ":memory:"):
            return ":memory:"
        parent = Path(path).expanduser().resolve().parent
        parent.mkdir(parents=True, exist_ok=True)
        return str(Path(path).expanduser().resolve())

    @staticmethod
    def _connect_sqlite(path: str) -> sqlite3.Connection:
        conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=10.0)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        return conn

    @staticmethod
    def _connect_postgres(url: str) -> Any:
        try:
            import psycopg  # type: ignore[import-not-found]

            return psycopg.connect(url)
        except ImportError:
            pass
        try:
            import psycopg2  # type: ignore[import-not-found]

            return psycopg2.connect(url)
        except ImportError as exc:  # pragma: no cover - depends on optional driver
            raise RuntimeError(
                "PostgreSQL URL configured but neither 'psycopg' nor 'psycopg2' is installed."
            ) from exc

    def _sql(self, statement: str) -> str:
        return statement.replace("?", "%s") if self.backend == "postgresql" else statement

    def _init_schema(self) -> None:
        schema = _POSTGRES_SCHEMA if self.backend == "postgresql" else _SQLITE_SCHEMA
        with self._transaction() as cur:
            for ddl in schema + _INDEXES:
                cur.execute(ddl)

    @contextmanager
    def _transaction(self) -> Iterator[Any]:
        """Serialized read-write transaction: commits on success, rolls back on any exception."""
        with self._lock:
            if self._closed:
                raise RuntimeError("IncidentPersistenceStore is closed")
            cur = self._conn.cursor()
            if self.backend == "sqlite":
                cur.execute("BEGIN IMMEDIATE")
            try:
                yield cur
            except BaseException:
                if self.backend == "sqlite":
                    if self._conn.in_transaction:  # SQLite may already have auto-rolled back
                        cur.execute("ROLLBACK")
                else:
                    self._conn.rollback()
                raise
            else:
                if self.backend == "sqlite":
                    cur.execute("COMMIT")
                else:
                    self._conn.commit()
            finally:
                cur.close()

    def _query(self, statement: str, params: Sequence[Any] = ()) -> List[Dict[str, Any]]:
        with self._lock:
            if self._closed:
                raise RuntimeError("IncidentPersistenceStore is closed")
            cur = self._conn.cursor()
            try:
                cur.execute(self._sql(statement), tuple(params))
                columns = [d[0] for d in cur.description or ()]
                rows = [dict(zip(columns, row)) for row in cur.fetchall()]
                if self.backend == "postgresql":
                    self._conn.rollback()  # end the implicit read transaction
            finally:
                cur.close()
        for row in rows:
            for col in _BOOL_COLUMNS.intersection(row):
                if row[col] is not None:
                    row[col] = bool(row[col])
        return rows

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._conn.close()
                self._closed = True

    def __enter__(self) -> "IncidentPersistenceStore":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---- Introspection ---------------------------------------------------------------------

    @property
    def journal_mode(self) -> str:
        if self.backend != "sqlite":
            return "postgresql-wal"
        return str(self._query("PRAGMA journal_mode")[0]["journal_mode"])

    @property
    def foreign_keys_enabled(self) -> bool:
        if self.backend != "sqlite":
            return True
        return bool(self._query("PRAGMA foreign_keys")[0]["foreign_keys"])

    def table_counts(self) -> Dict[str, int]:
        return {t: int(self._query(f"SELECT COUNT(*) AS n FROM {t}")[0]["n"]) for t in TABLES}

    # ---- Writes ----------------------------------------------------------------------------

    def save_diagnosis(
        self,
        report: IncidentDiagnosisReport,
        snapshot: Optional[TelemetrySnapshot] = None,
        expected_category: Optional[str] = None,
    ) -> None:
        """
        Atomically persist a diagnosis report, its DR drill result and one guardrail audit row per
        blocked command. Re-triaging an existing ``incident_id`` upserts the incident and DR rows;
        the guardrail audit log is append-only so every blocked execution attempt stays on record.
        """
        now = _utcnow_iso()
        raw_json = json.dumps(report.to_dict(), sort_keys=True)
        severity = snapshot.severity if snapshot is not None else "unknown"
        namespace = snapshot.namespace if snapshot is not None else "unknown"
        service = snapshot.service if snapshot is not None else "unknown"

        audit_rows: List[Tuple[Any, ...]] = [
            (report.incident_id, cmd, bool(report.prompt_injection_neutralized), now)
            for cmd in report.blocked_unsafe_commands
        ]
        if not audit_rows and report.prompt_injection_neutralized:
            # Record the neutralized injection even when no executable payload was extracted.
            audit_rows.append((report.incident_id, None, True, now))

        with self._transaction() as cur:
            cur.execute(
                self._sql(_UPSERT_INCIDENT),
                (
                    report.incident_id,
                    report.alert_name,
                    severity,
                    namespace,
                    service,
                    report.diagnosed_category,
                    float(report.confidence),
                    report.cited_runbook_id,
                    report.root_cause_summary,
                    bool(report.prompt_injection_neutralized),
                    float(report.triage_latency_ms),
                    expected_category,
                    raw_json,
                    now,
                ),
            )
            if report.dr_drill_result is not None:
                self._write_dr(cur, report.dr_drill_result, report.incident_id, now)
            for row in audit_rows:
                cur.execute(self._sql(_INSERT_AUDIT), row)

    def save_dr_verification(self, result: DrRestoreResult, incident_id: Optional[str] = None) -> None:
        """Persist a standalone (on-demand) DR drill. ``incident_id`` must exist if provided."""
        with self._transaction() as cur:
            self._write_dr(cur, result, incident_id, _utcnow_iso())

    def _write_dr(self, cur: Any, result: DrRestoreResult, incident_id: Optional[str], now: str) -> None:
        cur.execute(
            self._sql(_UPSERT_DR),
            (
                result.snapshot_id,
                incident_id,
                result.sha256_digest,
                int(result.tables_restored),
                int(result.rows_verified),
                bool(result.foreign_key_check_passed),
                float(result.rto_ms),
                now,
            ),
        )

    # ---- Reads -----------------------------------------------------------------------------

    def incident_exists(self, incident_id: str) -> bool:
        return bool(self._query("SELECT 1 AS present FROM incidents WHERE incident_id = ?", (incident_id,)))

    def list_incidents(self, limit: int = 50, offset: int = 0) -> List[Dict[str, Any]]:
        limit = max(1, min(int(limit), 500))
        offset = max(0, int(offset))
        rows = self._query(
            f"""
            SELECT {_INCIDENT_SUMMARY_COLUMNS},
                   (SELECT COUNT(*) FROM dr_verifications d
                     WHERE d.incident_id = i.incident_id
                       AND d.foreign_key_check_passed) AS dr_drills_passed
              FROM incidents i
             ORDER BY created_at DESC, incident_id DESC
             LIMIT ? OFFSET ?
            """,
            (limit, offset),
        )
        for row in rows:
            row["dr_drills_passed"] = int(row["dr_drills_passed"] or 0)
        return rows

    def get_incident(self, incident_id: str) -> Optional[Dict[str, Any]]:
        rows = self._query(
            f"SELECT {_INCIDENT_SUMMARY_COLUMNS}, raw_report_json FROM incidents WHERE incident_id = ?",
            (incident_id,),
        )
        if not rows:
            return None
        row = rows[0]
        raw = row.pop("raw_report_json")
        report: Dict[str, Any] = json.loads(raw) if isinstance(raw, (str, bytes)) else dict(raw)
        report.update(
            {
                "severity": row["severity"],
                "namespace": row["namespace"],
                "service": row["service"],
                "expected_category": row["expected_category"],
                "created_at": row["created_at"],
            }
        )
        report["dr_verifications"] = self._query(
            """
            SELECT snapshot_id, incident_id, sha256_digest, tables_restored, rows_verified,
                   foreign_key_check_passed, rto_ms, created_at
              FROM dr_verifications WHERE incident_id = ? ORDER BY created_at DESC
            """,
            (incident_id,),
        )
        report["guardrail_audit_log"] = self._query(
            """
            SELECT id, incident_id, blocked_command, injection_detected, created_at
              FROM guardrail_audit_log WHERE incident_id = ? ORDER BY id
            """,
            (incident_id,),
        )
        return report

    def list_dr_verifications(self, limit: int = 50) -> List[Dict[str, Any]]:
        limit = max(1, min(int(limit), 500))
        return self._query(
            """
            SELECT snapshot_id, incident_id, sha256_digest, tables_restored, rows_verified,
                   foreign_key_check_passed, rto_ms, created_at
              FROM dr_verifications ORDER BY created_at DESC LIMIT ?
            """,
            (limit,),
        )

    def get_summary_stats(self) -> Dict[str, Any]:
        """Aggregated KPIs for the executive dashboard."""
        agg = self._query(
            """
            SELECT COUNT(*) AS total,
                   AVG(confidence) AS mean_confidence,
                   SUM(CASE WHEN prompt_injection_neutralized THEN 1 ELSE 0 END) AS injections,
                   SUM(CASE WHEN expected_category IS NOT NULL THEN 1 ELSE 0 END) AS labeled,
                   SUM(CASE WHEN expected_category IS NOT NULL
                             AND expected_category = diagnosed_category THEN 1 ELSE 0 END) AS correct,
                   MAX(created_at) AS last_incident_at
              FROM incidents
            """
        )[0]
        dr = self._query(
            """
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN foreign_key_check_passed THEN 1 ELSE 0 END) AS passed,
                   AVG(CASE WHEN foreign_key_check_passed THEN rto_ms END) AS mean_rto_ms
              FROM dr_verifications
            """
        )[0]
        audit = self._query(
            """
            SELECT SUM(CASE WHEN blocked_command IS NOT NULL THEN 1 ELSE 0 END) AS blocked
              FROM guardrail_audit_log
            """
        )[0]
        latencies = [
            float(r["triage_latency_ms"])
            for r in self._query("SELECT triage_latency_ms FROM incidents ORDER BY triage_latency_ms")
        ]
        categories = self._query(
            "SELECT diagnosed_category AS k, COUNT(*) AS n FROM incidents GROUP BY diagnosed_category"
        )
        severities = self._query("SELECT severity AS k, COUNT(*) AS n FROM incidents GROUP BY severity")

        total = int(agg["total"] or 0)
        labeled = int(agg["labeled"] or 0)
        correct = int(agg["correct"] or 0)
        return {
            "total_incidents_triaged": total,
            "mean_confidence": round(float(agg["mean_confidence"]), 4) if total else 0.0,
            "labeled_incidents": labeled,
            "correct_diagnoses": correct,
            "accuracy": round(correct / labeled, 4) if labeled else None,
            "prompt_injections_neutralized": int(agg["injections"] or 0),
            "guardrail_blocked_commands_total": int(audit["blocked"] or 0),
            "dr_drills_total": int(dr["total"] or 0),
            "dr_drills_passed": int(dr["passed"] or 0),
            "mean_rto_ms": round(float(dr["mean_rto_ms"]), 3) if dr["mean_rto_ms"] is not None else 0.0,
            "mean_latency_ms": round(sum(latencies) / len(latencies), 3) if latencies else 0.0,
            "p50_latency_ms": round(_percentile(latencies, 0.50), 3),
            "p95_latency_ms": round(_percentile(latencies, 0.95), 3),
            "category_breakdown": {r["k"]: int(r["n"]) for r in sorted(categories, key=lambda r: r["k"])},
            "severity_breakdown": {r["k"]: int(r["n"]) for r in sorted(severities, key=lambda r: r["k"])},
            "last_incident_at": agg["last_incident_at"],
        }
