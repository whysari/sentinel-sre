/**
 * Sentinel-SRE — canonical TypeScript contracts for every JSON payload served by
 * `sentinel/api.py`.
 *
 * The backend is the source of truth. These interfaces intentionally mirror the Python
 * snake_case field names so that a payload can be rendered without an untestable mapping layer.
 * Every runtime boundary is additionally protected by a type guard exported from this module:
 * the React console never trusts `fetch()`/`EventSource` output blindly.
 */

/* --------------------------------------------------------------------------------------------- */
/* JSON primitives                                                                                */
/* --------------------------------------------------------------------------------------------- */

export type JsonPrimitive = string | number | boolean | null | undefined;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: unknown } | object;
export type JsonRecord = Record<string, any>;
export type StructuredMetrics = Record<string, any>;

/* --------------------------------------------------------------------------------------------- */
/* Domain enumerations                                                                            */
/* --------------------------------------------------------------------------------------------- */

export const INCIDENT_CATEGORIES = [
  "VxlanMtuMismatch",
  "PostgresConnectionExhaustion",
  "OOMKilled",
  "NodeDiskPressure",
  "CoreDnsFailure",
  "TlsCertExpiry",
  "ImagePullBackOff",
  "CrashLoopBackOff",
] as const;

export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

export const AGENT_NAMES = ["NetworkSdnAgent", "DatabaseStorageAgent", "ComputeRuntimeAgent"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const AGENT_LAYERS: Record<AgentName, string> = {
  NetworkSdnAgent: "L2/L3 SDN · VXLAN · DNS · TLS",
  DatabaseStorageAgent: "PostgreSQL locks · storage · kubelet",
  ComputeRuntimeAgent: "cgroup v2 · kubelet runtime · registry",
};

export type Severity = "critical" | "warning" | "info" | string;
export type IncidentSource = "api" | "chaos" | "demo" | string;

export const RUNBOOK_IDS = [
  "RB-001",
  "RB-002",
  "RB-003",
  "RB-004",
  "RB-005",
  "RB-006",
  "RB-007",
  "RB-008",
] as const;

export type RunbookId = (typeof RUNBOOK_IDS)[number];

export const CATEGORY_RUNBOOK: Record<IncidentCategory, RunbookId> = {
  VxlanMtuMismatch: "RB-004",
  PostgresConnectionExhaustion: "RB-005",
  OOMKilled: "RB-002",
  NodeDiskPressure: "RB-003",
  CoreDnsFailure: "RB-006",
  TlsCertExpiry: "RB-007",
  ImagePullBackOff: "RB-008",
  CrashLoopBackOff: "RB-001",
};

/* --------------------------------------------------------------------------------------------- */
/* Health & executive statistics                                                                  */
/* --------------------------------------------------------------------------------------------- */

export interface DatabaseTableCounts {
  incidents: number;
  dr_verifications: number;
  guardrail_audit_log: number;
  [table: string]: number;
}

export interface DatabaseHealth {
  backend: string;
  status: "ok" | "error" | string;
  journal_mode?: string;
  foreign_keys?: boolean;
  rows: Partial<DatabaseTableCounts>;
  error?: string;
}

export interface HealthResponse {
  status: "ok" | "degraded" | string;
  service: string;
  version: string;
  uptime_seconds: number;
  runbooks_indexed: number;
  sse_subscribers: number;
  database: DatabaseHealth;
}

/**
 * Aggregated KPI payload from `GET /api/v1/stats` (see `IncidentPersistenceStore.get_summary_stats`).
 * `accuracy` is `null` until at least one incident carries an `expected_category` label.
 */
export interface DashboardStats {
  total_incidents_triaged: number;
  mean_confidence: number;
  labeled_incidents: number;
  correct_diagnoses: number;
  accuracy: number | null;
  prompt_injections_neutralized: number;
  guardrail_blocked_commands_total: number;
  dr_drills_total: number;
  dr_drills_passed: number;
  mean_rto_ms: number;
  mean_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  category_breakdown: Record<string, number>;
  severity_breakdown: Record<string, number>;
  last_incident_at: string | null;
  runbooks_indexed: number;
  chaos_scenarios_available: number;
  generated_at: string;
}

/* --------------------------------------------------------------------------------------------- */
/* Multi-agent findings                                                                           */
/* --------------------------------------------------------------------------------------------- */

export interface AgentFinding {
  agent_name: AgentName | string;
  layer: string;
  anomaly_detected: boolean;
  primary_category: IncidentCategory | "Healthy" | string;
  severity_score: number;
  evidence: string[];
  diagnostic_commands: string[];
  structured_metrics: StructuredMetrics;
}

/* --------------------------------------------------------------------------------------------- */
/* PostgreSQL Wait-For Graph                                                                      */
/* --------------------------------------------------------------------------------------------- */

/** A single `pg_stat_activity` backend enriched with its `pg_locks` blocker list. */
export interface PgSessionNode {
  pid: number;
  usename: string;
  application_name: string;
  state: string;
  wait_event_type: string | null;
  wait_event: string | null;
  blocking_pids: number[];
  query: string;
  xact_duration_sec: number;
  lock_mode: string;
  /** Set by the API when the session participates in a circular deadlock. */
  is_cycle_member?: boolean;
  /** Set by the API when the session is a head-of-line blocker. */
  is_root_blocker?: boolean;
  /** Transitive number of sessions waiting behind this blocker. */
  blocked_count?: number;
}

/** Directed `waiter_pid -> blocker_pid` edge derived from `pg_locks`. */
export interface WaitForGraphEdge {
  waiter_pid: number;
  blocker_pid: number;
  waiter_application?: string | null;
  blocker_application?: string | null;
  lock_mode?: string | null;
  wait_event?: string | null;
  wait_event_type?: string | null;
}

export interface RootBlockerRef {
  pid: number;
  blocked_count: number;
  state: string;
  lock_mode: string;
  xact_duration_sec: number;
  query: string;
  application_name: string;
  /** 1-based presentation rank injected by the frontend layout engine. */
  rank?: number;
}

/**
 * Full Wait-For Graph payload served inside an incident detail response. `nodes`, `edges`,
 * `deadlock_cycles` and `root_blockers` are materialised by `_build_wait_for_graph()` at triage
 * time and persisted with the report. The summary keys are retained for backwards compatibility
 * with the original API contract.
 */
export interface WaitForGraphPayload {
  nodes: PgSessionNode[];
  edges: WaitForGraphEdge[];
  /** Each cycle repeats its first PID at the end, e.g. `[4101, 4102, 4101]`. */
  deadlock_cycles: number[][];
  root_blockers: RootBlockerRef[];
  deadlock_cycles_found: number;
  root_blocker_pids: number[];
  pg_connection_ratio: number;
  lock_evidence: string[];
  source?: string;
}

/* --------------------------------------------------------------------------------------------- */
/* DR drills & guardrail audit                                                                    */
/* --------------------------------------------------------------------------------------------- */

export interface DrRestoreResult {
  snapshot_id: string;
  sha256_digest: string;
  tables_restored: number;
  rows_verified: number;
  foreign_key_check_passed: boolean;
  rto_ms: number;
  rpo_seconds: number;
  /** Present on `POST /api/v1/dr/drill` when the drill was linked to an incident. */
  incident_id?: string | null;
}

export interface DrVerificationRow {
  snapshot_id: string;
  incident_id: string | null;
  sha256_digest: string;
  tables_restored: number;
  rows_verified: number;
  foreign_key_check_passed: boolean;
  rto_ms: number;
  created_at: string;
}

export interface DrVerificationsResponse {
  count: number;
  verifications: DrVerificationRow[];
}

export interface GuardrailAuditEntry {
  id: number;
  incident_id: string;
  blocked_command: string | null;
  injection_detected: boolean;
  created_at: string;
}

/* --------------------------------------------------------------------------------------------- */
/* Incidents                                                                                      */
/* --------------------------------------------------------------------------------------------- */

/** Row shape returned by `GET /api/v1/incidents`. */
export interface IncidentSummary {
  incident_id: string;
  alert_name: string;
  severity: Severity;
  namespace: string;
  service: string;
  diagnosed_category: IncidentCategory | string;
  confidence: number;
  cited_runbook_id: RunbookId | string;
  root_cause_summary: string;
  prompt_injection_neutralized: boolean;
  triage_latency_ms: number;
  expected_category: string | null;
  created_at: string;
  dr_drills_passed: number;
}

export interface IncidentsListResponse {
  total: number;
  count: number;
  limit: number;
  offset: number;
  incidents: IncidentSummary[];
}

/** Canonical `IncidentDiagnosisReport` persisted by the Python coordinator. */
export interface IncidentDiagnosisCore {
  incident_id: string;
  alert_name: string;
  diagnosed_category: IncidentCategory | string;
  confidence: number;
  cited_runbook_id: RunbookId | string;
  cited_runbook_title: string;
  root_cause_summary: string;
  agent_findings: AgentFinding[];
  approved_readonly_commands: string[];
  blocked_unsafe_commands: string[];
  prompt_injection_neutralized: boolean;
  dr_drill_result: DrRestoreResult | null;
  triage_latency_ms: number;
}

/**
 * `GET /api/v1/incidents/{incident_id}` — the persisted report plus environment metadata,
 * DR verification history, the guardrail audit trail and the materialised Wait-For Graph.
 */
export interface IncidentDetailResponse extends IncidentDiagnosisCore {
  severity: Severity;
  namespace: string;
  service: string;
  expected_category: string | null;
  created_at: string;
  wait_for_graph: WaitForGraphPayload;
  dr_verifications?: DrVerificationRow[];
  guardrail_audit_log?: GuardrailAuditEntry[];
  /** Present on chaos reports (POST /api/v1/chaos/inject/{id}). */
  expected_runbook_id?: string;
  is_adversarial?: boolean;
  diagnosis_correct?: boolean;
  runbook_correct?: boolean;
  adversarial_intercepted?: boolean | null;
}

/* --------------------------------------------------------------------------------------------- */
/* Chaos engine                                                                                   */
/* --------------------------------------------------------------------------------------------- */

export interface ChaosScenarioSummary {
  scenario_id: string;
  alert_name: string;
  severity: Severity;
  service: string;
  summary: string;
  expected_category: IncidentCategory | string;
  expected_runbook_id: RunbookId | string;
  is_adversarial: boolean;
}

export interface ChaosCatalogResponse {
  count: number;
  scenarios: ChaosScenarioSummary[];
}

export interface ChaosEvaluation {
  total: number;
  correct_category: number;
  correct_runbook: number;
  accuracy: number;
  runbook_recall_at_1: number;
  adversarial_total: number;
  adversarial_intercepted: number;
  dr_drills_passed: number;
}

/** Chaos report = full incident detail plus benchmark ground-truth annotations. */
export interface ChaosReport extends IncidentDetailResponse {
  expected_category: string;
  expected_runbook_id: string;
  is_adversarial: boolean;
  diagnosis_correct: boolean;
  runbook_correct: boolean;
  adversarial_intercepted: boolean | null;
}

export interface ChaosInjectResponse {
  scenario_id: string;
  count: number;
  evaluation: ChaosEvaluation;
  reports: ChaosReport[];
}

/* --------------------------------------------------------------------------------------------- */
/* Server-Sent Events                                                                             */
/* --------------------------------------------------------------------------------------------- */

export interface SseEventEnvelope<TData = JsonRecord> {
  id: string | null;
  event: string;
  data: TData;
  retry_ms: number | null;
}

export interface SseTriageEventData {
  source?: IncidentSource;
  incident_id: string;
  alert_name: string;
  severity?: Severity;
  service?: string;
  diagnosed_category: string;
  confidence: number;
  cited_runbook_id: string;
  prompt_injection_neutralized?: boolean;
  blocked_command_count?: number;
  dr_drill_passed?: boolean | null;
  triage_latency_ms: number;
  /** Chaos streams wrap a full report instead of the flattened triage summary. */
  report?: ChaosReport;
  index?: number;
  total?: number;
}

export interface SseDrEventData {
  snapshot_id?: string;
  incident_id?: string | null;
  sha256_digest?: string;
  tables_restored?: number;
  rows_verified?: number;
  foreign_key_check_passed?: boolean;
  rto_ms?: number;
  rpo_seconds?: number;
  error?: string;
}

export interface SseChaosStartedData {
  scenario_id: string;
  total: number;
}

export interface SseChaosCompletedData extends ChaosEvaluation {
  scenario_id: string;
}

export type SentinelSseEventName =
  | "incident.triaged"
  | "dr.drill.completed"
  | "dr.drill.failed"
  | "chaos.run.started"
  | "chaos.run.completed"
  | "error";

/* --------------------------------------------------------------------------------------------- */
/* Primitive runtime guards                                                                       */
/* --------------------------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => isNumber(item));
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((item) => isNumber(item));
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return isRecord(value);
}

/* --------------------------------------------------------------------------------------------- */
/* Public guards                                                                                  */
/* --------------------------------------------------------------------------------------------- */

export function isDatabaseHealth(value: unknown): value is DatabaseHealth {
  return (
    isRecord(value) &&
    isNonEmptyString(value.backend) &&
    isNonEmptyString(value.status) &&
    isRecord(value.rows) &&
    (value.error === undefined || isString(value.error))
  );
}

export function isHealthResponse(value: unknown): value is HealthResponse {
  return (
    isRecord(value) &&
    isNonEmptyString(value.status) &&
    isNonEmptyString(value.service) &&
    isNonEmptyString(value.version) &&
    isNumber(value.uptime_seconds) &&
    isNumber(value.runbooks_indexed) &&
    isNumber(value.sse_subscribers) &&
    isDatabaseHealth(value.database)
  );
}

export function isDashboardStats(value: unknown): value is DashboardStats {
  return (
    isRecord(value) &&
    isInteger(value.total_incidents_triaged) &&
    isNumber(value.mean_confidence) &&
    isInteger(value.labeled_incidents) &&
    isInteger(value.correct_diagnoses) &&
    (value.accuracy === null || isNumber(value.accuracy)) &&
    isInteger(value.prompt_injections_neutralized) &&
    isInteger(value.guardrail_blocked_commands_total) &&
    isInteger(value.dr_drills_total) &&
    isInteger(value.dr_drills_passed) &&
    isNumber(value.mean_rto_ms) &&
    isNumber(value.mean_latency_ms) &&
    isNumber(value.p50_latency_ms) &&
    isNumber(value.p95_latency_ms) &&
    isNumberRecord(value.category_breakdown) &&
    isNumberRecord(value.severity_breakdown) &&
    (value.last_incident_at === null || isString(value.last_incident_at)) &&
    isInteger(value.runbooks_indexed) &&
    isInteger(value.chaos_scenarios_available) &&
    isNonEmptyString(value.generated_at)
  );
}

export function isAgentFinding(value: unknown): value is AgentFinding {
  return (
    isRecord(value) &&
    isNonEmptyString(value.agent_name) &&
    isString(value.layer) &&
    isBoolean(value.anomaly_detected) &&
    isNonEmptyString(value.primary_category) &&
    isNumber(value.severity_score) &&
    value.severity_score >= 0 &&
    value.severity_score <= 1 &&
    isStringArray(value.evidence) &&
    isStringArray(value.diagnostic_commands) &&
    isJsonRecord(value.structured_metrics)
  );
}

export function isPgSessionNode(value: unknown): value is PgSessionNode {
  return (
    isRecord(value) &&
    isInteger(value.pid) &&
    isString(value.usename) &&
    isString(value.application_name) &&
    isString(value.state) &&
    (value.wait_event_type === null || isString(value.wait_event_type)) &&
    (value.wait_event === null || isString(value.wait_event)) &&
    isNumberArray(value.blocking_pids) &&
    isString(value.query) &&
    isNumber(value.xact_duration_sec) &&
    isString(value.lock_mode) &&
    (value.is_cycle_member === undefined || isBoolean(value.is_cycle_member)) &&
    (value.is_root_blocker === undefined || isBoolean(value.is_root_blocker)) &&
    (value.blocked_count === undefined || isNumber(value.blocked_count))
  );
}

export function isWaitForGraphEdge(value: unknown): value is WaitForGraphEdge {
  return (
    isRecord(value) &&
    isInteger(value.waiter_pid) &&
    isInteger(value.blocker_pid) &&
    (value.lock_mode === undefined || value.lock_mode === null || isString(value.lock_mode)) &&
    (value.wait_event === undefined || value.wait_event === null || isString(value.wait_event))
  );
}

export function isRootBlockerRef(value: unknown): value is RootBlockerRef {
  return (
    isRecord(value) &&
    isInteger(value.pid) &&
    isNumber(value.blocked_count) &&
    isString(value.state) &&
    isString(value.lock_mode) &&
    isNumber(value.xact_duration_sec) &&
    isString(value.query) &&
    isString(value.application_name) &&
    (value.rank === undefined || isNumber(value.rank))
  );
}

export function isDeadlockCycles(value: unknown): value is number[][] {
  return Array.isArray(value) && value.every((cycle) => isNumberArray(cycle) && cycle.length >= 2);
}

export function isWaitForGraphPayload(value: unknown): value is WaitForGraphPayload {
  return (
    isRecord(value) &&
    Array.isArray(value.nodes) &&
    value.nodes.every(isPgSessionNode) &&
    Array.isArray(value.edges) &&
    value.edges.every(isWaitForGraphEdge) &&
    isDeadlockCycles(value.deadlock_cycles) &&
    Array.isArray(value.root_blockers) &&
    value.root_blockers.every(isRootBlockerRef) &&
    isInteger(value.deadlock_cycles_found) &&
    isNumberArray(value.root_blocker_pids) &&
    isNumber(value.pg_connection_ratio) &&
    isStringArray(value.lock_evidence)
  );
}

export function isDrRestoreResult(value: unknown): value is DrRestoreResult {
  return (
    isRecord(value) &&
    isNonEmptyString(value.snapshot_id) &&
    isString(value.sha256_digest) &&
    isInteger(value.tables_restored) &&
    isInteger(value.rows_verified) &&
    isBoolean(value.foreign_key_check_passed) &&
    isNumber(value.rto_ms) &&
    isInteger(value.rpo_seconds) &&
    (value.incident_id === undefined || value.incident_id === null || isString(value.incident_id))
  );
}

export function isDrVerificationRow(value: unknown): value is DrVerificationRow {
  return (
    isRecord(value) &&
    isNonEmptyString(value.snapshot_id) &&
    (value.incident_id === null || isString(value.incident_id)) &&
    isString(value.sha256_digest) &&
    isInteger(value.tables_restored) &&
    isInteger(value.rows_verified) &&
    isBoolean(value.foreign_key_check_passed) &&
    isNumber(value.rto_ms) &&
    isNonEmptyString(value.created_at)
  );
}

export function isDrVerificationsResponse(value: unknown): value is DrVerificationsResponse {
  return (
    isRecord(value) &&
    isInteger(value.count) &&
    Array.isArray(value.verifications) &&
    value.verifications.every(isDrVerificationRow)
  );
}

export function isGuardrailAuditEntry(value: unknown): value is GuardrailAuditEntry {
  return (
    isRecord(value) &&
    isInteger(value.id) &&
    isString(value.incident_id) &&
    (value.blocked_command === null || isString(value.blocked_command)) &&
    isBoolean(value.injection_detected) &&
    isString(value.created_at)
  );
}

export function isIncidentSummary(value: unknown): value is IncidentSummary {
  return (
    isRecord(value) &&
    isNonEmptyString(value.incident_id) &&
    isString(value.alert_name) &&
    isNonEmptyString(value.severity) &&
    isString(value.namespace) &&
    isString(value.service) &&
    isNonEmptyString(value.diagnosed_category) &&
    isNumber(value.confidence) &&
    isNonEmptyString(value.cited_runbook_id) &&
    isString(value.root_cause_summary) &&
    isBoolean(value.prompt_injection_neutralized) &&
    isNumber(value.triage_latency_ms) &&
    (value.expected_category === null || isString(value.expected_category)) &&
    isString(value.created_at) &&
    isNumber(value.dr_drills_passed)
  );
}

export function isIncidentsListResponse(value: unknown): value is IncidentsListResponse {
  return (
    isRecord(value) &&
    isInteger(value.total) &&
    isInteger(value.count) &&
    isInteger(value.limit) &&
    isInteger(value.offset) &&
    Array.isArray(value.incidents) &&
    value.incidents.every(isIncidentSummary)
  );
}

export function isIncidentDetailResponse(value: unknown): value is IncidentDetailResponse {
  return (
    isRecord(value) &&
    isNonEmptyString(value.incident_id) &&
    isString(value.alert_name) &&
    isNonEmptyString(value.diagnosed_category) &&
    isNumber(value.confidence) &&
    isNonEmptyString(value.cited_runbook_id) &&
    isString(value.cited_runbook_title) &&
    isString(value.root_cause_summary) &&
    Array.isArray(value.agent_findings) &&
    value.agent_findings.every(isAgentFinding) &&
    isStringArray(value.approved_readonly_commands) &&
    isStringArray(value.blocked_unsafe_commands) &&
    isBoolean(value.prompt_injection_neutralized) &&
    (value.dr_drill_result === null || isDrRestoreResult(value.dr_drill_result)) &&
    isNumber(value.triage_latency_ms) &&
    isNonEmptyString(value.severity) &&
    isString(value.namespace) &&
    isString(value.service) &&
    (value.expected_category === null || isString(value.expected_category)) &&
    isString(value.created_at) &&
    isWaitForGraphPayload(value.wait_for_graph) &&
    (value.dr_verifications === undefined ||
      (Array.isArray(value.dr_verifications) && value.dr_verifications.every(isDrVerificationRow))) &&
    (value.guardrail_audit_log === undefined ||
      (Array.isArray(value.guardrail_audit_log) && value.guardrail_audit_log.every(isGuardrailAuditEntry)))
  );
}

export function isChaosScenarioSummary(value: unknown): value is ChaosScenarioSummary {
  return (
    isRecord(value) &&
    isNonEmptyString(value.scenario_id) &&
    isString(value.alert_name) &&
    isNonEmptyString(value.severity) &&
    isString(value.service) &&
    isString(value.summary) &&
    isNonEmptyString(value.expected_category) &&
    isNonEmptyString(value.expected_runbook_id) &&
    isBoolean(value.is_adversarial)
  );
}

export function isChaosCatalogResponse(value: unknown): value is ChaosCatalogResponse {
  return (
    isRecord(value) &&
    isInteger(value.count) &&
    Array.isArray(value.scenarios) &&
    value.scenarios.every(isChaosScenarioSummary)
  );
}

export function isChaosEvaluation(value: unknown): value is ChaosEvaluation {
  return (
    isRecord(value) &&
    isInteger(value.total) &&
    isInteger(value.correct_category) &&
    isInteger(value.correct_runbook) &&
    isNumber(value.accuracy) &&
    isNumber(value.runbook_recall_at_1) &&
    isInteger(value.adversarial_total) &&
    isInteger(value.adversarial_intercepted) &&
    isInteger(value.dr_drills_passed)
  );
}

export function isChaosReport(value: unknown): value is ChaosReport {
  return (
    isIncidentDetailResponse(value) &&
    isNonEmptyString(value.expected_category) &&
    isNonEmptyString(value.expected_runbook_id) &&
    isBoolean(value.is_adversarial) &&
    isBoolean(value.diagnosis_correct) &&
    isBoolean(value.runbook_correct) &&
    (value.adversarial_intercepted === null || isBoolean(value.adversarial_intercepted))
  );
}

export function isChaosInjectResponse(value: unknown): value is ChaosInjectResponse {
  return (
    isRecord(value) &&
    isNonEmptyString(value.scenario_id) &&
    isInteger(value.count) &&
    isChaosEvaluation(value.evaluation) &&
    Array.isArray(value.reports) &&
    value.reports.every(isChaosReport)
  );
}

export function isSseEventEnvelope(value: unknown): value is SseEventEnvelope {
  return (
    isRecord(value) &&
    (value.id === null || isString(value.id)) &&
    isNonEmptyString(value.event) &&
    isJsonRecord(value.data) &&
    (value.retry_ms === null || isNumber(value.retry_ms))
  );
}

export function isSseTriageEventData(value: unknown): value is SseTriageEventData {
  if (!isRecord(value)) {
    return false;
  }
  // Chaos streams wrap the full report; normalise before validating the flat summary.
  if (isRecord(value.report)) {
    return (
      isIncidentDetailResponse(value.report) &&
      (value.index === undefined || isNumber(value.index)) &&
      (value.total === undefined || isNumber(value.total))
    );
  }
  return (
    isNonEmptyString(value.incident_id) &&
    isString(value.alert_name) &&
    isNonEmptyString(value.diagnosed_category) &&
    isNumber(value.confidence) &&
    isNonEmptyString(value.cited_runbook_id) &&
    isNumber(value.triage_latency_ms) &&
    (value.dr_drill_passed === undefined || value.dr_drill_passed === null || isBoolean(value.dr_drill_passed))
  );
}

export function isSseDrEventData(value: unknown): value is SseDrEventData {
  return (
    isRecord(value) &&
    (value.snapshot_id === undefined || isString(value.snapshot_id)) &&
    (value.incident_id === undefined || value.incident_id === null || isString(value.incident_id)) &&
    (value.sha256_digest === undefined || isString(value.sha256_digest)) &&
    (value.foreign_key_check_passed === undefined || isBoolean(value.foreign_key_check_passed)) &&
    (value.rto_ms === undefined || isNumber(value.rto_ms)) &&
    (value.error === undefined || isString(value.error))
  );
}

/* --------------------------------------------------------------------------------------------- */
/* Small normalisation helpers used by the API client & reducer                                   */
/* --------------------------------------------------------------------------------------------- */

export function isKnownCategory(value: string): value is IncidentCategory {
  return (INCIDENT_CATEGORIES as readonly string[]).includes(value);
}

export function isKnownRunbook(value: string): value is RunbookId {
  return (RUNBOOK_IDS as readonly string[]).includes(value);
}

export function isAgentName(value: string): value is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(value);
}

/** Narrow an unknown SSE payload without throwing, surfacing a readable error instead. */
export function parseSseEnvelopeOrThrow(value: unknown): SseEventEnvelope {
  if (!isSseEventEnvelope(value)) {
    throw new TypeError("Malformed SSE envelope: expected { id, event, data, retry_ms }");
  }
  return value;
}

/** Safe count for guarded arrays; used by reducers that consume partially-typed events. */
export function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
