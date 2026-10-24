from __future__ import annotations

import re
import shlex
from typing import List, Tuple

ALLOWED_COMMAND_PREFIXES: Tuple[Tuple[str, ...], ...] = (
    ("kubectl", "get"),
    ("kubectl", "describe"),
    ("kubectl", "logs"),
    ("kubectl", "top"),
    ("kubectl", "events"),
    ("df", "-h"),
    ("du", "-xhd2"),
    ("ping", "-M", "do"),
    ("ovs-vsctl", "show"),
    ("ip", "-d", "link", "show"),
    ("ip", "link", "show"),
    ("dig", "+short"),
)

FORBIDDEN_SHELL_METACHAR_RE = re.compile(r"[;&|`$><]|\$\(|\n|\r")

FORBIDDEN_SQL_OR_MUTATION_RE = re.compile(
    r"\b(delete|apply|patch|edit|replace|exec|drain|cordon|scale|autoscale|"
    r"rm|mkfs|dd|shutdown|reboot|systemctl|kill|drop|truncate|update|insert|alter|grant)\b",
    re.IGNORECASE,
)

PROMPT_INJECTION_SIGNATURES: Tuple[re.Pattern[str], ...] = (
    re.compile(r"ignore\s+(all\s+)?(previous|prior|above)\s+instructions", re.IGNORECASE),
    re.compile(r"system\s+override", re.IGNORECASE),
    re.compile(r"disregard\s+(all\s+)?safety\s+guardrails", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+in\s+(root|admin|unrestricted|developer)\s+mode", re.IGNORECASE),
    re.compile(r"execute\s+immediately\s*:", re.IGNORECASE),
)


class ZeroTrustGuardrail:
    """
    Token-level AST/shlex command validator and adversarial prompt-injection firewall.
    Guarantees that diagnostic agents can NEVER emit mutating cluster, host, or SQL commands.
    """

    @classmethod
    def detect_and_scrub_injection(cls, *texts: str) -> Tuple[bool, List[str]]:
        detected = False
        scrubbed_list: List[str] = []
        for txt in texts:
            if not txt:
                scrubbed_list.append("")
                continue
            clean = txt
            for sig in PROMPT_INJECTION_SIGNATURES:
                if sig.search(clean):
                    detected = True
                    clean = sig.sub("[REDACTED_ADVERSARIAL_INJECTION]", clean)
            scrubbed_list.append(clean)
        return detected, scrubbed_list

    @classmethod
    def is_safe_readonly_command(cls, command: str) -> bool:
        cmd = command.strip()
        if not cmd:
            return False
        if FORBIDDEN_SHELL_METACHAR_RE.search(cmd):
            return False

        # Allow read-only PromQL metric queries
        if cmd.startswith("promql:"):
            expr = cmd[len("promql:") :].strip()
            return bool(expr) and not FORBIDDEN_SQL_OR_MUTATION_RE.search(expr)

        try:
            tokens = shlex.split(cmd)
        except ValueError:
            return False

        if not tokens:
            return False

        if FORBIDDEN_SQL_OR_MUTATION_RE.search(cmd):
            return False

        for prefix in ALLOWED_COMMAND_PREFIXES:
            if len(tokens) >= len(prefix) and tuple(tokens[: len(prefix)]) == prefix:
                return True
        return False

    @classmethod
    def audit_commands(cls, candidates: List[str]) -> Tuple[List[str], List[str]]:
        approved: List[str] = []
        blocked: List[str] = []
        for raw in candidates:
            cmd = raw.strip()
            if not cmd:
                continue
            if cls.is_safe_readonly_command(cmd):
                if cmd not in approved:
                    approved.append(cmd)
            else:
                blocked.append(cmd)
        return approved, blocked
