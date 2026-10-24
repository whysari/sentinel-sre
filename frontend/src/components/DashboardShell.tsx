"use client";

import { useMemo } from "react";
import { useSentinelConsole } from "../hooks/useSentinelConsole";
import {
  selectChaosProgress,
  selectEventTicker,
  selectFilteredIncidents,
} from "../lib/console-store";
import { cn, formatClock, formatPercent } from "../lib/format";
import { ActionButton, Badge, LiveDot, Spinner } from "./ui";
import { AgentFindingsMatrix } from "./AgentFindingsMatrix";
import { ChaosFaultInjectorPanel } from "./ChaosFaultInjectorPanel";
import { GuardrailAndDrAuditPanel } from "./GuardrailAndDrAuditPanel";
import { IncidentContextBar } from "./IncidentContextBar";
import { IncidentQueuePanel } from "./IncidentQueuePanel";
import { KpiHeaderBar } from "./KpiHeaderBar";
import { LiveEventTicker } from "./LiveEventTicker";
import { PipelineStrip } from "./PipelineStrip";
import { WaitForGraphVisualizer } from "./WaitForGraphVisualizer";
import {
  ActivityIcon,
  CloseIcon,
  RefreshIcon,
  ShieldIcon,
  SparkIcon,
  WifiOffIcon,
} from "./icons";

export function DashboardShell() {
  const {
    state,
    streaming,
    loading,
    lastSyncedAt,
    refresh,
    selectIncident,
    injectChaos,
    streamAllChaos,
    cancelChaos,
    runDrDrill,
    changeFilter,
    search,
    clearError,
    toggleOffline,
  } = useSentinelConsole();

  const filtered = useMemo(() => selectFilteredIncidents(state), [state]);
  const progress = selectChaosProgress(state);
  const events = selectEventTicker(state, 40);
  const incident = state.selectedIncident;
  const runningScenarioId =
    state.chaosRun &&
    (state.chaosRun.status === "running" || state.chaosRun.status === "streaming") &&
    state.chaosRun.scenarioId !== "all"
      ? state.chaosRun.scenarioId
      : null;
  const chaosBusy = progress.status === "running" || progress.status === "streaming";

  return (
    <div className="relative min-h-screen">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,rgba(56,189,248,0.12),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(167,139,250,0.09),transparent_50%)]" />
      <div className="pointer-events-none fixed inset-0 -z-10 opacity-[0.35] [background-image:linear-gradient(rgba(30,42,68,0.35)_1px,transparent_1px),linear-gradient(90deg,rgba(30,42,68,0.35)_1px,transparent_1px)] [background-size:64px_64px]" />

      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-sentinel-void/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1700px] flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
          <div className="flex items-center gap-3">
            <div className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-sky-400/30 bg-sky-400/[0.08] text-sky-300 shadow-glow">
              <ShieldIcon size={20} />
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-sentinel-void" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-bold tracking-[0.16em] text-slate-100">SENTINEL</h1>
                <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-slate-400">
                  SRE console
                </span>
              </div>
              <p className="text-[10px] text-slate-500">
                Multi-agent triage · zero-trust guardrails · cryptographic DR verification
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1 text-[10px] text-slate-400">
              <ActivityIcon size={12} className={streaming ? "text-emerald-300" : "text-slate-500"} />
              <LiveDot active={streaming && !state.offline} tone={streaming ? "success" : "warning"} />
              {state.offline ? "offline fixtures" : streaming ? "SSE live" : "polling"}
            </span>
            <span className="hidden items-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1 text-[10px] text-slate-400 sm:inline-flex">
              <SparkIcon size={12} className="text-violet-300" />
              {state.stats ? formatPercent(state.stats.accuracy ?? state.stats.mean_confidence) : "—"} accuracy
            </span>
            {lastSyncedAt ? (
              <span className="hidden rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1 font-mono text-[10px] text-slate-500 lg:inline-block">
                sync {formatClock(lastSyncedAt)}
              </span>
            ) : null}
            <ActionButton
              size="xs"
              variant={state.offline ? "primary" : "outline"}
              onClick={toggleOffline}
              title={state.offline ? "Reconnect to the live Python API" : "Switch to deterministic offline demo fixtures"}
            >
              {state.offline ? <WifiOffIcon size={12} /> : <ActivityIcon size={12} />}
              {state.offline ? "Go live" : "Offline demo"}
            </ActionButton>
            <ActionButton size="xs" variant="outline" onClick={() => void refresh()} disabled={loading} title="Reload stats, incidents, chaos catalog and DR history">
              {loading ? <Spinner className="h-3 w-3" /> : <RefreshIcon size={12} />}
              Sync
            </ActionButton>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1700px] space-y-4 px-4 py-5 md:px-6 md:py-6">
        {state.error ? (
          <div className="flex items-start justify-between gap-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-2.5 text-[11px] leading-relaxed text-amber-100">
            <span className="flex gap-2">
              <ShieldIcon size={14} className="mt-0.5 shrink-0 text-amber-300" />
              <span>{state.error}</span>
            </span>
            <button type="button" onClick={clearError} className="shrink-0 rounded p-0.5 text-amber-300/70 hover:bg-white/10 hover:text-amber-100" aria-label="Dismiss notice">
              <CloseIcon size={13} />
            </button>
          </div>
        ) : null}

        <KpiHeaderBar stats={state.stats} loading={loading} streaming={streaming && !state.offline} offline={state.offline} onRefresh={() => void refresh()} />

        <PipelineStrip incident={incident} live={streaming || state.offline} />

        <IncidentContextBar incident={incident} loading={loading} />

        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(340px,390px)_minmax(0,1fr)]">
          <div className="space-y-4">
            <IncidentQueuePanel
              incidents={filtered}
              total={state.incidentTotal || state.incidents.length}
              selectedId={state.selectedIncidentId}
              filters={state.filters}
              loading={loading}
              onSelect={(incidentId) => void selectIncident(incidentId)}
              onSearch={search}
              onFilter={changeFilter}
            />
            <ChaosFaultInjectorPanel
              scenarios={state.chaosCatalog}
              runningScenarioId={runningScenarioId}
              progress={progress}
              lastEvaluation={state.chaosRun?.evaluation ?? null}
              disabled={chaosBusy || loading}
              onInject={(scenarioId) => void injectChaos(scenarioId)}
              onStreamAll={streamAllChaos}
              onCancel={cancelChaos}
            />
          </div>

          <div className="space-y-4">
            <AgentFindingsMatrix
              findings={incident?.agent_findings ?? []}
              incidentId={incident?.incident_id}
              rootCauseSummary={incident?.root_cause_summary}
              loading={loading && !incident}
            />
            <WaitForGraphVisualizer payload={incident?.wait_for_graph ?? null} incidentId={incident?.incident_id} loading={loading && !incident} />
            <GuardrailAndDrAuditPanel
              incident={incident}
              verifications={state.drVerifications}
              drilling={state.drDrill.status === "running"}
              drillResult={state.drDrill.result}
              drillError={state.drDrill.error}
              onRunDrill={() => void runDrDrill()}
            />
            <LiveEventTicker events={events} streaming={streaming} offline={state.offline} lastEventId={state.lastEventId} />
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-4 pb-2 text-[10px] text-slate-600">
          <span>
            Sentinel-SRE · FastAPI/WSGI + Next.js 16 App Router + React 19.3 · strict TypeScript ·{" "}
            <span className="font-mono">bun test</span> verified
          </span>
          <span className={cn("font-mono", state.offline ? "text-amber-400/70" : "text-emerald-400/70")}>
            {state.offline ? "offline://sentinel-sre" : "GET /api/v1/events/stream"}
          </span>
        </footer>
      </main>
    </div>
  );
}
