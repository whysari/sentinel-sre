/**
 * Deterministic console state machine.
 *
 * The reducer is a pure function: every transition returns a new `ConsoleState`, never mutates the
 * previous one, and every non-deterministic input (SSE receive time, generated stats) is supplied
 * by the caller. That makes the exact dashboard behaviour reproducible in `bun test`.
 */

import type {
  AgentFinding,
  ChaosCatalogResponse,
  ChaosEvaluation,
  ChaosReport,
  ChaosScenarioSummary,
  DashboardStats,
  DrRestoreResult,
  DrVerificationRow,
  IncidentDetailResponse,
  IncidentSummary,
  JsonRecord,
  SseChaosCompletedData,
  SseDrEventData,
  SseEventEnvelope,
  SseTriageEventData,
} from "../types/sentinel";
import {
  isChaosCatalogResponse,
  isChaosEvaluation,
  isDrRestoreResult,
  isDrVerificationRow,
  isIncidentDetailResponse,
  isSseDrEventData,
  isSseTriageEventData,
} from "../types/sentinel";
import { formatLatency, formatPercent, titleCase } from "./format";

/* --------------------------------------------------------------------------------------------- */
/* State shapes                                                                                   */
/* --------------------------------------------------------------------------------------------- */

export type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface ConsoleFilters {
  category: string;
  severity: string;
  search: string;
  onlyAdversarial: boolean;
  onlyWithDr: boolean;
}

export interface ConsoleEventLogEntry {
  key: string;
  id: string | null;
  event: string;
  receivedAt: string;
  headline: string;
  detail: string;
  tone: "critical" | "warning" | "info" | "success" | "neutral";
  data: JsonRecord;
}

export interface ChaosRunState {
  scenarioId: string;
  total: number;
  completed: number;
  status: "running" | "streaming" | "complete" | "error";
  startedAt: string;
  evaluation: ChaosEvaluation | null;
  message: string;
}

export interface DrDrillUiState {
  status: "idle" | "running" | "success" | "error";
  incidentId: string | null;
  startedAt: string | null;
  result: DrRestoreResult | null;
  error: string | null;
}

export interface ConsoleState {
  status: LoadStatus;
  offline: boolean;
  stats: DashboardStats | null;
  incidents: IncidentSummary[];
  incidentTotal: number;
  selectedIncidentId: string | null;
  selectedIncident: IncidentDetailResponse | null;
  chaosCatalog: ChaosScenarioSummary[];
  drVerifications: DrVerificationRow[];
  filters: ConsoleFilters;
  events: ConsoleEventLogEntry[];
  lastEventId: string | null;
  latencySamples: number[];
  rtoSamples: number[];
  chaosRun: ChaosRunState | null;
  drDrill: DrDrillUiState;
  error: string | null;
}

/* --------------------------------------------------------------------------------------------- */
/* Actions                                                                                        */
/* --------------------------------------------------------------------------------------------- */

export type ConsoleAction =
  | { type: "STATS_LOADED"; stats: DashboardStats }
  | { type: "STATS_FAILED"; error: string }
  | { type: "INCIDENTS_LOADED"; incidents: IncidentSummary[]; total?: number }
  | { type: "INCIDENT_SELECTED"; incident: IncidentDetailResponse }
  | { type: "INCIDENT_CLEARED" }
  | { type: "CHAOS_CATALOG_LOADED"; catalog: ChaosCatalogResponse }
  | { type: "DR_VERIFICATIONS_LOADED"; verifications: DrVerificationRow[] }
  | { type: "SSE_TRIAGE_EVENT"; envelope: SseEventEnvelope; receivedAt: string }
  | { type: "SSE_DR_EVENT"; envelope: SseEventEnvelope; receivedAt: string }
  | { type: "SSE_CHAOS_EVENT"; envelope: SseEventEnvelope; receivedAt: string }
  | { type: "CHAOS_INJECTION_STARTED"; scenarioId: string; total?: number; startedAt?: string }
  | { type: "CHAOS_PROGRESS"; completed: number; total: number }
  | { type: "CHAOS_COMPLETED"; evaluation: ChaosEvaluation; receivedAt?: string }
  | { type: "CHAOS_FAILED"; message: string }
  | { type: "DR_DRILL_STARTED"; incidentId?: string | null; startedAt?: string }
  | { type: "DR_DRILL_COMPLETED"; result: DrRestoreResult; receivedAt?: string }
  | { type: "DR_DRILL_FAILED"; error: string }
  | { type: "FILTER_CHANGED"; patch: Partial<ConsoleFilters> }
  | { type: "SEARCH_CHANGED"; search: string }
  | { type: "OFFLINE_MODE_CHANGED"; offline: boolean }
  | { type: "ERROR"; error: string | null }
  | { type: "RESET"; state?: ConsoleState };

/* --------------------------------------------------------------------------------------------- */
/* Initial state                                                                                  */
/* --------------------------------------------------------------------------------------------- */

export const DEFAULT_FILTERS: ConsoleFilters = {
  category: "all",
  severity: "all",
  search: "",
  onlyAdversarial: false,
  onlyWithDr: false,
};

export const EVENT_LOG_LIMIT = 120;

export function createInitialConsoleState(overrides: Partial<ConsoleState> = {}): ConsoleState {
  return {
    status: "idle",
    offline: false,
    stats: null,
    incidents: [],
    incidentTotal: 0,
    selectedIncidentId: null,
    selectedIncident: null,
    chaosCatalog: [],
    drVerifications: [],
    filters: { ...DEFAULT_FILTERS },
    events: [],
    lastEventId: null,
    latencySamples: [],
    rtoSamples: [],
    chaosRun: null,
    drDrill: { status: "idle", incidentId: null, startedAt: null, result: null, error: null },
    error: null,
    ...overrides,
    filters: { ...DEFAULT_FILTERS, ...(overrides.filters ?? {}) },
  };
}

/* --------------------------------------------------------------------------------------------- */
/* Projection helpers                                                                             */
/* --------------------------------------------------------------------------------------------- */

/** Project a full incident report onto the compact row shape used by the queue. */
export function incidentSummaryFromDetail(detail: IncidentDetailResponse): IncidentSummary {
  return {
    incident_id: detail.incident_id,
    alert_name: detail.alert_name,
    severity: detail.severity,
    namespace: detail.namespace,
    service: detail.service,
    diagnosed_category: detail.diagnosed_category,
    confidence: detail.confidence,
    cited_runbook_id: detail.cited_runbook_id,
    root_cause_summary: detail.root_cause_summary,
    prompt_injection_neutralized: detail.prompt_injection_neutralized,
    triage_latency_ms: detail.triage_latency_ms,
    expected_category: detail.expected_category,
    created_at: detail.created_at,
    dr_drills_passed: detail.dr_verifications?.filter((row) => row.foreign_key_check_passed).length ?? 0,
  };
}

export function isChaosReport(value: unknown): value is ChaosReport {
  return (
    isIncidentDetailResponse(value) &&
    "is_adversarial" in value &&
    typeof (value as { is_adversarial: unknown }).is_adversarial === "boolean"
  );
}

function summaryFromTriageData(data: SseTriageEventData, receivedAt: string): IncidentSummary {
  if (isChaosReport(data.report)) {
    return incidentSummaryFromDetail(data.report);
  }
  return {
    incident_id: data.incident_id,
    alert_name: data.alert_name,
    severity: typeof data.severity === "string" ? data.severity : "critical",
    namespace: "production",
    service: typeof data.service === "string" ? data.service : "unknown",
    diagnosed_category: data.diagnosed_category,
    confidence: data.confidence,
    cited_runbook_id: data.cited_runbook_id,
    root_cause_summary: `${data.alert_name} diagnosed as ${titleCase(data.diagnosed_category)} by the multi-agent coordinator.`,
    prompt_injection_neutralized: data.prompt_injection_neutralized === true,
    triage_latency_ms: data.triage_latency_ms,
    expected_category: null,
    created_at: receivedAt,
    dr_drills_passed: data.dr_drill_passed === true ? 1 : 0,
  };
}

function sortIncidents(incidents: readonly IncidentSummary[]): IncidentSummary[] {
  return [...incidents].sort((a, b) => {
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? 1 : -1;
    }
    return b.incident_id.localeCompare(a.incident_id);
  });
}

function upsertIncident(incidents: readonly IncidentSummary[], next: IncidentSummary): IncidentSummary[] {
  const filtered = incidents.filter((incident) => incident.incident_id !== next.incident_id);
  return sortIncidents([next, ...filtered]);
}

function percentile(sortedValues: readonly number[], q: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const sorted = [...sortedValues].sort((a, b) => a - b);
  const index = Math.floor(q * (sorted.length - 1));
  return sorted[index] ?? 0;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function recalculateLatencyStats(stats: DashboardStats, samples: readonly number[]): DashboardStats {
  if (samples.length === 0) {
    return stats;
  }
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    ...stats,
    mean_latency_ms: round3(mean),
    p50_latency_ms: round3(percentile(samples, 0.5)),
    p95_latency_ms: round3(percentile(samples, 0.95)),
  };
}

function appendEvent(
  events: readonly ConsoleEventLogEntry[],
  entry: ConsoleEventLogEntry,
): ConsoleEventLogEntry[] {
  const deduped = entry.id === null
    ? events
    : events.filter((existing) => !(existing.id === entry.id && existing.event === entry.event));
  return [entry, ...deduped].slice(0, EVENT_LOG_LIMIT);
}

function eventEntry(
  envelope: SseEventEnvelope,
  receivedAt: string,
  headline: string,
  detail: string,
  tone: ConsoleEventLogEntry["tone"],
): ConsoleEventLogEntry {
  return {
    key: `${envelope.event}:${envelope.id ?? "none"}:${receivedAt}:${headline}`,
    id: envelope.id,
    event: envelope.event,
    receivedAt,
    headline,
    detail,
    tone,
    data: envelope.data,
  };
}

/* --------------------------------------------------------------------------------------------- */
/* Reducer                                                                                        */
/* --------------------------------------------------------------------------------------------- */

export function consoleReducer(state: ConsoleState, action: ConsoleAction): ConsoleState {
  switch (action.type) {
    case "STATS_LOADED": {
      const stats = action.stats;
      const samples = state.latencySamples.length > 0 ? state.latencySamples : [];
      const nextStats = recalculateLatencyStats(stats, samples);
      return {
        ...state,
        status: "ready",
        stats: nextStats,
        incidentTotal: Math.max(state.incidentTotal, stats.total_incidents_triaged),
        error: null,
      };
    }

    case "STATS_FAILED":
      return { ...state, status: state.incidents.length > 0 ? "ready" : "error", error: action.error };

    case "INCIDENTS_LOADED":
      return {
        ...state,
        status: "ready",
        incidents: sortIncidents(action.incidents),
        incidentTotal: action.total ?? state.incidentTotal,
      };

    case "INCIDENT_SELECTED": {
      const summary = incidentSummaryFromDetail(action.incident);
      return {
        ...state,
        selectedIncidentId: action.incident.incident_id,
        selectedIncident: action.incident,
        incidents: upsertIncident(state.incidents, summary),
        drVerifications:
          action.incident.dr_verifications && action.incident.dr_verifications.length > 0
            ? action.incident.dr_verifications
            : state.drVerifications,
        error: null,
      };
    }

    case "INCIDENT_CLEARED":
      return { ...state, selectedIncidentId: null, selectedIncident: null };

    case "CHAOS_CATALOG_LOADED": {
      if (!isChaosCatalogResponse(action.catalog)) {
        return { ...state, error: "Chaos catalog contract violation" };
      }
      return { ...state, chaosCatalog: action.catalog.scenarios };
    }

    case "DR_VERIFICATIONS_LOADED":
      return {
        ...state,
        drVerifications: action.verifications.filter(isDrVerificationRow),
      };

    case "SSE_TRIAGE_EVENT": {
      const envelope = action.envelope;
      const data = envelope.data;
      if (!isSseTriageEventData(data)) {
        return {
          ...state,
          events: appendEvent(
            state.events,
            eventEntry(envelope, action.receivedAt, "Contract violation", "Dropped malformed incident.triaged payload", "critical"),
          ),
        };
      }
      const summary = summaryFromTriageData(data, action.receivedAt);
      const samples = [...state.latencySamples, summary.triage_latency_ms];
      const stats = state.stats;
      const categoryBreakdown = stats
        ? { ...stats.category_breakdown }
        : ({} as Record<string, number>);
      categoryBreakdown[summary.diagnosed_category] = (categoryBreakdown[summary.diagnosed_category] ?? 0) + 1;
      const severityBreakdown = stats ? { ...stats.severity_breakdown } : ({} as Record<string, number>);
      severityBreakdown[summary.severity] = (severityBreakdown[summary.severity] ?? 0) + 1;
      const nextStats: DashboardStats | null = stats
        ? recalculateLatencyStats(
            {
              ...stats,
              total_incidents_triaged: stats.total_incidents_triaged + 1,
              prompt_injections_neutralized:
                stats.prompt_injections_neutralized + (summary.prompt_injection_neutralized ? 1 : 0),
              guardrail_blocked_commands_total:
                stats.guardrail_blocked_commands_total +
                (typeof data.blocked_command_count === "number" ? data.blocked_command_count : 0),
              dr_drills_total: stats.dr_drills_total + (data.dr_drill_passed === true ? 1 : 0),
              dr_drills_passed: stats.dr_drills_passed + (data.dr_drill_passed === true ? 1 : 0),
              category_breakdown: categoryBreakdown,
              severity_breakdown: severityBreakdown,
              last_incident_at: action.receivedAt,
            },
            samples,
          )
        : null;
      const chaosRun =
        state.chaosRun !== null
          ? {
              ...state.chaosRun,
              completed: Math.min(
                state.chaosRun.total,
                Math.max(state.chaosRun.completed, typeof data.index === "number" ? data.index : state.chaosRun.completed + 1),
              ),
              status: "streaming" as const,
            }
          : state.chaosRun;
      return {
        ...state,
        stats: nextStats,
        latencySamples: samples,
        incidents: upsertIncident(state.incidents, summary),
        incidentTotal: state.incidentTotal + (state.incidents.some((incident) => incident.incident_id === summary.incident_id) ? 0 : 1),
        lastEventId: envelope.id ?? state.lastEventId,
        chaosRun,
        events: appendEvent(
          state.events,
          eventEntry(
            envelope,
            action.receivedAt,
            `Triaged ${summary.incident_id} · ${titleCase(summary.diagnosed_category)}`,
            `${formatPercent(summary.confidence)} confidence · ${formatLatency(summary.triage_latency_ms)} · ${summary.cited_runbook_id}`,
            summary.severity === "critical" ? "critical" : "warning",
          ),
        ),
      };
    }

    case "SSE_DR_EVENT": {
      const envelope = action.envelope;
      const data = envelope.data;
      if (!isSseDrEventData(data)) {
        return {
          ...state,
          events: appendEvent(
            state.events,
            eventEntry(envelope, action.receivedAt, "Contract violation", "Dropped malformed DR drill payload", "critical"),
          ),
        };
      }
      const passed = data.foreign_key_check_passed === true;
      const isFailureEvent = envelope.event === "dr.drill.failed";
      const rtoSamples =
        passed && typeof data.rto_ms === "number" ? [...state.rtoSamples, data.rto_ms] : state.rtoSamples;
      const meanRto =
        rtoSamples.length === 0 ? (state.stats?.mean_rto_ms ?? 0) : round3(rtoSamples.reduce((sum, value) => sum + value, 0) / rtoSamples.length);
      const stats =
        state.stats === null
          ? null
          : {
              ...state.stats,
              dr_drills_total: state.stats.dr_drills_total + 1,
              dr_drills_passed: state.stats.dr_drills_passed + (passed && !isFailureEvent ? 1 : 0),
              mean_rto_ms: meanRto,
            };
      const verification: DrVerificationRow | null =
        passed && typeof data.snapshot_id === "string" && typeof data.sha256_digest === "string" && typeof data.rto_ms === "number"
          ? {
              snapshot_id: data.snapshot_id,
              incident_id: data.incident_id ?? null,
              sha256_digest: data.sha256_digest,
              tables_restored: typeof data.tables_restored === "number" ? data.tables_restored : 0,
              rows_verified: typeof data.rows_verified === "number" ? data.rows_verified : 0,
              foreign_key_check_passed: true,
              rto_ms: data.rto_ms,
              created_at: action.receivedAt,
            }
          : null;
      const drResult: DrRestoreResult | null =
        verification &&
        isDrRestoreResult({
          snapshot_id: verification.snapshot_id,
          sha256_digest: verification.sha256_digest,
          tables_restored: verification.tables_restored,
          rows_verified: verification.rows_verified,
          foreign_key_check_passed: verification.foreign_key_check_passed,
          rto_ms: verification.rto_ms,
          rpo_seconds: typeof data.rpo_seconds === "number" ? data.rpo_seconds : 0,
          incident_id: verification.incident_id,
        })
          ? {
              snapshot_id: verification.snapshot_id,
              sha256_digest: verification.sha256_digest,
              tables_restored: verification.tables_restored,
              rows_verified: verification.rows_verified,
              foreign_key_check_passed: verification.foreign_key_check_passed,
              rto_ms: verification.rto_ms,
              rpo_seconds: typeof data.rpo_seconds === "number" ? data.rpo_seconds : 0,
              incident_id: verification.incident_id,
            }
          : null;
      return {
        ...state,
        stats,
        rtoSamples,
        drVerifications: verification ? [verification, ...state.drVerifications] : state.drVerifications,
        drDrill:
          drResult !== null
            ? { ...state.drDrill, status: "success", result: drResult, error: null }
            : isFailureEvent
              ? { ...state.drDrill, status: "error", error: typeof data.error === "string" ? data.error : "DR drill failed" }
              : state.drDrill,
        lastEventId: envelope.id ?? state.lastEventId,
        events: appendEvent(
          state.events,
          eventEntry(
            envelope,
            action.receivedAt,
            passed ? "Cryptographic DR drill verified" : "DR drill failed",
            passed
              ? `SHA-256 ${data.sha256_digest ?? "—"} · FK check passed · RTO ${formatLatency(data.rto_ms ?? 0)}`
              : typeof data.error === "string"
                ? data.error
                : "Foreign-key integrity verification failed",
            passed ? "success" : "critical",
          ),
        ),
      };
    }

    case "SSE_CHAOS_EVENT": {
      const envelope = action.envelope;
      if (envelope.event === "chaos.run.started") {
        const scenarioId = typeof envelope.data.scenario_id === "string" ? envelope.data.scenario_id : state.chaosRun?.scenarioId ?? "all";
        const total = typeof envelope.data.total === "number" ? envelope.data.total : 0;
        return {
          ...state,
          chaosRun: {
            scenarioId,
            total,
            completed: 0,
            status: "streaming",
            startedAt: action.receivedAt,
            evaluation: null,
            message: `Injecting ${total} chaos scenarios`,
          },
          events: appendEvent(
            state.events,
            eventEntry(envelope, action.receivedAt, `Chaos run started · ${scenarioId}`, `${total} scenarios queued over SSE`, "info"),
          ),
        };
      }
      if (envelope.event === "chaos.run.completed") {
        const data = envelope.data as SseChaosCompletedData;
        const evaluation = isChaosEvaluation(data) ? (data as unknown as ChaosEvaluation) : null;
        return {
          ...state,
          chaosRun: state.chaosRun
            ? { ...state.chaosRun, status: "complete", completed: state.chaosRun.total, evaluation }
            : null,
          events: appendEvent(
            state.events,
            eventEntry(
              envelope,
              action.receivedAt,
              "Chaos run completed",
              evaluation
                ? `${evaluation.correct_category}/${evaluation.total} correct · ${formatPercent(evaluation.accuracy)} accuracy · ${evaluation.adversarial_intercepted}/${evaluation.adversarial_total} injections blocked`
                : "Evaluation payload unavailable",
              "success",
            ),
          ),
        };
      }
      if (envelope.event === "error") {
        return {
          ...state,
          chaosRun: state.chaosRun ? { ...state.chaosRun, status: "error", message: "Chaos stream error" } : null,
          error: typeof envelope.data.detail === "string" ? envelope.data.detail : "Chaos stream failed",
        };
      }
      return state;
    }

    case "CHAOS_INJECTION_STARTED": {
      const total = action.total ?? 1;
      return {
        ...state,
        chaosRun: {
          scenarioId: action.scenarioId,
          total,
          completed: 0,
          status: "running",
          startedAt: action.startedAt ?? "",
          evaluation: null,
          message: action.scenarioId === "all" ? `Injecting all ${total} scenarios` : `Injecting ${action.scenarioId}`,
        },
      };
    }

    case "CHAOS_PROGRESS":
      if (!state.chaosRun) {
        return state;
      }
      return {
        ...state,
        chaosRun: {
          ...state.chaosRun,
          completed: Math.min(action.total, Math.max(0, action.completed)),
          total: action.total,
          status: "streaming",
        },
      };

    case "CHAOS_COMPLETED": {
      if (!state.chaosRun) {
        return state;
      }
      return {
        ...state,
        chaosRun: {
          ...state.chaosRun,
          completed: state.chaosRun.total,
          status: "complete",
          evaluation: action.evaluation,
        },
      };
    }

    case "CHAOS_FAILED":
      return {
        ...state,
        chaosRun: state.chaosRun ? { ...state.chaosRun, status: "error", message: action.message } : null,
        error: action.message,
      };

    case "DR_DRILL_STARTED":
      return {
        ...state,
        drDrill: {
          status: "running",
          incidentId: action.incidentId ?? state.selectedIncidentId,
          startedAt: action.startedAt ?? "",
          result: null,
          error: null,
        },
      };

    case "DR_DRILL_COMPLETED": {
      const verification: DrVerificationRow = {
        snapshot_id: action.result.snapshot_id,
        incident_id: action.result.incident_id ?? null,
        sha256_digest: action.result.sha256_digest,
        tables_restored: action.result.tables_restored,
        rows_verified: action.result.rows_verified,
        foreign_key_check_passed: action.result.foreign_key_check_passed,
        rto_ms: action.result.rto_ms,
        created_at: action.receivedAt ?? "",
      };
      return {
        ...state,
        drDrill: {
          status: action.result.foreign_key_check_passed ? "success" : "error",
          incidentId: action.result.incident_id ?? state.drDrill.incidentId,
          startedAt: state.drDrill.startedAt,
          result: action.result,
          error: action.result.foreign_key_check_passed ? null : "foreign_key_check failed",
        },
        drVerifications: [verification, ...state.drVerifications],
      };
    }

    case "DR_DRILL_FAILED":
      return {
        ...state,
        drDrill: { ...state.drDrill, status: "error", error: action.error },
        error: action.error,
      };

    case "FILTER_CHANGED":
      return { ...state, filters: { ...state.filters, ...action.patch } };

    case "SEARCH_CHANGED":
      return { ...state, filters: { ...state.filters, search: action.search } };

    case "OFFLINE_MODE_CHANGED":
      return { ...state, offline: action.offline };

    case "ERROR":
      return { ...state, error: action.error };

    case "RESET":
      return action.state ?? createInitialConsoleState();

    default:
      return state;
  }
}

/* --------------------------------------------------------------------------------------------- */
/* SSE routing                                                                                    */
/* --------------------------------------------------------------------------------------------- */

/**
 * Map a raw SSE envelope to the appropriate reducer action. Returning `null` means the event is
 * informational only (e.g. heartbeats) and should not touch state.
 */
export function sseEnvelopeToAction(envelope: SseEventEnvelope, receivedAt: string): ConsoleAction | null {
  switch (envelope.event) {
    case "incident.triaged":
      return { type: "SSE_TRIAGE_EVENT", envelope, receivedAt };
    case "dr.drill.completed":
    case "dr.drill.failed":
      return { type: "SSE_DR_EVENT", envelope, receivedAt };
    case "chaos.run.started":
    case "chaos.run.completed":
      return { type: "SSE_CHAOS_EVENT", envelope, receivedAt };
    case "error":
      return { type: "SSE_CHAOS_EVENT", envelope, receivedAt };
    default:
      return null;
  }
}

/** Apply one SSE envelope to state (convenience for tests and the dashboard stream manager). */
export function applySseEnvelope(state: ConsoleState, envelope: SseEventEnvelope, receivedAt: string): ConsoleState {
  const action = sseEnvelopeToAction(envelope, receivedAt);
  return action === null ? state : consoleReducer(state, action);
}

/* --------------------------------------------------------------------------------------------- */
/* Selectors                                                                                      */
/* --------------------------------------------------------------------------------------------- */

export function selectFilteredIncidents(state: ConsoleState): IncidentSummary[] {
  const { category, severity, search, onlyAdversarial, onlyWithDr } = state.filters;
  const needle = search.trim().toLowerCase();
  return state.incidents.filter((incident) => {
    if (category !== "all" && incident.diagnosed_category !== category) {
      return false;
    }
    if (severity !== "all" && incident.severity !== severity) {
      return false;
    }
    if (onlyAdversarial && !incident.prompt_injection_neutralized) {
      return false;
    }
    if (onlyWithDr && incident.dr_drills_passed === 0) {
      return false;
    }
    if (needle.length === 0) {
      return true;
    }
    const haystack = [
      incident.incident_id,
      incident.alert_name,
      incident.service,
      incident.diagnosed_category,
      incident.cited_runbook_id,
      incident.root_cause_summary,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export interface KpiCard {
  id: string;
  label: string;
  value: string;
  hint: string;
  tone: "critical" | "warning" | "info" | "success" | "neutral";
  progress: number;
}

export function selectKpiCards(state: ConsoleState): KpiCard[] {
  return kpiCardsFromStats(state.stats);
}

/** Pure KPI projection shared by the header ribbon and snapshot tests. */
export function kpiCardsFromStats(stats: DashboardStats | null): KpiCard[] {
  if (!stats) {
    return [
      { id: "triaged", label: "Total Triaged", value: "—", hint: "awaiting telemetry", tone: "neutral", progress: 0 },
      { id: "accuracy", label: "Top-1 RRF Accuracy", value: "—", hint: "no labelled incidents", tone: "neutral", progress: 0 },
      { id: "injections", label: "Prompt Injections Blocked", value: "—", hint: "guardrail idle", tone: "neutral", progress: 0 },
      { id: "blocked", label: "Guardrail Rejections", value: "—", hint: "shlex policy engine", tone: "neutral", progress: 0 },
      { id: "dr", label: "Verified DR Drills", value: "—", hint: "cryptographic restore", tone: "neutral", progress: 0 },
      { id: "latency", label: "P50 / P95 Latency", value: "—", hint: "multi-agent triage", tone: "neutral", progress: 0 },
    ];
  }
  const accuracy = stats.accuracy !== null ? stats.accuracy : stats.mean_confidence;
  const drRatio = stats.dr_drills_total === 0 ? 0 : stats.dr_drills_passed / stats.dr_drills_total;
  return [
    {
      id: "triaged",
      label: "Total Triaged",
      value: String(stats.total_incidents_triaged),
      hint: `${stats.labeled_incidents} labelled · ${stats.correct_diagnoses} correct`,
      tone: "info",
      progress: Math.min(1, stats.total_incidents_triaged / 24),
    },
    {
      id: "accuracy",
      label: "Top-1 RRF Accuracy",
      value: formatPercent(accuracy),
      hint: `mean confidence ${formatPercent(stats.mean_confidence)}`,
      tone: accuracy >= 0.9 ? "success" : accuracy >= 0.75 ? "warning" : "critical",
      progress: accuracy,
    },
    {
      id: "injections",
      label: "Prompt Injections Blocked",
      value: String(stats.prompt_injections_neutralized),
      hint: "adversarial firewall",
      tone: stats.prompt_injections_neutralized > 0 ? "critical" : "success",
      progress: Math.min(1, stats.prompt_injections_neutralized / 6),
    },
    {
      id: "blocked",
      label: "Guardrail Rejections",
      value: String(stats.guardrail_blocked_commands_total),
      hint: "destructive commands stopped",
      tone: stats.guardrail_blocked_commands_total > 0 ? "warning" : "success",
      progress: Math.min(1, stats.guardrail_blocked_commands_total / 12),
    },
    {
      id: "dr",
      label: "Verified DR Drills",
      value: `${stats.dr_drills_passed} / ${stats.dr_drills_total}`,
      hint: `mean RTO ${formatLatency(stats.mean_rto_ms)}`,
      tone: drRatio === 1 && stats.dr_drills_total > 0 ? "success" : "warning",
      progress: drRatio,
    },
    {
      id: "latency",
      label: "P50 / P95 Latency",
      value: `${stats.p50_latency_ms.toFixed(1)} / ${stats.p95_latency_ms.toFixed(1)} ms`,
      hint: `mean ${formatLatency(stats.mean_latency_ms)}`,
      tone: stats.p95_latency_ms < 50 ? "success" : stats.p95_latency_ms < 250 ? "warning" : "critical",
      progress: Math.min(1, stats.p95_latency_ms / 250),
    },
  ];
}

export interface ChaosProgressView {
  percent: number;
  completed: number;
  total: number;
  status: ChaosRunState["status"];
  label: string;
}

export function selectChaosProgress(state: ConsoleState): ChaosProgressView {
  const run = state.chaosRun;
  if (!run) {
    return { percent: 0, completed: 0, total: 0, status: "complete", label: "idle" };
  }
  const percent = run.total === 0 ? 0 : Math.min(100, Math.round((run.completed / run.total) * 100));
  return {
    percent,
    completed: run.completed,
    total: run.total,
    status: run.status,
    label: `${run.completed}/${run.total} scenarios`,
  };
}

export function selectCategoryCounts(state: ConsoleState): Array<{ category: string; count: number }> {
  const breakdown = state.stats?.category_breakdown ?? {};
  return Object.entries(breakdown)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

export function selectAgentFindings(state: ConsoleState): AgentFinding[] {
  return state.selectedIncident?.agent_findings ?? [];
}

export function selectEventTicker(state: ConsoleState, limit = 12): ConsoleEventLogEntry[] {
  return state.events.slice(0, limit);
}

export function selectIsBusy(state: ConsoleState): boolean {
  return (
    state.drDrill.status === "running" ||
    state.chaosRun?.status === "running" ||
    state.chaosRun?.status === "streaming" ||
    state.status === "loading"
  );
}
