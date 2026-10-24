"use client";

import type { DashboardStats } from "../types/sentinel";
import { kpiCardsFromStats, type KpiCard } from "../lib/console-store";
import { cn, formatClock, formatRelativeTime, toneClasses } from "../lib/format";
import { ActionButton, Badge, LiveDot, Panel, ProgressBar, SkeletonLine } from "./ui";
import {
  ActivityIcon,
  ClockIcon,
  DatabaseIcon,
  RefreshIcon,
  ShieldIcon,
  SparkIcon,
  TerminalIcon,
  AlertTriangleIcon,
} from "./icons";

const CARD_ICONS: Record<string, typeof ActivityIcon> = {
  triaged: ActivityIcon,
  accuracy: SparkIcon,
  injections: ShieldIcon,
  blocked: TerminalIcon,
  dr: DatabaseIcon,
  latency: ClockIcon,
};

export interface KpiHeaderBarProps {
  stats: DashboardStats | null;
  loading?: boolean;
  streaming?: boolean;
  offline?: boolean;
  onRefresh?: () => void;
}

function KpiCardView({ card, index }: { card: KpiCard; index: number }) {
  const Icon = CARD_ICONS[card.id] ?? AlertTriangleIcon;
  const isLatency = card.id === "latency";
  return (
    <Panel
      as="article"
      className={cn(
        "group animate-slide-up p-4 transition md:p-5",
        "hover:border-white/15 hover:shadow-glow",
      )}
      tone={card.tone}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{card.label}</p>
          <p
            className={cn(
              "mt-2 font-mono font-semibold tracking-tight text-slate-50",
              isLatency ? "text-xl xl:text-[22px]" : "text-3xl",
            )}
          >
            {card.value}
          </p>
        </div>
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition group-hover:scale-105",
            toneClasses(card.tone),
          )}
        >
          <Icon size={16} />
        </span>
      </div>
      <p className="mt-2 truncate text-[11px] text-slate-500" title={card.hint}>
        {card.hint}
      </p>
      <ProgressBar value={card.progress} tone={card.tone} height="xs" className="mt-3" label={card.label} />
      <span className="sr-only">KPI {index + 1}</span>
    </Panel>
  );
}

export function KpiHeaderBar({ stats, loading, streaming, offline, onRefresh }: KpiHeaderBarProps) {
  const cards = kpiCardsFromStats(stats);
  return (
    <section aria-label="Executive telemetry" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-lg font-semibold tracking-tight text-slate-100">Executive Telemetry</h1>
          <Badge tone={streaming ? "success" : "neutral"} dot>
            {streaming ? "live SSE" : "polling"}
          </Badge>
          {offline ? <Badge tone="warning">offline demo</Badge> : null}
          {stats ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
              <LiveDot active={streaming === true} />
              snapshot {formatClock(stats.generated_at)} · {formatRelativeTime(stats.generated_at)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] text-slate-500 sm:inline">
            {stats ? `${stats.runbooks_indexed} runbooks · ${stats.chaos_scenarios_available} chaos scenarios` : "connecting…"}
          </span>
          {onRefresh ? (
            <ActionButton onClick={onRefresh} disabled={loading} size="xs" title="Refresh every dashboard resource">
              <RefreshIcon size={13} className={loading ? "animate-spin" : undefined} />
              Refresh
            </ActionButton>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {loading && !stats
          ? cards.map((card, index) => (
              <Panel key={card.id} as="article" className="space-y-3 p-4" tone="neutral">
                <SkeletonLine className="w-2/3" />
                <SkeletonLine className="h-7 w-1/2" />
                <SkeletonLine className="w-1/2" />
                <div className="h-1 animate-pulse rounded bg-white/[0.06]" />
                <span className="sr-only">loading card {index + 1}</span>
              </Panel>
            ))
          : cards.map((card, index) => <KpiCardView key={card.id} card={card} index={index} />)}
      </div>
    </section>
  );
}
