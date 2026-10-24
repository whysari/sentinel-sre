"use client";

import type { IncidentSummary } from "../types/sentinel";
import { INCIDENT_CATEGORIES } from "../types/sentinel";
import type { ConsoleFilters } from "../lib/console-store";
import {
  categoryAccent,
  categoryLabel,
  cn,
  formatLatency,
  formatPercent,
  formatRelativeTime,
  truncate,
} from "../lib/format";
import { ActionButton, Badge, EmptyState, Panel, PanelHeader, ProgressBar, SkeletonLine } from "./ui";
import { CheckIcon, ClockIcon, SearchIcon, ShieldIcon, AlertTriangleIcon, DatabaseIcon } from "./icons";

export interface IncidentQueuePanelProps {
  incidents: IncidentSummary[];
  total: number;
  selectedId: string | null;
  filters: ConsoleFilters;
  loading: boolean;
  onSelect: (incidentId: string) => void;
  onSearch: (search: string) => void;
  onFilter: (patch: Partial<ConsoleFilters>) => void;
}

const SEVERITIES = ["all", "critical", "warning", "info"] as const;

export function IncidentQueuePanel({
  incidents,
  total,
  selectedId,
  filters,
  loading,
  onSelect,
  onSearch,
  onFilter,
}: IncidentQueuePanelProps) {
  return (
    <Panel id="incident-queue">
      <PanelHeader
        eyebrow="Persisted triage reports"
        title="Incident Queue"
        subtitle={`${incidents.length} of ${total} incidents visible · newest first · clicking a row loads the full report, Wait-For Graph and guardrail audit.`}
        icon={<ClockIcon size={17} />}
        actions={
          <div className="flex items-center gap-1.5">
            <Badge tone="info">{total} total</Badge>
            {filters.onlyAdversarial ? <Badge tone="critical">adversarial</Badge> : null}
            {filters.onlyWithDr ? <Badge tone="success">DR verified</Badge> : null}
          </div>
        }
      />

      <div className="space-y-3 px-5 pb-5 pt-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="relative flex-1">
            <span className="sr-only">Search incidents</span>
            <SearchIcon size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={filters.search}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Search incident, service, runbook or root cause…"
              className="w-full rounded-lg border border-white/10 bg-black/30 py-2 pl-9 pr-3 text-xs text-slate-200 placeholder:text-slate-600 focus:border-sky-400/40 focus:outline-none focus:ring-1 focus:ring-sky-400/30"
            />
          </label>
          <div className="flex items-center gap-1.5">
            <select
              aria-label="Filter by category"
              value={filters.category}
              onChange={(event) => onFilter({ category: event.target.value })}
              className="max-w-[170px] rounded-lg border border-white/10 bg-black/30 px-2 py-2 text-[11px] text-slate-300 focus:border-sky-400/40 focus:outline-none"
            >
              <option value="all">All categories</option>
              {INCIDENT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {categoryLabel(category)}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by severity"
              value={filters.severity}
              onChange={(event) => onFilter({ severity: event.target.value })}
              className="rounded-lg border border-white/10 bg-black/30 px-2 py-2 text-[11px] text-slate-300 focus:border-sky-400/40 focus:outline-none"
            >
              {SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {severity === "all" ? "All severities" : severity}
                </option>
              ))}
            </select>
            <ActionButton
              size="xs"
              variant={filters.onlyAdversarial ? "danger" : "outline"}
              onClick={() => onFilter({ onlyAdversarial: !filters.onlyAdversarial })}
              title="Show only incidents with a neutralized prompt injection"
            >
              <ShieldIcon size={12} />
            </ActionButton>
            <ActionButton
              size="xs"
              variant={filters.onlyWithDr ? "primary" : "outline"}
              onClick={() => onFilter({ onlyWithDr: !filters.onlyWithDr })}
              title="Show only incidents with a passed DR verification"
            >
              <DatabaseIcon size={12} />
            </ActionButton>
          </div>
        </div>

        {loading && incidents.length === 0 ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} className="space-y-2 rounded-xl border border-white/[0.06] p-3">
                <SkeletonLine className="w-1/3" />
                <SkeletonLine className="w-2/3" />
                <SkeletonLine className="w-1/2" />
              </div>
            ))}
          </div>
        ) : incidents.length === 0 ? (
          <EmptyState
            title="No incidents match"
            detail={
              total === 0
                ? "The persistence store is empty. Inject a chaos scenario or call POST /api/v1/triage."
                : "Relax the category, severity, adversarial or DR filters to reveal persisted incidents."
            }
            icon={<AlertTriangleIcon size={22} />}
          />
        ) : (
          <ul className="max-h-[520px] space-y-1.5 overflow-y-auto pr-1" aria-label="Incident list">
            {incidents.map((incident) => {
              const selected = incident.incident_id === selectedId;
              return (
                <li key={incident.incident_id}>
                  <button
                    type="button"
                    onClick={() => onSelect(incident.incident_id)}
                    aria-current={selected ? "true" : undefined}
                    className={cn(
                      "w-full rounded-xl border p-2.5 text-left transition",
                      selected
                        ? "border-sky-400/40 bg-sky-400/[0.07] shadow-[0_0_0_1px_rgba(56,189,248,0.12)]"
                        : "border-white/[0.06] bg-white/[0.015] hover:border-white/15 hover:bg-white/[0.04]",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            incident.severity === "critical"
                              ? "bg-rose-400"
                              : incident.severity === "warning"
                                ? "bg-amber-400"
                                : "bg-sky-400",
                          )}
                        />
                        <span className="font-mono text-[11px] font-semibold text-slate-100">{incident.incident_id}</span>
                        <span className={cn("truncate rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", categoryAccent(incident.diagnosed_category))}>
                          {categoryLabel(incident.diagnosed_category)}
                        </span>
                      </div>
                      <span className="shrink-0 text-[9px] text-slate-500">{formatRelativeTime(incident.created_at)}</span>
                    </div>

                    <p className="mt-1.5 truncate text-[11px] text-slate-400" title={incident.root_cause_summary}>
                      {truncate(incident.root_cause_summary, 104)}
                    </p>

                    <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center justify-between gap-2 text-[9px] text-slate-500">
                          <span className="truncate font-mono">{incident.service}</span>
                          <span className="shrink-0">
                            {incident.confidence >= 0 ? formatPercent(incident.confidence, 0) : "—"}
                          </span>
                        </div>
                        <ProgressBar
                          value={incident.confidence}
                          tone={incident.confidence >= 0.92 ? "success" : incident.confidence >= 0.8 ? "info" : "warning"}
                          height="xs"
                          className="mt-1"
                          label={`${incident.incident_id} confidence`}
                        />
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {incident.prompt_injection_neutralized ? (
                          <span title="Prompt injection neutralized" className="text-rose-300">
                            <ShieldIcon size={12} />
                          </span>
                        ) : null}
                        {incident.dr_drills_passed > 0 ? (
                          <span title="Cryptographic DR drill passed" className="inline-flex items-center gap-0.5 text-emerald-300">
                            <CheckIcon size={11} />
                            <span className="font-mono text-[9px]">{incident.dr_drills_passed}</span>
                          </span>
                        ) : null}
                        <span className="font-mono text-[9px] text-slate-500">{formatLatency(incident.triage_latency_ms)}</span>
                        <span className="rounded bg-white/[0.05] px-1 py-0.5 font-mono text-[9px] text-slate-400">
                          {incident.cited_runbook_id}
                        </span>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
