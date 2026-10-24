"use client";

import { useMemo, useState } from "react";
import type { ChaosEvaluation, ChaosScenarioSummary } from "../types/sentinel";
import { INCIDENT_CATEGORIES } from "../types/sentinel";
import type { ChaosProgressView } from "../lib/console-store";
import {
  categoryAccent,
  categoryLabel,
  cn,
  formatPercent,
  toneClasses,
  truncate,
} from "../lib/format";
import { ActionButton, Badge, EmptyState, Panel, PanelHeader, ProgressBar } from "./ui";
import {
  AlertTriangleIcon,
  BoltIcon,
  CheckIcon,
  CloseIcon,
  PlayIcon,
  ShieldIcon,
  StopIcon,
} from "./icons";

export interface ChaosFaultInjectorPanelProps {
  scenarios: ChaosScenarioSummary[];
  runningScenarioId: string | null;
  progress: ChaosProgressView;
  lastEvaluation: ChaosEvaluation | null;
  disabled?: boolean;
  onInject: (scenarioId: string) => void;
  onStreamAll: () => void;
  onCancel: () => void;
}

const ADVERSARIAL_HINT = "Prompt-injection payload is scrubbed before any command reaches the guardrail.";

export function ChaosFaultInjectorPanel({
  scenarios,
  runningScenarioId,
  progress,
  lastEvaluation,
  disabled,
  onInject,
  onStreamAll,
  onCancel,
}: ChaosFaultInjectorPanelProps) {
  const [category, setCategory] = useState<string>("all");
  const [showAdversarialOnly, setShowAdversarialOnly] = useState(false);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const scenario of scenarios) {
      map.set(scenario.expected_category, (map.get(scenario.expected_category) ?? 0) + 1);
    }
    return map;
  }, [scenarios]);

  const visible = useMemo(
    () =>
      scenarios.filter((scenario) => {
        if (category !== "all" && scenario.expected_category !== category) {
          return false;
        }
        if (showAdversarialOnly && !scenario.is_adversarial) {
          return false;
        }
        return true;
      }),
    [scenarios, category, showAdversarialOnly],
  );

  const running = progress.status === "running" || progress.status === "streaming";
  const adversarialCount = scenarios.filter((scenario) => scenario.is_adversarial).length;

  return (
    <Panel tone={running ? "warning" : "accent"} id="chaos-injector">
      <PanelHeader
        eyebrow="Fault injection"
        title="Chaos Scenario Launcher"
        subtitle="Run any of the 24 benchmark fault scenarios through the full multi-agent triage pipeline. Streaming mode emits one SSE frame per incident so the console updates in real time."
        icon={<BoltIcon size={17} />}
        tone="warning"
        actions={
          <>
            <Badge tone="neutral">{scenarios.length} scenarios</Badge>
            <Badge tone="critical" dot>
              {adversarialCount} adversarial
            </Badge>
          </>
        }
      />

      <div className="space-y-4 px-5 pb-5 pt-4">
        <div className="flex flex-col gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.045] p-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-amber-100">Inject All 24 Chaos Scenarios (SSE Stream)</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-amber-200/60">
              Executes VXLAN, PostgreSQL WFG, cgroup OOM, disk pressure, CoreDNS, TLS, registry and crash-loop faults in sequence.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {running ? (
              <ActionButton variant="danger" size="sm" onClick={onCancel} title="Abort the SSE chaos stream">
                <StopIcon size={13} />
                Cancel
              </ActionButton>
            ) : (
              <ActionButton variant="primary" size="sm" onClick={onStreamAll} disabled={disabled} title="Stream all 24 scenarios">
                <PlayIcon size={13} />
                Inject all 24
              </ActionButton>
            )}
          </div>
        </div>

        {running || progress.status === "complete" ? (
          <div className="rounded-xl border border-white/10 bg-black/25 p-3" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-[11px]">
              <span className="inline-flex items-center gap-2 font-semibold text-slate-200">
                <span className={cn("h-1.5 w-1.5 rounded-full", running ? "animate-pulse bg-amber-300" : "bg-emerald-400")} />
                {running ? "Streaming triage pipeline" : "Chaos run complete"}
                <span className="font-normal text-slate-500">· {progress.label}</span>
              </span>
              <span className="font-mono text-slate-400">{progress.percent}%</span>
            </div>
            <ProgressBar value={progress.percent / 100} tone={running ? "warning" : "success"} className="mt-2" label="Chaos run progress" />
          </div>
        ) : null}

        {lastEvaluation ? (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <EvaluationTile label="Category accuracy" value={formatPercent(lastEvaluation.accuracy)} tone={lastEvaluation.accuracy >= 0.99 ? "success" : "warning"} />
            <EvaluationTile label="Runbook recall@1" value={formatPercent(lastEvaluation.runbook_recall_at_1)} tone="info" />
            <EvaluationTile
              label="Injection intercept"
              value={`${lastEvaluation.adversarial_intercepted}/${lastEvaluation.adversarial_total}`}
              tone={lastEvaluation.adversarial_intercepted === lastEvaluation.adversarial_total ? "success" : "critical"}
            />
            <EvaluationTile label="DR drills passed" value={String(lastEvaluation.dr_drills_passed)} tone="info" />
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5">
          <FilterPill active={category === "all"} onClick={() => setCategory("all")} label="All" count={scenarios.length} />
          {INCIDENT_CATEGORIES.map((item) => (
            <FilterPill
              key={item}
              active={category === item}
              onClick={() => setCategory(item)}
              label={categoryLabel(item)}
              count={counts.get(item) ?? 0}
              accent={categoryAccent(item)}
            />
          ))}
          <button
            type="button"
            onClick={() => setShowAdversarialOnly((value) => !value)}
            className={cn(
              "ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] transition",
              showAdversarialOnly
                ? "border-rose-400/40 bg-rose-500/15 text-rose-200"
                : "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200",
            )}
            title={ADVERSARIAL_HINT}
          >
            <ShieldIcon size={11} />
            adversarial only
          </button>
        </div>

        {scenarios.length === 0 ? (
          <EmptyState
            title="Chaos catalog unavailable"
            detail="Start the Python API (`python3 -m sentinel.api --server wsgi`) or switch the console to offline demo mode."
            icon={<AlertTriangleIcon size={22} />}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title="No scenario matches this filter"
            detail="Clear the category or adversarial filter to reveal the rest of the 24-scenario catalog."
            icon={<AlertTriangleIcon size={22} />}
          />
        ) : (
          <div className="grid max-h-[430px] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((scenario) => {
              const isRunning = runningScenarioId === scenario.scenario_id;
              return (
                <button
                  key={scenario.scenario_id}
                  type="button"
                  onClick={() => onInject(scenario.scenario_id)}
                  disabled={disabled || running}
                  title={`Inject ${scenario.scenario_id} — ${scenario.summary}`}
                  className={cn(
                    "group relative flex flex-col gap-2 rounded-xl border p-3 text-left transition",
                    "border-white/[0.07] bg-white/[0.02] hover:border-sky-400/30 hover:bg-sky-400/[0.05]",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    isRunning && "border-amber-400/40 bg-amber-400/[0.06]",
                  )}
                >
                  <div className="flex w-full items-start justify-between gap-2">
                    <span className="font-mono text-[11px] font-semibold text-slate-100">{scenario.scenario_id}</span>
                    <span className="flex items-center gap-1">
                      {scenario.is_adversarial ? (
                        <span className="rounded border border-rose-400/30 bg-rose-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-rose-200">
                          inject
                        </span>
                      ) : null}
                      {isRunning ? (
                        <span className="text-amber-300">
                          <BoltIcon size={13} className="animate-pulse" />
                        </span>
                      ) : (
                        <PlayIcon size={11} className="text-slate-600 transition group-hover:text-sky-300" />
                      )}
                    </span>
                  </div>
                  <span className={cn("w-fit rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", categoryAccent(scenario.expected_category))}>
                    {categoryLabel(scenario.expected_category)}
                  </span>
                  <span className="line-clamp-2 text-[11px] leading-snug text-slate-400">{truncate(scenario.summary, 92)}</span>
                  <span className="mt-auto flex items-center justify-between gap-2 text-[10px] text-slate-600">
                    <span className="truncate font-mono">{scenario.alert_name}</span>
                    <span className="shrink-0 text-slate-500">{scenario.expected_runbook_id}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-slate-600">
          <CloseIcon size={11} className="mt-0.5 shrink-0" />
          Every scenario executes the real coordinator: 3 agents in parallel, hybrid RRF runbook retrieval, shlex guardrail audit, SQLite/PostgreSQL persistence and cryptographic DR verification.
        </p>
      </div>
    </Panel>
  );
}

function FilterPill({
  active,
  label,
  count,
  onClick,
  accent,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
  accent?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold transition",
        active
          ? cn("border-sky-400/40 bg-sky-400/10 text-sky-200", accent)
          : "border-white/10 bg-white/[0.02] text-slate-400 hover:border-white/20 hover:text-slate-200",
      )}
    >
      {label}
      <span className={cn("rounded-full px-1 text-[9px]", active ? "bg-sky-400/20 text-sky-100" : "bg-white/[0.06] text-slate-500")}>
        {count}
      </span>
    </button>
  );
}

function EvaluationTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "success" | "warning" | "critical" | "info";
}) {
  return (
    <div className={cn("rounded-lg border px-2.5 py-2", toneClasses(tone))}>
      <p className="text-[9px] font-semibold uppercase tracking-[0.12em] opacity-70">{label}</p>
      <p className="mt-0.5 font-mono text-sm font-semibold">{value}</p>
    </div>
  );
}
