from __future__ import annotations

from typing import Dict, List, Set, Tuple

from sentinel.models import AgentFinding, PgSessionNode, TelemetrySnapshot


class NetworkSdnAgent:
    """
    Introspects L2/L3/L4 telemetry:
    - OpenStack Neutron ML2/OVS VXLAN 50-byte encapsulation overhead & PMTUD blackholes
    - Linux netfilter nf_conntrack table saturation
    - CoreDNS SERVFAIL & UDP socket drops
    - Ingress TLS X.509 expiration horizons
    """

    AGENT_NAME = "NetworkSdnAgent"
    LAYER = "L2_L3_SDN_DNS_TLS"

    def analyze(self, snap: TelemetrySnapshot) -> AgentFinding:
        evidence: List[str] = []
        commands: List[str] = []
        category = "Healthy"
        score = 0.05

        # 1. Check VXLAN Encapsulation MTU vs Pod/Guest Interface MTU
        expected_max_vxlan_mtu = snap.underlay_mtu - 50  # 50B VXLAN + UDP + IP + Ethernet
        if snap.pod_interface_mtu > snap.overlay_vxlan_mtu or (
            snap.overlay_vxlan_mtu > expected_max_vxlan_mtu
        ):
            oversize_bytes = snap.pod_interface_mtu - expected_max_vxlan_mtu
            evidence.append(
                f"VXLAN MTU mismatch: guest/pod MTU ({snap.pod_interface_mtu}B) exceeds safe VXLAN payload "
                f"ceiling ({expected_max_vxlan_mtu}B on {snap.underlay_mtu}B underlay) by {oversize_bytes}B."
            )
            if snap.icmp_frag_needed_blocked:
                evidence.append(
                    "PMTUD blackhole confirmed: Security Group blocks ICMP Type 3 Code 4 (fragmentation-needed), "
                    "causing silent drops on DF-set TLS/HTTP frames >1400B."
                )
                score = 0.96
            else:
                score = 0.85
            category = "VxlanMtuMismatch"
            commands.extend(
                [
                    "ping -M do -s 1422 -c 3 10.0.10.15",
                    "ovs-vsctl show",
                    "ip -d link show br-int",
                ]
            )

        # 2. Check CoreDNS SERVFAIL & Conntrack Exhaustion
        conntrack_ratio = snap.conntrack_used / max(snap.conntrack_max, 1)
        if snap.dns_servfail_rate >= 0.05 or conntrack_ratio >= 0.88:
            category = "CoreDnsFailure"
            score = max(score, 0.93)
            evidence.append(
                f"DNS resolution degradation: SERVFAIL rate={snap.dns_servfail_rate:.1%}, "
                f"nf_conntrack utilization={conntrack_ratio:.1%} ({snap.conntrack_used}/{snap.conntrack_max})."
            )
            commands.extend(
                [
                    "kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide",
                    "kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50",
                    "dig +short kubernetes.default.svc.cluster.local",
                ]
            )

        # 3. Check TLS Certificate Expiry
        if snap.tls_days_remaining <= 7:
            category = "TlsCertExpiry"
            score = max(score, 0.94)
            evidence.append(
                f"Ingress TLS certificate expires in {snap.tls_days_remaining} days; ACME renewal stalled."
            )
            commands.extend(
                [
                    "kubectl get certificate,certificaterequest,order,challenge -A",
                    "kubectl describe challenge -n " + snap.namespace,
                ]
            )

        return AgentFinding(
            agent_name=self.AGENT_NAME,
            layer=self.LAYER,
            anomaly_detected=score >= 0.5,
            primary_category=category,
            severity_score=round(score, 3),
            evidence=evidence,
            diagnostic_commands=commands,
            structured_metrics={
                "expected_vxlan_mtu": expected_max_vxlan_mtu,
                "conntrack_ratio": round(conntrack_ratio, 4),
                "dns_servfail_rate": snap.dns_servfail_rate,
            },
        )


class DatabaseStorageAgent:
    """
    Introspects PostgreSQL concurrency & storage telemetry:
    - Builds a directed Wait-For Graph (WFG) across pg_stat_activity + pg_locks
    - Uses DFS cycle detection to distinguish Circular Deadlocks from Head-of-Line Blocker chains
    - Detects connection pool saturation (SQLSTATE 53300) and NodeDiskPressure (<15% free block/inode)
    """

    AGENT_NAME = "DatabaseStorageAgent"
    LAYER = "POSTGRES_LOCKS_STORAGE"

    def analyze(self, snap: TelemetrySnapshot) -> AgentFinding:
        evidence: List[str] = []
        commands: List[str] = []
        category = "Healthy"
        score = 0.05

        conn_ratio = snap.pg_active_connections / max(snap.pg_max_connections, 1)
        cycles, root_blockers = self._analyze_wait_for_graph(snap.pg_sessions)

        # 1. PostgreSQL Lock Graph / Connection Pool Analysis
        if cycles or root_blockers or conn_ratio >= 0.85 or "53300" in snap.raw_logs:
            category = "PostgresConnectionExhaustion"
            score = 0.95
            if cycles:
                cycle_str = " -> ".join(str(p) for p in cycles[0])
                evidence.append(f"Circular PostgreSQL lock deadlock cycle detected in Wait-For Graph: PID {cycle_str}.")
            if root_blockers:
                for blocker_pid, blocked_count, blocker_node in root_blockers:
                    evidence.append(
                        f"Head-of-line blocker PID {blocker_pid} (state='{blocker_node.state}', "
                        f"lock='{blocker_node.lock_mode}', age={blocker_node.xact_duration_sec:.1f}s) "
                        f"is blocking {blocked_count} downstream transactions: `{blocker_node.query[:80]}`."
                    )
            if conn_ratio >= 0.85 or "53300" in snap.raw_logs:
                evidence.append(
                    f"PostgreSQL connection pool saturation at {conn_ratio:.1%} "
                    f"({snap.pg_active_connections}/{snap.pg_max_connections} active connections; SQLSTATE 53300)."
                )
            commands.extend(
                [
                    "promql:pg_stat_activity_count{datname=\"production\"}",
                    f"kubectl logs -l app.kubernetes.io/name={snap.service} -n {snap.namespace} --tail=50",
                    f"kubectl get hpa -n {snap.namespace}",
                ]
            )

        # 2. Kubelet NodeDiskPressure / Inode Exhaustion Analysis
        if snap.node_rootfs_avail_pct < 15.0 or snap.node_inodes_avail_pct < 10.0:
            category = "NodeDiskPressure"
            score = max(score, 0.94)
            evidence.append(
                f"Node storage pressure critical: rootfs free={snap.node_rootfs_avail_pct:.1f}% "
                f"(Kubelet eviction threshold=10.0%), inodes free={snap.node_inodes_avail_pct:.1f}%."
            )
            commands.extend(
                [
                    "df -h / /var/lib/containerd /var/log/pods",
                    "du -xhd2 /var/log/pods /var/lib/containerd",
                ]
            )

        return AgentFinding(
            agent_name=self.AGENT_NAME,
            layer=self.LAYER,
            anomaly_detected=score >= 0.5,
            primary_category=category,
            severity_score=round(score, 3),
            evidence=evidence,
            diagnostic_commands=commands,
            structured_metrics={
                "pg_connection_ratio": round(conn_ratio, 4),
                "deadlock_cycles_found": len(cycles),
                "root_blocker_pids": [b[0] for b in root_blockers],
                "node_rootfs_avail_pct": snap.node_rootfs_avail_pct,
            },
        )

    @staticmethod
    def _analyze_wait_for_graph(
        sessions: List[PgSessionNode],
    ) -> Tuple[List[List[int]], List[Tuple[int, int, PgSessionNode]]]:
        """
        Constructs a directed Wait-For Graph (waiter_pid -> blocker_pid).
        Returns (deadlock_cycles, [(root_blocker_pid, total_transitive_waiters, PgSessionNode)]).
        """
        by_pid: Dict[int, PgSessionNode] = {s.pid: s for s in sessions}
        adj: Dict[int, List[int]] = {s.pid: list(s.blocking_pids) for s in sessions}
        reverse_adj: Dict[int, List[int]] = {s.pid: [] for s in sessions}
        for waiter, blockers in adj.items():
            for blk in blockers:
                reverse_adj.setdefault(blk, []).append(waiter)

        # DFS cycle detection
        visited: Set[int] = set()
        on_stack: Set[int] = set()
        path: List[int] = []
        cycles: List[List[int]] = []

        def dfs(node: int) -> None:
            visited.add(node)
            on_stack.add(node)
            path.append(node)
            for nbr in adj.get(node, []):
                if nbr not in visited:
                    dfs(nbr)
                elif nbr in on_stack:
                    idx = path.index(nbr)
                    cycles.append(path[idx:] + [nbr])
            path.pop()
            on_stack.remove(node)

        for pid in adj:
            if pid not in visited:
                dfs(pid)

        # Identify root blockers (nodes that block others but are not waiting on anyone themselves)
        root_blockers: List[Tuple[int, int, PgSessionNode]] = []
        for pid, node in by_pid.items():
            if not node.blocking_pids and reverse_adj.get(pid):
                # Count transitive waiters via BFS
                q = list(reverse_adj[pid])
                seen = set(q)
                while q:
                    curr = q.pop(0)
                    for w in reverse_adj.get(curr, []):
                        if w not in seen:
                            seen.add(w)
                            q.append(w)
                root_blockers.append((pid, len(seen), node))

        root_blockers.sort(key=lambda item: item[1], reverse=True)
        return cycles, root_blockers


class ComputeRuntimeAgent:
    """
    Introspects Linux cgroup v2 memory/CPU pressure, container exit codes,
    CrashLoopBackOff curves, and container registry ImagePullBackOff errors.
    """

    AGENT_NAME = "ComputeRuntimeAgent"
    LAYER = "CGROUP_V2_KUBELET_RUNTIME"

    def analyze(self, snap: TelemetrySnapshot) -> AgentFinding:
        evidence: List[str] = []
        commands: List[str] = []
        category = "Healthy"
        score = 0.05

        mem_ratio = snap.cgroup_memory_current_mb / max(snap.cgroup_memory_max_mb, 1)

        # 1. Check OOMKilled (Exit Code 137 / cgroup memory.events oom_kill)
        if snap.cgroup_oom_kill_count > 0 or snap.container_exit_code == 137 or mem_ratio >= 0.96:
            category = "OOMKilled"
            score = 0.96
            evidence.append(
                f"Container memory cgroup v2 limit breached: working_set={snap.cgroup_memory_current_mb}MiB / "
                f"{snap.cgroup_memory_max_mb}MiB ({mem_ratio:.1%}), oom_kill_count={snap.cgroup_oom_kill_count}, "
                f"last_exit_code={snap.container_exit_code} (SIGKILL)."
            )
            commands.extend(
                [
                    f"kubectl describe pod -l app.kubernetes.io/name={snap.service} -n {snap.namespace}",
                    f"kubectl top pod -n {snap.namespace} --containers",
                    f"promql:container_memory_working_set_bytes{{namespace=\"{snap.namespace}\"}}",
                ]
            )

        # 2. Check ImagePullBackOff / ErrImagePull
        elif snap.image_pull_error:
            category = "ImagePullBackOff"
            score = 0.95
            evidence.append(f"Container image pull failed: {snap.image_pull_error}")
            commands.extend(
                [
                    f"kubectl describe pod -l app.kubernetes.io/name={snap.service} -n {snap.namespace}",
                    f"kubectl get events -n {snap.namespace} --sort-by=.lastTimestamp",
                ]
            )

        # 3. Check CrashLoopBackOff (Exit Code 1 / 2 / 139 without OOM)
        elif snap.pod_restart_count_10m >= 3 or snap.container_exit_code in (1, 2, 139):
            category = "CrashLoopBackOff"
            score = 0.93
            evidence.append(
                f"Pod CrashLoopBackOff detected: {snap.pod_restart_count_10m} restarts in 10m, "
                f"exit_code={snap.container_exit_code}."
            )
            commands.extend(
                [
                    f"kubectl get pods -n {snap.namespace} -o wide",
                    f"kubectl logs -l app.kubernetes.io/name={snap.service} -n {snap.namespace} --previous --tail=100",
                ]
            )

        return AgentFinding(
            agent_name=self.AGENT_NAME,
            layer=self.LAYER,
            anomaly_detected=score >= 0.5,
            primary_category=category,
            severity_score=round(score, 3),
            evidence=evidence,
            diagnostic_commands=commands,
            structured_metrics={
                "cgroup_memory_ratio": round(mem_ratio, 4),
                "oom_kill_count": snap.cgroup_oom_kill_count,
                "pod_restart_count_10m": snap.pod_restart_count_10m,
            },
        )
