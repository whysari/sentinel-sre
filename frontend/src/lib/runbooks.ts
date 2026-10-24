/**
 * Runbook knowledge-base presentation metadata. Mirrors `sentinel/rag.py` (RB-001 … RB-008) so the
 * console can render a cited runbook without an extra API round-trip.
 */

import type { IncidentCategory, RunbookId } from "../types/sentinel";

export interface RunbookMeta {
  runbook_id: RunbookId;
  category: IncidentCategory;
  title: string;
  shortTitle: string;
  remediation: string[];
  safeCommands: string[];
}

export const RUNBOOKS: Record<RunbookId, RunbookMeta> = {
  "RB-001": {
    runbook_id: "RB-001",
    category: "CrashLoopBackOff",
    title: "Kubernetes Pod CrashLoopBackOff & Startup Exit Code 1/139 Triage",
    shortTitle: "CrashLoopBackOff recovery",
    remediation: [
      "Inspect previous container logs (--previous) to isolate the unhandled startup exception or missing Secret/ConfigMap key.",
      "Verify securityContext readOnlyRootFilesystem mounts a writable emptyDir at /tmp.",
    ],
    safeCommands: [
      "kubectl get pods -n production -o wide",
      "kubectl logs -l app.kubernetes.io/name=api -n production --previous --tail=100",
      "kubectl describe pod -l app.kubernetes.io/name=api -n production",
    ],
  },
  "RB-002": {
    runbook_id: "RB-002",
    category: "OOMKilled",
    title: "Linux Cgroup v2 Memory Exhaustion & Container OOMKilled (Exit Code 137)",
    shortTitle: "cgroup v2 OOMKilled containment",
    remediation: [
      "Compare container_memory_working_set_bytes against resources.limits.memory and effective worker count.",
      "Right-size memory limits or bound worker concurrency and streaming payload buffers.",
    ],
    safeCommands: [
      "kubectl top pod -n production --containers",
      "kubectl describe pod -l app.kubernetes.io/name=api -n production",
      'promql:container_memory_working_set_bytes{namespace="production"}',
    ],
  },
  "RB-003": {
    runbook_id: "RB-003",
    category: "NodeDiskPressure",
    title: "Kubelet NodeDiskPressure Eviction & Containerd OverlayFS / Log Saturation",
    shortTitle: "NodeDiskPressure eviction control",
    remediation: [
      "Prune unused containerd images and configure kubelet containerLogMaxSize=20Mi and imageGCHighThresholdPercent=75.",
      "Execute a cryptographic DR backup/restore drill to verify zero stateful corruption after pod eviction.",
    ],
    safeCommands: [
      "df -h / /var/lib/containerd /var/log/pods",
      "du -xhd2 /var/log/pods /var/lib/containerd",
      "kubectl describe node worker-01",
    ],
  },
  "RB-004": {
    runbook_id: "RB-004",
    category: "VxlanMtuMismatch",
    title: "OpenStack Neutron OVS VXLAN 50-Byte Encapsulation MTU 1450 Drop & PMTUD Blackhole",
    shortTitle: "VXLAN 1450 MTU / PMTUD blackhole",
    remediation: [
      "Set guest/pod interface MTU to 1450 (1400 for nested CNI over OpenStack VXLAN) to absorb the 50-byte encapsulation header.",
      "Permit ICMP Type 3 Code 4 (fragmentation-needed) in Neutron security groups to restore Path MTU Discovery.",
    ],
    safeCommands: [
      "ping -M do -s 1422 -c 3 10.0.10.15",
      "ovs-vsctl show",
      "ip -d link show br-int",
    ],
  },
  "RB-005": {
    runbook_id: "RB-005",
    category: "PostgresConnectionExhaustion",
    title: "PostgreSQL Wait-For Graph Lock Deadlocks, Idle-in-Transaction Blockers & Connection Saturation",
    shortTitle: "PostgreSQL WFG deadlock triage",
    remediation: [
      "Identify the root blocker PID or deadlock cycle from the pg_locks Wait-For Graph and enforce statement_timeout / idle_in_transaction_session_timeout.",
      "Route application replicas through PgBouncer transaction pooling and verify ACID ledger integrity via a DR restore drill.",
    ],
    safeCommands: [
      'promql:pg_stat_activity_count{datname="production"}',
      "kubectl logs -l app.kubernetes.io/name=api -n production --tail=50",
      "kubectl get hpa -n production",
    ],
  },
  "RB-006": {
    runbook_id: "RB-006",
    category: "CoreDnsFailure",
    title: "Kubernetes CoreDNS SERVFAIL & Linux Netfilter nf_conntrack Table Exhaustion",
    shortTitle: "CoreDNS SERVFAIL / conntrack",
    remediation: [
      "Verify kube-dns endpoints, NetworkPolicy UDP/TCP 53 egress rules and node net.netfilter.nf_conntrack_max sysctl limits.",
    ],
    safeCommands: [
      "kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide",
      "kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50",
      "dig +short kubernetes.default.svc.cluster.local",
    ],
  },
  "RB-007": {
    runbook_id: "RB-007",
    category: "TlsCertExpiry",
    title: "Ingress X.509 TLS Certificate Expiry & cert-manager ACME Challenge Failure",
    shortTitle: "cert-manager ACME recovery",
    remediation: [
      "Inspect cert-manager Challenge status; ensure /.well-known/acme-challenge/ is whitelisted in Ingress and NetworkPolicy.",
    ],
    safeCommands: [
      "kubectl get certificate,certificaterequest,order,challenge -A",
      "kubectl describe challenge -n production",
      "kubectl logs -n cert-manager -l app=cert-manager --tail=50",
    ],
  },
  "RB-008": {
    runbook_id: "RB-008",
    category: "ImagePullBackOff",
    title: "Container Registry ImagePullBackOff, ErrImagePull & ImagePullSecrets RBAC",
    shortTitle: "Registry ImagePullBackOff",
    remediation: [
      "Verify the container image digest exists in the registry and the ServiceAccount references a valid imagePullSecret.",
    ],
    safeCommands: [
      "kubectl describe pod -l app.kubernetes.io/name=api -n production",
      "kubectl get events -n production --sort-by=.lastTimestamp",
    ],
  },
};

export const RUNBOOK_ORDER: RunbookId[] = [
  "RB-001",
  "RB-002",
  "RB-003",
  "RB-004",
  "RB-005",
  "RB-006",
  "RB-007",
  "RB-008",
];

export function runbookForCategory(category: IncidentCategory | string): RunbookMeta | null {
  const found = RUNBOOK_ORDER.map((id) => RUNBOOKS[id]).find((runbook) => runbook.category === category);
  return found ?? null;
}

export function runbookById(runbookId: string): RunbookMeta | null {
  if (runbookId in RUNBOOKS) {
    return RUNBOOKS[runbookId as RunbookId];
  }
  return null;
}
