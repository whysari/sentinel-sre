"use client";

import type { ReactNode } from "react";
import type { IncidentDetailResponse } from "../types/sentinel";
import {
  categoryAccent,
  categoryLabel,
  cn,
  confidenceTone,
  formatLatency,
  formatPercent,
  formatRelativeTime,
  toneClasses,
  truncate,
} from "../lib/format";
import { Badge, EmptyState, Panel, ProgressBar } from "./ui";
import { ActivityIcon, DatabaseIcon, LockIcon, SparkIcon, TerminalIcon } from "./icons";

export interface IncidentContextBarProps {
  incident: IncidentDetailResponse | null;
  loading?: boolean;
}

export function IncidentContextBar({ incident, loading }: IncidentContextBarProps) {
  if (!incident) {
    return (
      <Panel className="p-5">
        <EmptyState
          title={loading ? "Loading incident report…" : "No incident selected"}
          detail="Choose a row in the incident queue to load the complete multi-agent diagnosis, Wait-For Graph and guardrail audit."
          icon={<ActivityIcon size={22} />}
        />
      </Panel>
    );
  }

  const expectedMatches = incident.expected_category === null || incident.expected_category === incident.diagnosed_category;
  return (
    <Panel tone={expectedMatches ? "accent" : "critical"} className="p-4 md:p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg font-semibold text-slate-50">{incident.incident_id}</span>
            <Badge tone={incident.severity === "critical" ? "critical" : "warning"} dot>
              {incident.severity}
            </Badge>
            <span className={cn("rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", categoryAccent(incident.diagnosed_category))}>
              {categoryLabel(incident.diagnosed_category)}
            </span>
            {incident.prompt_injection_neutralized ? <Badge tone="critical">injection scrubbed</Badge> : null}
            {incident.dr_drill_result ? <Badge tone="success">DR verified</Badge> : null}
            {incident.expected_category !== null ? (
              <Badge tone={expectedMatches ? "success" : "critical"}>
                {expectedMatches ? "match · " : "miss · "}
                {incident.expected_category}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1.5 text-[13px] font-semibold text-slate-200">{incident.alert_name}</p>
          <p className="mt-0.5 max-w-3xl text-[11px] leading-relaxed text-slate-400">
            {truncate(incident.root_cause_summary, 190)}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500">
            <span className="font-mono">{incident.service}</span>
            <span>ns/{incident.namespace}</span>
            <span>{incident.cited_runbook_id}</span>
            <span>{formatRelativeTime(incident.created_at)}</span>
            <span>{incident.agent_findings.length} agent findings</span>
            <span>{incident.wait_for_graph.nodes.length} pg sessions</span>
          </div>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
          <ContextStat
            icon={<SparkIcon size={13} />}
            label="Confidence"
            value={formatPercent(incident.confidence)}
            tone={confidenceTone(incident.confidence)}
            progress={incident.confidence}
          />
          <ContextStat
            icon={<ActivityIcon size={13} />}
            label="Triage latency"
            value={formatLatency(incident.triage_latency_ms)}
            tone="info"
          />
          <ContextStat
            icon={<TerminalIcon size={13} />}
            label="Blocked cmds"
            value={String(incident.blocked_unsafe_commands.length)}
            tone={incident.blocked_unsafe_commands.length > 0 ? "warning" : "success"}
          />
          <ContextStat
            icon={<DatabaseIcon size={13} />}
            label="DR RTO"
            value={incident.dr_drill_result ? formatLatency(incident.dr_drill_result.rto_ms) : "n/a"}
            tone={incident.dr_drill_result ? "success" : "neutral"}
          />
        </div>
      </div>

      {incident.wait_for_graph.deadlock_cycles.length > 0 || incident.wait_for_graph.root_blockers.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2">
          <LockIcon size={13} className="text-amber-300" />
          <span className="text-[11px] font-semibold text-amber-100">PostgreSQL lock contention</span>
          {incident.wait_for_graph.deadlock_cycles.map((cycle, index) => (
            <span key={index} className="rounded bg-rose-500/10 px-1.5 py-0.5 font-mono text-[10px] text-rose-200">
              deadlock {cycle.join(" → ")}
            </span>
          ))}
          {incident.wait_for_graph.root_blockers.map((blocker) => (
            <span key={blocker.pid} className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-200">
              RB PID {blocker.pid} · blocks {blocker.blocked_count}
            </span>
          ))}
          <span className="ml-auto font-mono text-[10px] text-amber-200/60">
            pool {formatPercent(incident.wait_for_graph.pg_connection_ratio)}
          </span>
        </div>
      ) : null}
    </Panel>
  );
}

function ContextStat({
  icon,
  label,
  value,
  tone,
  progress,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone: "critical" | "warning" | "info" | "success" | "neutral";
  progress?: number;
}) {
  return (
    <div className={cn("min-w-[104px] rounded-lg border px-2.5 py-2", toneClasses(tone))}>
      <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.1em] opacity-70">
        {icon}
        {label}
      </p>
      <p className="mt-0.5 font-mono text-sm font-semibold">{value}</p>
      {progress !== undefined ? <ProgressBar value={progress} tone={tone} height="xs" className="mt-1.5" label={label} /> : null}
    </div>
  );
}
