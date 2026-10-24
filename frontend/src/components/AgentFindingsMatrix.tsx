"use client";

import { useMemo } from "react";
import type { AgentFinding } from "../types/sentinel";
import { AGENT_LAYERS, AGENT_NAMES, isAgentName } from "../types/sentinel";
import { categoryAccent, categoryLabel, cn, formatNumber, formatPercent, truncate } from "../lib/format";
import { Badge, CodeChip, EmptyState, Panel, PanelHeader, ProgressBar } from "./ui";
import { CpuIcon, DatabaseIcon, LayersIcon, NetworkIcon, SparkIcon } from "./icons";

export interface AgentFindingsMatrixProps {
  findings: AgentFinding[];
  incidentId?: string | null;
  rootCauseSummary?: string;
  loading?: boolean;
}

const AGENT_ICONS: Record<string, typeof NetworkIcon> = {
  NetworkSdnAgent: NetworkIcon,
  DatabaseStorageAgent: DatabaseIcon,
  ComputeRuntimeAgent: CpuIcon,
};

const AGENT_ACCENTS: Record<string, string> = {
  NetworkSdnAgent: "text-sky-300 border-sky-400/25 bg-sky-400/[0.07]",
  DatabaseStorageAgent: "text-amber-300 border-amber-400/25 bg-amber-400/[0.07]",
  ComputeRuntimeAgent: "text-violet-300 border-violet-400/25 bg-violet-400/[0.07]",
};

function formatMetricValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : value.map((item) => String(item)).join(", ");
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : formatNumber(value, Math.abs(value) < 10 ? 2 : 1);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (value === null || value === undefined) {
    return "—";
  }
  return truncate(String(value), 40);
}

function FindingCard({ finding }: { finding: AgentFinding }) {
  const named = isAgentName(finding.agent_name) ? finding.agent_name : null;
  const Icon = (named && AGENT_ICONS[named]) || SparkIcon;
  const accent = (named && AGENT_ACCENTS[named]) || "text-slate-300 border-white/10 bg-white/[0.03]";
  const tone = finding.severity_score >= 0.9 ? "critical" : finding.severity_score >= 0.5 ? "warning" : "success";
  const metrics = Object.entries(finding.structured_metrics ?? {});
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col rounded-xl border bg-black/20",
        finding.anomaly_detected ? "border-white/10" : "border-emerald-500/15",
      )}
    >
      <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] p-3.5">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border", accent)}>
            <Icon size={15} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-slate-100">{finding.agent_name}</p>
            <p className="mt-0.5 truncate font-mono text-[9px] uppercase tracking-wide text-slate-500">
              {named ? AGENT_LAYERS[named] : finding.layer}
            </p>
          </div>
        </div>
        <Badge tone={tone} dot>
          {finding.anomaly_detected ? "anomaly" : "healthy"}
        </Badge>
      </div>

      <div className="space-y-3 p-3.5">
        <div>
          <div className="flex items-center justify-between gap-2 text-[10px]">
            <span className="uppercase tracking-[0.14em] text-slate-500">Severity</span>
            <span className="font-mono text-slate-300">{formatPercent(finding.severity_score, 0)}</span>
          </div>
          <ProgressBar value={finding.severity_score} tone={tone === "success" ? "success" : tone === "warning" ? "warning" : "critical"} className="mt-1.5" label={`${finding.agent_name} severity`} />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className={cn("rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", categoryAccent(finding.primary_category))}>
              {categoryLabel(finding.primary_category)}
            </span>
            <span className="font-mono text-[9px] text-slate-600">{finding.diagnostic_commands.length} cmds</span>
          </div>
        </div>

        {metrics.length > 0 ? (
          <div className="rounded-lg border border-white/[0.06] bg-black/25 p-2.5">
            <p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-600">Structured telemetry</p>
            <dl className="divide-y divide-white/[0.04]">
              {metrics.slice(0, 6).map(([key, value]) => (
                <div key={key} className="flex items-baseline justify-between gap-3 py-1">
                  <dt className="min-w-0 truncate font-mono text-[10px] text-slate-500" title={key}>
                    {key}
                  </dt>
                  <dd className="shrink-0 font-mono text-[10px] text-slate-200">{formatMetricValue(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}

        <div>
          <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-600">Evidence</p>
          {finding.evidence.length === 0 ? (
            <p className="text-[11px] text-slate-500">No evidence emitted.</p>
          ) : (
            <ul className="space-y-1.5">
              {finding.evidence.map((item, index) => (
                <li key={`${finding.agent_name}-ev-${index}`} className="flex gap-2 text-[11px] leading-relaxed text-slate-400">
                  <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-slate-600" />
                  <span className="break-words">{item}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {finding.diagnostic_commands.length > 0 ? (
          <div>
            <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-600">
              Read-only diagnostics
            </p>
            <div className="space-y-1">
              {finding.diagnostic_commands.slice(0, 4).map((command) => (
                <CodeChip key={command} title={command}>
                  {command}
                </CodeChip>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function AgentFindingsMatrix({ findings, incidentId, rootCauseSummary, loading }: AgentFindingsMatrixProps) {
  const ordered = useMemo(() => {
    return [...findings].sort((a, b) => {
      const aIndex = isAgentName(a.agent_name) ? AGENT_NAMES.indexOf(a.agent_name) : 99;
      const bIndex = isAgentName(b.agent_name) ? AGENT_NAMES.indexOf(b.agent_name) : 99;
      return aIndex - bIndex || a.agent_name.localeCompare(b.agent_name);
    });
  }, [findings]);

  const anomalies = ordered.filter((finding) => finding.anomaly_detected).length;
  const topSeverity = ordered.reduce((max, finding) => Math.max(max, finding.severity_score), 0);

  return (
    <Panel tone={anomalies >= 2 ? "critical" : "accent"} id="agent-findings">
      <PanelHeader
        eyebrow="Parallel introspection"
        title="Agent Findings Matrix"
        subtitle={
          rootCauseSummary
            ? truncate(rootCauseSummary, 180)
            : "Three specialised agents introspect L2–L7 telemetry concurrently, then the coordinator fuses their priors via reciprocal rank fusion."
        }
        icon={<LayersIcon size={17} />}
        tone={anomalies >= 2 ? "critical" : "info"}
        actions={
          <>
            <Badge tone={anomalies > 0 ? "critical" : "success"} dot>
              {anomalies}/3 anomalies
            </Badge>
            <Badge tone="neutral">{formatPercent(topSeverity, 0)} peak</Badge>
            {incidentId ? <Badge tone="info">{incidentId}</Badge> : null}
          </>
        }
      />

      <div className="px-5 pb-5 pt-4">
        {loading ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-72 animate-pulse rounded-xl border border-white/10 bg-white/[0.02]" />
            ))}
          </div>
        ) : ordered.length === 0 ? (
          <EmptyState
            title="No incident selected"
            detail="Select an incident from the triage queue (or inject a chaos scenario) to inspect the three agent findings."
            icon={<LayersIcon size={22} />}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {ordered.map((finding) => (
              <FindingCard key={`${finding.agent_name}-${finding.layer}`} finding={finding} />
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
