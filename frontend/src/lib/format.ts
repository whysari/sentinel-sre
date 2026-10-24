/**
 * Presentation-only formatting utilities. Pure functions, no DOM access, so they are shared by
 * server components, client components and the `bun test` suite.
 */

import type { IncidentCategory, Severity } from "../types/sentinel";

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0).join(" ");
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export function safeDivide(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

export function formatNumber(value: number, digits = 0): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** `0.9821 -> "98.2%"`; `null/undefined` renders the supplied fallback. */
export function formatPercent(value: number | null | undefined, digits = 1, fallback = "—"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return `${formatNumber(value * 100, digits)}%`;
}

/** `4.533 -> "4.53 ms"` with adaptive precision. */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return "—";
  }
  if (ms < 1) {
    return `${formatNumber(ms, 2)} ms`;
  }
  if (ms < 100) {
    return `${formatNumber(ms, 1)} ms`;
  }
  return `${formatNumber(ms, 0)} ms`;
}

export function formatLatencyPair(p50: number, p95: number): string {
  return `${formatLatency(p50)} / ${formatLatency(p95)}`;
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return "—";
  }
  if (seconds < 60) {
    return `${formatNumber(seconds, 1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "—";
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/** ISO-8601 (with or without timezone) -> relative label. `now` is injectable for deterministic tests. */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) {
    return "never";
  }
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return iso;
  }
  const deltaSeconds = Math.round((now - parsed) / 1000);
  if (deltaSeconds < 5) {
    return "just now";
  }
  if (deltaSeconds < 60) {
    return `${deltaSeconds}s ago`;
  }
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) {
    return "—";
  }
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return iso;
  }
  return new Date(parsed).toISOString().slice(11, 19) + "Z";
}

export function truncate(text: string, max = 120): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function titleCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function categoryLabel(category: IncidentCategory | string): string {
  const labels: Record<string, string> = {
    VxlanMtuMismatch: "VXLAN MTU Mismatch",
    PostgresConnectionExhaustion: "Postgres Lock Exhaustion",
    OOMKilled: "OOMKilled (137)",
    NodeDiskPressure: "NodeDiskPressure",
    CoreDnsFailure: "CoreDNS Failure",
    TlsCertExpiry: "TLS Cert Expiry",
    ImagePullBackOff: "ImagePullBackOff",
    CrashLoopBackOff: "CrashLoopBackOff",
    Healthy: "Healthy",
  };
  return labels[category] ?? titleCase(category);
}

export function categoryAccent(category: IncidentCategory | string): string {
  const accents: Record<string, string> = {
    VxlanMtuMismatch: "text-sky-300 border-sky-400/30 bg-sky-400/10",
    PostgresConnectionExhaustion: "text-amber-300 border-amber-400/30 bg-amber-400/10",
    OOMKilled: "text-rose-300 border-rose-400/30 bg-rose-400/10",
    NodeDiskPressure: "text-orange-300 border-orange-400/30 bg-orange-400/10",
    CoreDnsFailure: "text-violet-300 border-violet-400/30 bg-violet-400/10",
    TlsCertExpiry: "text-emerald-300 border-emerald-400/30 bg-emerald-400/10",
    ImagePullBackOff: "text-cyan-300 border-cyan-400/30 bg-cyan-400/10",
    CrashLoopBackOff: "text-pink-300 border-pink-400/30 bg-pink-400/10",
  };
  return accents[category] ?? "text-slate-300 border-slate-400/30 bg-slate-400/10";
}

export type Tone = "critical" | "warning" | "info" | "success" | "neutral";

export function severityTone(severity: Severity): Tone {
  switch (severity) {
    case "critical":
      return "critical";
    case "warning":
      return "warning";
    case "info":
      return "info";
    default:
      return "neutral";
  }
}

export function toneClasses(tone: Tone): string {
  switch (tone) {
    case "critical":
      return "border-rose-500/35 bg-rose-500/10 text-rose-200";
    case "warning":
      return "border-amber-500/35 bg-amber-500/10 text-amber-200";
    case "info":
      return "border-sky-500/35 bg-sky-500/10 text-sky-200";
    case "success":
      return "border-emerald-500/35 bg-emerald-500/10 text-emerald-200";
    default:
      return "border-white/10 bg-white/[0.03] text-slate-300";
  }
}

export function confidenceTone(confidence: number): Tone {
  if (confidence >= 0.92) {
    return "success";
  }
  if (confidence >= 0.8) {
    return "info";
  }
  if (confidence >= 0.65) {
    return "warning";
  }
  return "critical";
}

/** Render a SHA-256 digest as 4-char groups while keeping the raw value copyable. */
export function formatDigest(digest: string): string {
  if (!digest) {
    return "—";
  }
  return digest.toUpperCase().match(/.{1,4}/g)?.join(" ") ?? digest.toUpperCase();
}

export function formatCommandCount(count: number): string {
  return `${formatNumber(count)} command${count === 1 ? "" : "s"}`;
}

export function pct(part: number, total: number): number {
  return clamp01(safeDivide(part, total));
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}
