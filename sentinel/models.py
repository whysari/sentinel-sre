from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List


@dataclass
class PgSessionNode:
    """Represents a PostgreSQL backend session from pg_stat_activity + pg_locks."""

    pid: int
    usename: str
    application_name: str
    state: str  # 'active', 'idle in transaction', 'idle'
    wait_event_type: str | None
    wait_event: str | None
    blocking_pids: List[int]
    query: str
    xact_duration_sec: float
    lock_mode: str = "RowExclusiveLock"


@dataclass
class TelemetrySnapshot:
    """Multi-layer Linux / OpenStack SDN / Kubernetes / PostgreSQL telemetry bundle."""

    incident_id: str
    alert_name: str
    severity: str
    namespace: str
    service: str
    summary: str
    description: str
    # Layer 1: Network & OpenStack OVS/VXLAN
    underlay_mtu: int = 1500
    overlay_vxlan_mtu: int = 1450
    pod_interface_mtu: int = 1450
    icmp_frag_needed_blocked: bool = False
    tcp_retrans_rate: float = 0.001
    conntrack_used: int = 12000
    conntrack_max: int = 131072
    dns_servfail_rate: float = 0.0
    # Layer 2: Compute / Cgroup v2 / Kubelet
    cgroup_memory_current_mb: int = 240
    cgroup_memory_max_mb: int = 512
    cgroup_oom_kill_count: int = 0
    container_exit_code: int = 0
    pod_restart_count_10m: int = 0
    node_rootfs_avail_pct: float = 68.5
    node_inodes_avail_pct: float = 89.0
    image_pull_error: str = ""
    tls_days_remaining: int = 62
    # Layer 3: Database (PostgreSQL)
    pg_active_connections: int = 24
    pg_max_connections: int = 100
    pg_sessions: List[PgSessionNode] = field(default_factory=list)
    # Raw logs & untrusted external inputs
    raw_logs: str = ""
    proposed_commands: List[str] = field(default_factory=list)


@dataclass
class AgentFinding:
    """Diagnostic output from a specialized introspection sub-agent."""

    agent_name: str
    layer: str
    anomaly_detected: bool
    primary_category: str
    severity_score: float  # 0.0 to 1.0
    evidence: List[str]
    diagnostic_commands: List[str]
    structured_metrics: Dict[str, Any] = field(default_factory=dict)


@dataclass
class RunbookMatch:
    """Ranked runbook from hybrid BM25 + TF-IDF Cosine + RRF fusion."""

    runbook_id: str
    title: str
    category: str
    bm25_score: float
    cosine_score: float
    rrf_score: float
    safe_commands: List[str]
    remediation_steps: List[str]


@dataclass
class DrRestoreResult:
    """Measured outcome of an automated cryptographic backup & restore verification drill."""

    snapshot_id: str
    sha256_digest: str
    tables_restored: int
    rows_verified: int
    foreign_key_check_passed: bool
    rto_ms: float
    rpo_seconds: int


@dataclass
class IncidentDiagnosisReport:
    """Complete multi-agent SRE triage report with guardrail audit and DR verification."""

    incident_id: str
    alert_name: str
    diagnosed_category: str
    confidence: float
    cited_runbook_id: str
    cited_runbook_title: str
    root_cause_summary: str
    agent_findings: List[AgentFinding]
    approved_readonly_commands: List[str]
    blocked_unsafe_commands: List[str]
    prompt_injection_neutralized: bool
    dr_drill_result: DrRestoreResult | None
    triage_latency_ms: float
    # Materialised PostgreSQL Wait-For Graph (nodes/edges/cycles/root blockers) captured at
    # triage time so the dashboard can render the exact pg_locks topology for an incident.
    wait_for_graph: Dict[str, Any] | None = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
