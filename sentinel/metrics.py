"""
Zero-dependency Prometheus metrics registry for Sentinel-SRE.

Implements thread-safe Counter / Gauge / Histogram primitives and renders them in the
Prometheus text exposition format (version 0.0.4) served at ``GET /metrics``.
"""
from __future__ import annotations

import math
import threading
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from sentinel.models import DrRestoreResult, IncidentDiagnosisReport

PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

# Millisecond buckets sized for sub-ms in-process triage up to multi-second degraded runs.
DEFAULT_MS_BUCKETS: Tuple[float, ...] = (
    0.5, 1.0, 2.5, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0, 5000.0,
)

LabelValues = Tuple[str, ...]


def _escape_label_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _escape_help(text: str) -> str:
    return text.replace("\\", "\\\\").replace("\n", "\\n")


def _format_value(value: float) -> str:
    if math.isinf(value):
        return "+Inf" if value > 0 else "-Inf"
    if math.isnan(value):
        return "NaN"
    if float(value).is_integer() and abs(value) < 1e15:
        return str(int(value))
    return repr(float(value))


def _format_labels(names: Sequence[str], values: Sequence[str]) -> str:
    if not names:
        return ""
    pairs = ",".join(f'{n}="{_escape_label_value(v)}"' for n, v in zip(names, values))
    return "{" + pairs + "}"


class _Metric:
    metric_type = "untyped"

    def __init__(self, name: str, documentation: str, label_names: Sequence[str] = ()) -> None:
        self.name = name
        self.documentation = documentation
        self.label_names: Tuple[str, ...] = tuple(label_names)
        self._lock = threading.Lock()

    def _key(self, labels: Dict[str, str]) -> LabelValues:
        if set(labels) != set(self.label_names):
            raise ValueError(
                f"Metric {self.name} expects labels {sorted(self.label_names)}, got {sorted(labels)}"
            )
        return tuple(str(labels[n]) for n in self.label_names)

    def header(self) -> List[str]:
        return [
            f"# HELP {self.name} {_escape_help(self.documentation)}",
            f"# TYPE {self.name} {self.metric_type}",
        ]

    def samples(self) -> List[str]:  # pragma: no cover - overridden
        raise NotImplementedError


class Counter(_Metric):
    """Monotonically increasing counter."""

    metric_type = "counter"

    def __init__(self, name: str, documentation: str, label_names: Sequence[str] = ()) -> None:
        super().__init__(name, documentation, label_names)
        self._values: Dict[LabelValues, float] = {}
        if not self.label_names:
            self._values[()] = 0.0

    def inc(self, amount: float = 1.0, **labels: str) -> None:
        if amount < 0:
            raise ValueError("Counters can only be incremented by non-negative amounts")
        key = self._key(labels)
        with self._lock:
            self._values[key] = self._values.get(key, 0.0) + amount

    def get(self, **labels: str) -> float:
        with self._lock:
            return self._values.get(self._key(labels), 0.0)

    def samples(self) -> List[str]:
        with self._lock:
            items = sorted(self._values.items())
        return [f"{self.name}{_format_labels(self.label_names, k)} {_format_value(v)}" for k, v in items]


class Gauge(_Metric):
    """Value that can go up and down."""

    metric_type = "gauge"

    def __init__(self, name: str, documentation: str, label_names: Sequence[str] = ()) -> None:
        super().__init__(name, documentation, label_names)
        self._values: Dict[LabelValues, float] = {}
        if not self.label_names:
            self._values[()] = 0.0

    def set(self, value: float, **labels: str) -> None:
        key = self._key(labels)
        with self._lock:
            self._values[key] = float(value)

    def inc(self, amount: float = 1.0, **labels: str) -> None:
        key = self._key(labels)
        with self._lock:
            self._values[key] = self._values.get(key, 0.0) + amount

    def get(self, **labels: str) -> float:
        with self._lock:
            return self._values.get(self._key(labels), 0.0)

    def samples(self) -> List[str]:
        with self._lock:
            items = sorted(self._values.items())
        return [f"{self.name}{_format_labels(self.label_names, k)} {_format_value(v)}" for k, v in items]


class Histogram(_Metric):
    """Cumulative-bucket histogram rendering ``_bucket``, ``_sum`` and ``_count`` series."""

    metric_type = "histogram"

    def __init__(
        self,
        name: str,
        documentation: str,
        buckets: Iterable[float] = DEFAULT_MS_BUCKETS,
        label_names: Sequence[str] = (),
    ) -> None:
        super().__init__(name, documentation, label_names)
        if "le" in self.label_names:
            raise ValueError("'le' is a reserved histogram label")
        upper = sorted(float(b) for b in buckets)
        if not upper or not math.isinf(upper[-1]):
            upper.append(math.inf)
        self.buckets: Tuple[float, ...] = tuple(upper)
        # key -> (per-bucket non-cumulative counts, sum, count)
        self._data: Dict[LabelValues, Tuple[List[int], float, int]] = {}
        if not self.label_names:
            self._data[()] = ([0] * len(self.buckets), 0.0, 0)

    def observe(self, value: float, **labels: str) -> None:
        key = self._key(labels)
        with self._lock:
            counts, total, n = self._data.get(key, ([0] * len(self.buckets), 0.0, 0))
            for i, bound in enumerate(self.buckets):
                if value <= bound:
                    counts[i] += 1
                    break
            self._data[key] = (counts, total + float(value), n + 1)

    def count(self, **labels: str) -> int:
        with self._lock:
            entry = self._data.get(self._key(labels))
            return entry[2] if entry else 0

    def sum(self, **labels: str) -> float:
        with self._lock:
            entry = self._data.get(self._key(labels))
            return entry[1] if entry else 0.0

    def samples(self) -> List[str]:
        lines: List[str] = []
        with self._lock:
            items = sorted((k, (list(c), s, n)) for k, (c, s, n) in self._data.items())
        for key, (counts, total, n) in items:
            cumulative = 0
            for bound, c in zip(self.buckets, counts):
                cumulative += c
                label_str = _format_labels(self.label_names + ("le",), key + (_format_value(bound),))
                lines.append(f"{self.name}_bucket{label_str} {cumulative}")
            base = _format_labels(self.label_names, key)
            lines.append(f"{self.name}_sum{base} {_format_value(total)}")
            lines.append(f"{self.name}_count{base} {n}")
        return lines


class PrometheusMetricsRegistry:
    """
    Registry of Sentinel-SRE operational metrics:

    - ``sentinel_incidents_triaged_total{category,severity}``
    - ``sentinel_guardrail_blocked_commands_total``
    - ``sentinel_prompt_injections_neutralized_total``
    - ``sentinel_dr_restore_drills_total{status}``
    - ``sentinel_dr_restore_rto_milliseconds`` (histogram)
    - ``sentinel_triage_latency_milliseconds`` (histogram)
    """

    def __init__(self, runbooks_indexed: int = 0) -> None:
        self._metrics: Dict[str, _Metric] = {}
        self._lock = threading.Lock()

        self.incidents_triaged = self.register(
            Counter(
                "sentinel_incidents_triaged_total",
                "Total incidents triaged by the multi-agent coordinator.",
                ("category", "severity"),
            )
        )
        self.guardrail_blocked = self.register(
            Counter(
                "sentinel_guardrail_blocked_commands_total",
                "Total candidate commands rejected by the zero-trust read-only guardrail.",
            )
        )
        self.injections_neutralized = self.register(
            Counter(
                "sentinel_prompt_injections_neutralized_total",
                "Total incidents in which an adversarial prompt injection was detected and scrubbed.",
            )
        )
        self.dr_drills = self.register(
            Counter(
                "sentinel_dr_restore_drills_total",
                "Total cryptographic backup and restore verification drills by outcome.",
                ("status",),
            )
        )
        self.dr_rto = self.register(
            Histogram(
                "sentinel_dr_restore_rto_milliseconds",
                "Measured recovery time objective of verified restore drills in milliseconds.",
            )
        )
        self.triage_latency = self.register(
            Histogram(
                "sentinel_triage_latency_milliseconds",
                "End-to-end multi-agent triage latency in milliseconds.",
            )
        )
        self.runbooks_indexed = self.register(
            Gauge("sentinel_runbooks_indexed", "Number of runbooks indexed by the hybrid RAG engine.")
        )
        self.up = self.register(Gauge("sentinel_up", "Whether the Sentinel-SRE service is up (1) or not (0)."))

        # Pre-initialise well-known label sets so dashboards see explicit zeros.
        self.dr_drills.inc(0, status="passed")
        self.dr_drills.inc(0, status="failed")
        self.runbooks_indexed.set(runbooks_indexed)
        self.up.set(1)

    def register(self, metric: _Metric):  # type: ignore[no-untyped-def]
        with self._lock:
            if metric.name in self._metrics:
                raise ValueError(f"Duplicate metric registration: {metric.name}")
            self._metrics[metric.name] = metric
        return metric

    def get(self, name: str) -> Optional[_Metric]:
        with self._lock:
            return self._metrics.get(name)

    # ---- Domain-level recording helpers ---------------------------------------------------

    def record_triage(self, report: IncidentDiagnosisReport, severity: str = "unknown") -> None:
        self.incidents_triaged.inc(category=report.diagnosed_category, severity=severity or "unknown")
        self.triage_latency.observe(report.triage_latency_ms)
        if report.blocked_unsafe_commands:
            self.guardrail_blocked.inc(len(report.blocked_unsafe_commands))
        if report.prompt_injection_neutralized:
            self.injections_neutralized.inc()
        if report.dr_drill_result is not None:
            self.record_dr_drill(report.dr_drill_result)

    def record_dr_drill(self, result: Optional[DrRestoreResult], passed: Optional[bool] = None) -> None:
        ok = passed if passed is not None else bool(result and result.foreign_key_check_passed)
        self.dr_drills.inc(status="passed" if ok else "failed")
        if result is not None and ok:
            self.dr_rto.observe(result.rto_ms)

    # ---- Exposition ------------------------------------------------------------------------

    def render(self) -> str:
        with self._lock:
            metrics = list(self._metrics.values())
        lines: List[str] = []
        for metric in metrics:
            lines.extend(metric.header())
            lines.extend(metric.samples())
        return "\n".join(lines) + "\n"
