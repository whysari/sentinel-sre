"use client";

import type { IncidentDetailResponse } from "../types/sentinel";
import { cn } from "../lib/format";
import { Badge } from "./ui";
import {
  ActivityIcon,
  DatabaseIcon,
  GitBranchIcon,
  LayersIcon,
  ShieldIcon,
  SparkIcon,
  TerminalIcon,
  ArrowRightIcon,
} from "./icons";

export interface PipelineStripProps {
  incident: IncidentDetailResponse | null;
  live: boolean;
}

interface Stage {
  id: string;
  label: string;
  detail: string;
  icon: typeof ActivityIcon;
  tone: "info" | "success" | "warning" | "critical" | "neutral";
}

export function PipelineStrip({ incident, live }: PipelineStripProps) {
  const stages: Stage[] = [
    {
      id: "ingest",
      label: "Ingest",
      detail: "webhook / chaos",
      icon: ActivityIcon,
      tone: live ? "success" : "neutral",
    },
    {
      id: "agents",
      label: "3 agents",
      detail: incident ? `${incident.agent_findings.filter((finding) => finding.anomaly_detected).length} anomalies` : "parallel",
      icon: LayersIcon,
      tone: incident ? "info" : "neutral",
    },
    {
      id: "rrf",
      label: "Hybrid RRF",
      detail: incident ? `${incident.cited_runbook_id} cited` : "BM25 + cosine",
      icon: SparkIcon,
      tone: incident ? "success" : "neutral",
    },
    {
      id: "wfg",
      label: "Wait-For Graph",
      detail: incident ? `${incident.wait_for_graph.nodes.length} sessions` : "pg_locks",
      icon: GitBranchIcon,
      tone: incident && incident.wait_for_graph.deadlock_cycles.length > 0 ? "critical" : incident ? "warning" : "neutral",
    },
    {
      id: "guardrail",
      label: "shlex guardrail",
      detail: incident ? `${incident.blocked_unsafe_commands.length} blocked` : "read-only only",
      icon: ShieldIcon,
      tone: incident && incident.blocked_unsafe_commands.length > 0 ? "warning" : incident ? "success" : "neutral",
    },
    {
      id: "dr",
      label: "DR drill",
      detail: incident?.dr_drill_result ? `${incident.dr_drill_result.rto_ms.toFixed(1)} ms RTO` : "on demand",
      icon: DatabaseIcon,
      tone: incident?.dr_drill_result ? "success" : "neutral",
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-white/[0.06] bg-black/20 p-2">
      <span className="inline-flex items-center gap-1 px-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-600">
        <TerminalIcon size={11} />
        pipeline
      </span>
      {stages.map((stage, index) => {
        const Icon = stage.icon;
        return (
          <div key={stage.id} className="flex items-center gap-1.5">
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-lg border px-2 py-1",
                stage.tone === "success"
                  ? "border-emerald-500/20 bg-emerald-500/[0.05] text-emerald-200"
                  : stage.tone === "info"
                    ? "border-sky-500/20 bg-sky-500/[0.05] text-sky-200"
                    : stage.tone === "warning"
                      ? "border-amber-500/20 bg-amber-500/[0.05] text-amber-200"
                      : stage.tone === "critical"
                        ? "border-rose-500/25 bg-rose-500/[0.06] text-rose-200"
                        : "border-white/[0.07] bg-white/[0.02] text-slate-400",
              )}
            >
              <Icon size={11} />
              <span className="text-[10px] font-semibold">{stage.label}</span>
              <span className="hidden font-mono text-[9px] opacity-60 sm:inline">{stage.detail}</span>
            </div>
            {index < stages.length - 1 ? <ArrowRightIcon size={9} className="text-slate-700" /> : null}
          </div>
        );
      })}
      {incident?.prompt_injection_neutralized ? (
        <Badge tone="critical" className="ml-auto">
          injection scrubbed pre-dispatch
        </Badge>
      ) : (
        <Badge tone="neutral" className="ml-auto">
          zero-trust
        </Badge>
      )}
    </div>
  );
}
