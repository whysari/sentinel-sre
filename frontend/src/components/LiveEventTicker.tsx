"use client";

import type { ConsoleEventLogEntry } from "../lib/console-store";
import { cn, formatClock, toneClasses } from "../lib/format";
import { Badge, EmptyState, LiveDot, Panel, PanelHeader } from "./ui";
import { ActivityIcon, RadioIcon } from "./icons";

export interface LiveEventTickerProps {
  events: ConsoleEventLogEntry[];
  streaming: boolean;
  offline: boolean;
  lastEventId: string | null;
}

export function LiveEventTicker({ events, streaming, offline, lastEventId }: LiveEventTickerProps) {
  return (
    <Panel id="event-ticker">
      <PanelHeader
        eyebrow="Server-sent events"
        title="Live Triage & DR Event Feed"
        subtitle="Every coordinator escalation, guardrail rejection and DR verification is published to `/api/v1/events/stream` and applied through the pure reducer."
        icon={<RadioIcon size={17} />}
        tone={streaming ? "success" : "neutral"}
        actions={
          <>
            <span className="inline-flex items-center gap-1.5 text-[10px] text-slate-400">
              <LiveDot active={streaming && !offline} tone={streaming ? "success" : "warning"} />
              {offline ? "offline demo" : streaming ? "connected" : "reconnecting"}
            </span>
            <Badge tone="neutral">last id {lastEventId ?? "—"}</Badge>
            <Badge tone="info">{events.length} events</Badge>
          </>
        }
      />

      <div className="px-5 pb-5 pt-4">
        {events.length === 0 ? (
          <EmptyState
            title="Waiting for live events"
            detail="Inject a chaos scenario or run a DR drill. New `incident.triaged`, `dr.drill.completed` and `chaos.run.completed` frames will appear here instantly."
            icon={<ActivityIcon size={22} />}
          />
        ) : (
          <ol className="max-h-[280px] space-y-1 overflow-y-auto pr-1" aria-live="polite">
            {events.map((entry, index) => (
              <li
                key={entry.key}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border px-2.5 py-2 transition",
                  index === 0 ? "border-white/15 bg-white/[0.04]" : "border-white/[0.05] bg-white/[0.015]",
                )}
              >
                <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border", toneClasses(entry.tone))}>
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <p className="text-[11px] font-semibold text-slate-200">{entry.headline}</p>
                    <span className="font-mono text-[9px] text-slate-600">
                      {formatClock(entry.receivedAt)} · {entry.event}
                    </span>
                  </div>
                  <p className="mt-0.5 break-words text-[10px] leading-relaxed text-slate-500">{entry.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Panel>
  );
}
