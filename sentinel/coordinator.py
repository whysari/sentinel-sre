from __future__ import annotations

import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import List

from sentinel.agents import ComputeRuntimeAgent, DatabaseStorageAgent, NetworkSdnAgent
from sentinel.dr_engine import CryptographicDrEngine
from sentinel.guardrails import ZeroTrustGuardrail
from sentinel.models import AgentFinding, IncidentDiagnosisReport, TelemetrySnapshot
from sentinel.rag import HybridRunbookEngine


class SentinelCoordinator:
    """
    Multi-Agent SRE Coordinator:
    1. Scrubs untrusted telemetry for adversarial prompt injections
    2. Dispatches NetworkSdnAgent, DatabaseStorageAgent, and ComputeRuntimeAgent in parallel
    3. Fuses sub-agent telemetry findings with the Hybrid BM25/Cosine Runbook RAG engine via RRF
    4. Audits all candidate diagnostic commands through the shlex Zero-Trust Read-Only Guardrail
    5. Executes a cryptographic SQLite/PostgreSQL backup & restore drill when storage/DB state is at risk
    """

    def __init__(self, run_dr_drills: bool = True) -> None:
        self.net_agent = NetworkSdnAgent()
        self.db_agent = DatabaseStorageAgent()
        self.compute_agent = ComputeRuntimeAgent()
        self.rag = HybridRunbookEngine()
        self.dr_engine = CryptographicDrEngine()
        self.run_dr_drills = run_dr_drills

    def diagnose(self, snap: TelemetrySnapshot) -> IncidentDiagnosisReport:
        t0 = time.perf_counter()

        # 1. Adversarial Prompt Injection Firewall
        injection_detected, scrubbed = ZeroTrustGuardrail.detect_and_scrub_injection(
            snap.summary,
            snap.description,
            snap.raw_logs,
            " ".join(snap.proposed_commands),
        )
        clean_summary, clean_desc, clean_logs, _ = scrubbed

        # 2. Parallel Multi-Agent Introspection
        with ThreadPoolExecutor(max_workers=3) as pool:
            f_net = pool.submit(self.net_agent.analyze, snap)
            f_db = pool.submit(self.db_agent.analyze, snap)
            f_comp = pool.submit(self.compute_agent.analyze, snap)
            findings: List[AgentFinding] = [f_net.result(), f_db.result(), f_comp.result()]

        # 3. Hybrid BM25 + Cosine + Sub-Agent Prior RRF Retrieval
        evidence_blob = " ".join(ev for f in findings for ev in f.evidence)
        query = f"{snap.alert_name} {clean_summary} {clean_desc} {clean_logs} {evidence_blob}"
        matches = self.rag.retrieve_and_fuse(query, findings, top_k=3)
        top_match = matches[0]

        # 4. Calibrate confidence from RRF margin and sub-agent agreement
        runner_up_rrf = matches[1].rrf_score if len(matches) > 1 else 0.0
        rrf_margin = max(top_match.rrf_score - runner_up_rrf, 0.0)
        confidence = round(min(0.99, max(0.75, 0.78 + rrf_margin * 0.85)), 2)

        # 5. Collect and audit all diagnostic commands through ZeroTrustGuardrail
        inline_backtick_cmds = self._extract_backtick_commands(snap.raw_logs + "\n" + snap.description)
        candidate_cmds: List[str] = []
        for f in findings:
            if f.anomaly_detected:
                candidate_cmds.extend(f.diagnostic_commands)
        candidate_cmds.extend(top_match.safe_commands)
        candidate_cmds.extend(snap.proposed_commands)
        candidate_cmds.extend(inline_backtick_cmds)

        approved_cmds, blocked_cmds = ZeroTrustGuardrail.audit_commands(candidate_cmds)

        # 6. Trigger Cryptographic Backup & Restore Verification Drill for stateful incidents
        dr_result = None
        if self.run_dr_drills and top_match.category in ("PostgresConnectionExhaustion", "NodeDiskPressure"):
            dr_result = self.dr_engine.run_verified_restore_drill(snap.incident_id)

        primary_evidence = [ev for f in findings if f.anomaly_detected for ev in f.evidence]
        root_cause_summary = (
            primary_evidence[0]
            if primary_evidence
            else f"Correlated telemetry matches {top_match.category} ({top_match.runbook_id})."
        )

        elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 3)
        return IncidentDiagnosisReport(
            incident_id=snap.incident_id,
            alert_name=snap.alert_name,
            diagnosed_category=top_match.category,
            confidence=confidence,
            cited_runbook_id=top_match.runbook_id,
            cited_runbook_title=top_match.title,
            root_cause_summary=root_cause_summary,
            agent_findings=findings,
            approved_readonly_commands=approved_cmds[:4],
            blocked_unsafe_commands=blocked_cmds,
            prompt_injection_neutralized=injection_detected,
            dr_drill_result=dr_result,
            triage_latency_ms=elapsed_ms,
        )

    @staticmethod
    def _extract_backtick_commands(text: str) -> List[str]:
        extracted: List[str] = []
        for m in re.finditer(r"`([^`]+)`", text):
            cmd = m.group(1).strip()
            if any(
                cmd.lower().startswith(p)
                for p in ("kubectl ", "rm ", "drop ", "truncate ", "curl ", "systemctl ", "kill ")
            ):
                extracted.append(cmd)
        return extracted
