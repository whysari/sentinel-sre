from __future__ import annotations

import math
import re
from collections import Counter
from typing import Dict, List

from sentinel.models import AgentFinding, RunbookMatch

TOKEN_PATTERN = re.compile(r"[a-z0-9_./:-]+")


def tokenize(text: str) -> List[str]:
    tokens: List[str] = []
    for raw in TOKEN_PATTERN.findall(text.lower()):
        tokens.append(raw)
        for part in re.split(r"[-_./:]+", raw):
            if len(part) >= 2 and part != raw:
                tokens.append(part)
    return tokens


# Production SRE Runbook Knowledge Base (RB-001 .. RB-008)
RUNBOOK_CORPUS: List[Dict[str, object]] = [
    {
        "runbook_id": "RB-001",
        "category": "CrashLoopBackOff",
        "title": "Kubernetes Pod CrashLoopBackOff & Startup Exit Code 1/139 Triage",
        "keywords": "CrashLoopBackOff PodCrashLooping Back-off restarting failed container exit code 1 2 139 ConfigMap Secret missing env readOnlyRootFilesystem PermissionError",
        "safe_commands": [
            "kubectl get pods -n production -o wide",
            "kubectl logs -l app.kubernetes.io/name=api -n production --previous --tail=100",
            "kubectl describe pod -l app.kubernetes.io/name=api -n production",
        ],
        "remediation_steps": [
            "Inspect previous container logs (--previous) to isolate unhandled startup exception or missing Secret/ConfigMap key.",
            "Verify securityContext readOnlyRootFilesystem mounts a writable emptyDir at /tmp.",
        ],
    },
    {
        "runbook_id": "RB-002",
        "category": "OOMKilled",
        "title": "Linux Cgroup v2 Memory Exhaustion & Container OOMKilled (Exit Code 137)",
        "keywords": "OOMKilled exit code 137 SIGKILL cgroup memory.current memory.max memory.events oom_kill container_memory_working_set_bytes out of memory",
        "safe_commands": [
            "kubectl top pod -n production --containers",
            "kubectl describe pod -l app.kubernetes.io/name=api -n production",
            "promql:container_memory_working_set_bytes{namespace=\"production\"}",
        ],
        "remediation_steps": [
            "Compare container_memory_working_set_bytes against resources.limits.memory and worker count.",
            "Right-size memory limits or bound worker concurrency and streaming payload buffers.",
        ],
    },
    {
        "runbook_id": "RB-003",
        "category": "NodeDiskPressure",
        "title": "Kubelet NodeDiskPressure Eviction & Containerd OverlayFS / Log Saturation",
        "keywords": "NodeDiskPressure NodeDiskPressureWarning DiskPressure evicted nodefs.available inodes /var/lib/containerd /var/log/pods ENOSPC no space left on device",
        "safe_commands": [
            "df -h / /var/lib/containerd /var/log/pods",
            "du -xhd2 /var/log/pods /var/lib/containerd",
            "kubectl describe node worker-01",
        ],
        "remediation_steps": [
            "Prune unused containerd images and configure kubelet containerLogMaxSize=20Mi and imageGCHighThresholdPercent=75.",
            "Execute cryptographic DR backup/restore drill to verify zero stateful corruption after pod eviction.",
        ],
    },
    {
        "runbook_id": "RB-004",
        "category": "VxlanMtuMismatch",
        "title": "OpenStack Neutron OVS VXLAN 50-Byte Encapsulation MTU 1450 Drop & PMTUD Blackhole",
        "keywords": "VxlanMtuMismatch VXLAN MTU 1450 1500 br-int br-ex Open vSwitch OVS Frag needed and DF set ICMP Type 3 Code 4 TLS handshake timeout ApiHighLatencyP95 packet drop PMTUD",
        "safe_commands": [
            "ping -M do -s 1422 -c 3 10.0.10.15",
            "ovs-vsctl show",
            "ip -d link show br-int",
        ],
        "remediation_steps": [
            "Set guest/pod interface MTU to 1450 (or 1400 for nested CNI over OpenStack VXLAN) to account for the 50-byte VXLAN encapsulation header.",
            "Allow ICMP Type 3 Code 4 (fragmentation-needed) in Neutron security groups to restore Path MTU Discovery.",
        ],
    },
    {
        "runbook_id": "RB-005",
        "category": "PostgresConnectionExhaustion",
        "title": "PostgreSQL Wait-For Graph Lock Deadlocks, Idle-in-Transaction Blockers & Connection Saturation",
        "keywords": "PostgresConnectionExhaustion PostgreSQL SQLSTATE 53300 remaining connection slots are reserved max_connections pg_stat_activity pg_locks deadlock cycle AccessExclusiveLock idle in transaction PgBouncer",
        "safe_commands": [
            "promql:pg_stat_activity_count{datname=\"production\"}",
            "kubectl logs -l app.kubernetes.io/name=api -n production --tail=50",
            "kubectl get hpa -n production",
        ],
        "remediation_steps": [
            "Identify root blocker PID or deadlock cycle from the pg_locks Wait-For Graph and enforce statement_timeout and idle_in_transaction_session_timeout.",
            "Route application replicas through PgBouncer transaction pooling and verify ACID ledger integrity via DR restore drill.",
        ],
    },
    {
        "runbook_id": "RB-006",
        "category": "CoreDnsFailure",
        "title": "Kubernetes CoreDNS SERVFAIL & Linux Netfilter nf_conntrack Table Exhaustion",
        "keywords": "CoreDnsFailure CoreDNS SERVFAIL NXDOMAIN kube-dns Temporary failure in name resolution nf_conntrack conntrack table full UDP DNS drop",
        "safe_commands": [
            "kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide",
            "kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50",
            "dig +short kubernetes.default.svc.cluster.local",
        ],
        "remediation_steps": [
            "Verify kube-dns endpoints, NetworkPolicy UDP/TCP port 53 egress rules, and node net.netfilter.nf_conntrack_max sysctl limits.",
        ],
    },
    {
        "runbook_id": "RB-007",
        "category": "TlsCertExpiry",
        "title": "Ingress X.509 TLS Certificate Expiry & cert-manager ACME Challenge Failure",
        "keywords": "TlsCertExpiry TLS x509 certificate has expired cert-manager ACME HTTP-01 DNS-01 challenge order probe_ssl_earliest_cert_expiry",
        "safe_commands": [
            "kubectl get certificate,certificaterequest,order,challenge -A",
            "kubectl describe challenge -n production",
            "kubectl logs -n cert-manager -l app=cert-manager --tail=50",
        ],
        "remediation_steps": [
            "Inspect cert-manager Challenge status; ensure /.well-known/acme-challenge/ is whitelisted in Ingress and NetworkPolicy.",
        ],
    },
    {
        "runbook_id": "RB-008",
        "category": "ImagePullBackOff",
        "title": "Container Registry ImagePullBackOff, ErrImagePull & ImagePullSecrets RBAC",
        "keywords": "ImagePullBackOff ErrImagePull manifest unknown 401 Unauthorized 403 Forbidden ghcr.io imagePullSecrets toomanyrequests",
        "safe_commands": [
            "kubectl describe pod -l app.kubernetes.io/name=api -n production",
            "kubectl get events -n production --sort-by=.lastTimestamp",
        ],
        "remediation_steps": [
            "Verify container image digest exists in registry and ServiceAccount references a valid imagePullSecret.",
        ],
    },
]


class HybridRunbookEngine:
    """
    Combines BM25 lexical scoring, TF-IDF Cosine similarity, and Sub-Agent Anomaly Priors
    via Reciprocal Rank Fusion (RRF, k=60).
    """

    def __init__(self) -> None:
        self.docs: List[Dict[str, object]] = []
        self.df: Counter[str] = Counter()
        self.avg_dl: float = 1.0
        self._build_index()

    def _build_index(self) -> None:
        total_tokens = 0
        for item in RUNBOOK_CORPUS:
            full_text = f"{item['title']} {item['category']} {item['keywords']} {' '.join(item['remediation_steps'])}"
            tokens = tokenize(full_text)
            tf = Counter(tokens)
            for term in tf:
                self.df[term] += 1
            total_tokens += len(tokens)
            self.docs.append({**item, "tokens": tokens, "tf": tf, "dl": len(tokens)})
        self.avg_dl = total_tokens / max(len(self.docs), 1)

    def retrieve_and_fuse(
        self,
        query_text: str,
        agent_findings: List[AgentFinding],
        top_k: int = 3,
    ) -> List[RunbookMatch]:
        q_tokens = tokenize(query_text)
        q_tf = Counter(q_tokens)
        n_docs = len(self.docs)
        k1, b = 1.5, 0.75

        agent_category_boost: Dict[str, float] = {}
        for f in agent_findings:
            if f.anomaly_detected and f.primary_category != "Healthy":
                agent_category_boost[f.primary_category] = max(
                    agent_category_boost.get(f.primary_category, 0.0),
                    f.severity_score,
                )

        raw_scores: List[Dict[str, object]] = []
        for doc in self.docs:
            tf: Counter[str] = doc["tf"]  # type: ignore[assignment]
            dl: int = doc["dl"]  # type: ignore[assignment]
            bm25 = 0.0
            dot = 0.0
            q_norm = 0.0
            d_norm = 0.0

            for term, q_cnt in q_tf.items():
                df_t = self.df.get(term, 0)
                idf = math.log(1.0 + (n_docs - df_t + 0.5) / (df_t + 0.5))
                f_td = tf.get(term, 0)
                if f_td > 0:
                    bm25 += idf * ((f_td * (k1 + 1.0)) / (f_td + k1 * (1.0 - b + b * (dl / self.avg_dl))))
                qw = (1.0 + math.log(q_cnt)) * idf
                dw = (1.0 + math.log(f_td)) * idf if f_td > 0 else 0.0
                dot += qw * dw
                q_norm += qw * qw

            for term, d_cnt in tf.items():
                df_t = self.df.get(term, 0)
                idf = math.log(1.0 + (n_docs - df_t + 0.5) / (df_t + 0.5))
                dw = (1.0 + math.log(d_cnt)) * idf
                d_norm += dw * dw

            cosine = dot / (math.sqrt(q_norm) * math.sqrt(d_norm) + 1e-9)
            cat = str(doc["category"])
            agent_prior = agent_category_boost.get(cat, 0.0)

            raw_scores.append(
                {
                    "doc": doc,
                    "bm25": bm25,
                    "cosine": cosine,
                    "agent_prior": agent_prior,
                }
            )

        # Rank by BM25, Cosine, and Agent Prior, then compute Reciprocal Rank Fusion (RRF)
        bm25_order = sorted(raw_scores, key=lambda x: float(x["bm25"]), reverse=True)
        cos_order = sorted(raw_scores, key=lambda x: float(x["cosine"]), reverse=True)
        prior_order = sorted(
            raw_scores,
            key=lambda x: (float(x["agent_prior"]), float(x["bm25"])),
            reverse=True,
        )

        rrf_k = 10.0
        matches: List[RunbookMatch] = []
        for entry in raw_scores:
            doc = entry["doc"]  # type: ignore[assignment]
            r_bm25 = bm25_order.index(entry) + 1
            r_cos = cos_order.index(entry) + 1
            r_prior = prior_order.index(entry) + 1

            rrf = (
                (1.0 / (rrf_k + r_bm25))
                + (1.0 / (rrf_k + r_cos))
                + (2.2 / (rrf_k + r_prior))
                + float(entry["agent_prior"]) * 0.25
            )
            matches.append(
                RunbookMatch(
                    runbook_id=str(doc["runbook_id"]),
                    title=str(doc["title"]),
                    category=str(doc["category"]),
                    bm25_score=round(float(entry["bm25"]), 4),
                    cosine_score=round(float(entry["cosine"]), 4),
                    rrf_score=round(rrf, 4),
                    safe_commands=list(doc["safe_commands"]),  # type: ignore[arg-type]
                    remediation_steps=list(doc["remediation_steps"]),  # type: ignore[arg-type]
                )
            )

        matches.sort(key=lambda m: m.rrf_score, reverse=True)
        return matches[:top_k]
