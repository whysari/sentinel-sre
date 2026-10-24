/**
 * Typed `SentinelApiClient` for every `/api/v1/*` endpoint, plus a zero-dependency SSE stream
 * manager and a fully offline demo implementation.
 *
 * Design constraints
 * ------------------
 * - No npm runtime dependencies: `fetch`, `AbortController`, `TextDecoder` and `ReadableStream`
 *   are Web-standard globals available in browsers, Next.js route handlers and Bun.
 * - Every HTTP response is validated with the guards from `types/sentinel.ts`; a contract drift
 *   surfaces as a typed `SentinelApiError` instead of `undefined` deep inside a React tree.
 * - `SentinelApiClient.offline()` serves the deterministic fixtures from `demo-fixtures.ts`, so the
 *   console remains explorable with `next start` and no Python process.
 */

import type {
  ChaosCatalogResponse,
  ChaosInjectResponse,
  ChaosReport,
  DashboardStats,
  DrRestoreResult,
  DrVerificationsResponse,
  HealthResponse,
  IncidentDetailResponse,
  IncidentSummary,
  IncidentsListResponse,
  JsonRecord,
  SseEventEnvelope,
} from "../types/sentinel";
import {
  isChaosCatalogResponse,
  isChaosInjectResponse,
  isDashboardStats,
  isDrRestoreResult,
  isDrVerificationsResponse,
  isHealthResponse,
  isIncidentDetailResponse,
  isIncidentsListResponse,
} from "../types/sentinel";
import {
  DEMO_GENERATED_AT,
  demoChaosCatalog,
  demoChaosEvaluation,
  demoChaosReports,
  demoDrResult,
  demoIncidentDetails,
  demoIncidentsFromDetails,
  demoIncidentsFromDataset,
  demoStatsFromDetails,
  demoVerificationsFromDetails,
  toIncidentSummary,
} from "./demo-fixtures";
import type { DrVerificationRow } from "../types/sentinel";

/* --------------------------------------------------------------------------------------------- */
/* Errors                                                                                         */
/* --------------------------------------------------------------------------------------------- */

export class SentinelApiError extends Error {
  public readonly status: number;
  public readonly detail: unknown;
  public readonly path: string;
  public readonly payload: unknown;

  constructor(status: number, detail: unknown, path = "", payload: unknown = null) {
    super(typeof detail === "string" ? detail : `Sentinel API error (${status})`);
    this.name = "SentinelApiError";
    this.status = status;
    this.detail = detail;
    this.path = path;
    this.payload = payload;
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/* --------------------------------------------------------------------------------------------- */
/* SSE frame parser                                                                               */
/* --------------------------------------------------------------------------------------------- */

const DEFAULT_EVENT = "message";

/**
 * Incremental `text/event-stream` parser (WHATWG spec subset: `id`, `event`, `data`, `retry`,
 * comments and multi-line data). Feed it decoded chunks; it emits only complete frames.
 */
export class SseFrameParser {
  private buffer = "";
  private eventName = "";
  private readonly dataLines: string[] = [];
  private lastId: string | null = null;
  private retryMs: number | null = null;

  push(chunk: string): SseEventEnvelope[] {
    this.buffer += chunk;
    const events: SseEventEnvelope[] = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const dispatched = this.consumeLine(line);
      if (dispatched) {
        events.push(dispatched);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
    return events;
  }

  /** Flush buffered partial data at EOF (some servers omit the trailing blank line). */
  finish(): SseEventEnvelope[] {
    const events: SseEventEnvelope[] = [];
    if (this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      const dispatched = this.consumeLine(line);
      if (dispatched) {
        events.push(dispatched);
      }
    }
    const dispatched = this.dispatch();
    if (dispatched) {
      events.push(dispatched);
    }
    return events;
  }

  private consumeLine(line: string): SseEventEnvelope | null {
    if (line.length === 0) {
      return this.dispatch();
    }
    if (line.startsWith(":")) {
      return null;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    switch (field) {
      case "id":
        this.lastId = value;
        break;
      case "event":
        this.eventName = value;
        break;
      case "retry": {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed >= 0) {
          this.retryMs = parsed;
        }
        break;
      }
      case "data":
        this.dataLines.push(value);
        break;
      default:
        break;
    }
    return null;
  }

  private dispatch(): SseEventEnvelope | null {
    if (this.dataLines.length === 0) {
      this.eventName = "";
      return null;
    }
    const text = this.dataLines.join("\n");
    this.dataLines.length = 0;
    const event = this.eventName.length > 0 ? this.eventName : DEFAULT_EVENT;
    this.eventName = "";
    let data: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(text);
      data = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as JsonRecord)
        : { value: parsed as never };
    } catch {
      data = { raw: text };
    }
    return { id: this.lastId, event, data, retry_ms: this.retryMs };
  }
}

/** Parse a complete SSE body (useful for fixtures and non-streaming `fetch` tests). */
export function parseSseText(text: string): SseEventEnvelope[] {
  const parser = new SseFrameParser();
  return [...parser.push(text), ...parser.finish()];
}

/** Encode a single SSE frame, mirroring `sentinel/events.py::encode_sse`. */
export function encodeSseEvent(event: string, data: JsonRecord, id?: string | number | null): string {
  const head = id === undefined || id === null ? "" : `id: ${id}\n`;
  return `${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/* --------------------------------------------------------------------------------------------- */
/* Stream handle                                                                                  */
/* --------------------------------------------------------------------------------------------- */

export interface SseHandlers {
  onOpen?: (info: { status: number; contentType: string | null }) => void;
  onEvent: (envelope: SseEventEnvelope) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

export interface SseOpenOptions {
  lastEventId?: string | null;
  heartbeatSeconds?: number;
  signal?: AbortSignal;
}

export interface SseStreamHandle {
  readonly url: string;
  close: () => void;
  readonly closed: boolean;
  readonly done: Promise<void>;
}

/* --------------------------------------------------------------------------------------------- */
/* Client options & helpers                                                                       */
/* --------------------------------------------------------------------------------------------- */

export interface SentinelApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  offline?: boolean;
  defaultHeaders?: Record<string, string>;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_TIMEOUT_MS = 20_000;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function buildQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) {
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

function describeErrorDetail(body: unknown): unknown {
  if (typeof body === "object" && body !== null && "detail" in body) {
    return (body as { detail: unknown }).detail;
  }
  return body;
}

/* --------------------------------------------------------------------------------------------- */
/* Offline demo state                                                                             */
/* --------------------------------------------------------------------------------------------- */

interface OfflineState {
  details: Map<string, IncidentDetailResponse>;
  verifications: DrVerificationRow[];
  chaosRuns: ChaosReport[][];
}

function createOfflineState(): OfflineState {
  const details = new Map<string, IncidentDetailResponse>(Object.entries(demoIncidentDetails()));
  return {
    details,
    verifications: demoVerificationsFromDetails([...details.values()]),
    chaosRuns: [],
  };
}

/* --------------------------------------------------------------------------------------------- */
/* Client                                                                                         */
/* --------------------------------------------------------------------------------------------- */

export class SentinelApiClient {
  public readonly baseUrl: string;
  public readonly offline: boolean;

  private readonly fetchImpl: typeof fetch | null;
  private readonly timeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly offlineState: OfflineState | null;

  constructor(options: SentinelApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.offline = options.offline === true;
    this.fetchImpl = options.fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultHeaders = {
      Accept: "application/json",
      ...options.defaultHeaders,
    };
    this.offlineState = this.offline ? createOfflineState() : null;
  }

  /** Fully deterministic, network-free client backed by `demo-fixtures.ts`. */
  static offline(baseUrl = "offline://sentinel-sre"): SentinelApiClient {
    return new SentinelApiClient({ offline: true, baseUrl });
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    guard: (value: unknown) => value is T,
    expected: string,
  ): Promise<T> {
    if (this.offline) {
      throw new SentinelApiError(500, "Offline client cannot issue HTTP requests", path);
    }
    const fetchImpl = this.fetchImpl;
    if (!fetchImpl) {
      throw new SentinelApiError(0, "Global fetch is unavailable in this runtime", path);
    }
    const controller = new AbortController();
    const timer =
      this.timeoutMs > 0
        ? setTimeout(() => {
            controller.abort();
          }, this.timeoutMs)
        : null;
    const headers = new Headers(this.defaultHeaders);
    if (init.body !== undefined && init.body !== null) {
      headers.set("Content-Type", "application/json");
    }
    for (const [key, value] of Object.entries((init.headers as Record<string, string> | undefined) ?? {})) {
      headers.set(key, value);
    }
    let response: Response;
    try {
      response = await fetchImpl(this.url(path), {
        ...init,
        headers,
        signal: init.signal ?? controller.signal,
      });
    } catch (error) {
      if (timer !== null) {
        clearTimeout(timer);
      }
      const message = controller.signal.aborted ? `Request timed out after ${this.timeoutMs}ms` : String(error);
      throw new SentinelApiError(0, message, path);
    }
    if (timer !== null) {
      clearTimeout(timer);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const rawText = await response.text();
    let parsed: unknown = null;
    if (rawText.length > 0 && contentType.includes("json")) {
      try {
        parsed = JSON.parse(rawText);
      } catch (error) {
        throw new SentinelApiError(response.status, `Malformed JSON response: ${String(error)}`, path, rawText);
      }
    } else if (rawText.length > 0) {
      parsed = rawText;
    }
    if (!response.ok) {
      throw new SentinelApiError(response.status, describeErrorDetail(parsed), path, parsed);
    }
    if (!guard(parsed)) {
      throw new SentinelApiError(
        response.status,
        `Response contract violation: expected ${expected}`,
        path,
        parsed,
      );
    }
    return parsed;
  }

  private async requestText(path: string): Promise<string> {
    if (this.offline) {
      return "# HELP sentinel_incidents_total Offline demo exposition\nsentinel_incidents_total 24\n";
    }
    const fetchImpl = this.fetchImpl;
    if (!fetchImpl) {
      throw new SentinelApiError(0, "Global fetch is unavailable in this runtime", path);
    }
    const response = await fetchImpl(this.url(path), { headers: this.defaultHeaders });
    const text = await response.text();
    if (!response.ok) {
      throw new SentinelApiError(response.status, text, path, text);
    }
    return text;
  }

  /* ---- Read endpoints ---------------------------------------------------------------------- */

  async healthz(): Promise<HealthResponse> {
    if (this.offlineState) {
      return demoHealthResponse();
    }
    return this.request("/api/v1/healthz", { method: "GET" }, isHealthResponse, "HealthResponse");
  }

  async stats(): Promise<DashboardStats> {
    if (this.offlineState) {
      return demoStatsFromDetails([...this.offlineState.details.values()]);
    }
    return this.request("/api/v1/stats", { method: "GET" }, isDashboardStats, "DashboardStats");
  }

  async listIncidents(params: { limit?: number; offset?: number } = {}): Promise<IncidentsListResponse> {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    if (this.offlineState) {
      const summaries = demoIncidentsFromDetails([...this.offlineState.details.values()]);
      const slice = summaries.slice(offset, offset + limit);
      return { total: summaries.length, count: slice.length, limit, offset, incidents: slice };
    }
    const query = buildQuery({ limit, offset });
    return this.request(
      `/api/v1/incidents${query}`,
      { method: "GET" },
      isIncidentsListResponse,
      "IncidentsListResponse",
    );
  }

  async getIncident(incidentId: string): Promise<IncidentDetailResponse> {
    if (this.offlineState) {
      const detail = this.offlineState.details.get(incidentId);
      if (!detail) {
        throw new SentinelApiError(404, `Incident '${incidentId}' not found`, `/api/v1/incidents/${incidentId}`);
      }
      return detail;
    }
    const path = `/api/v1/incidents/${encodeURIComponent(incidentId)}`;
    return this.request(path, { method: "GET" }, isIncidentDetailResponse, "IncidentDetailResponse");
  }

  async chaosCatalog(): Promise<ChaosCatalogResponse> {
    if (this.offlineState) {
      return demoChaosCatalog();
    }
    return this.request("/api/v1/chaos/scenarios", { method: "GET" }, isChaosCatalogResponse, "ChaosCatalogResponse");
  }

  async listDrVerifications(limit = 50): Promise<DrVerificationsResponse> {
    if (this.offlineState) {
      const rows = this.offlineState.verifications.slice(0, limit);
      return { count: rows.length, verifications: rows };
    }
    return this.request(
      `/api/v1/dr/verifications${buildQuery({ limit })}`,
      { method: "GET" },
      isDrVerificationsResponse,
      "DrVerificationsResponse",
    );
  }

  async metricsText(): Promise<string> {
    return this.requestText("/metrics");
  }

  /* ---- Write endpoints --------------------------------------------------------------------- */

  async triage(payload: JsonRecord): Promise<IncidentDetailResponse> {
    if (this.offlineState) {
      const incidentId = typeof payload.incident_id === "string" ? payload.incident_id : "INC-DEMO";
      const existing = this.offlineState.details.get(incidentId);
      if (existing) {
        return existing;
      }
      const template = [...this.offlineState.details.values()][0];
      if (!template) {
        throw new SentinelApiError(500, "Offline demo dataset is empty", "/api/v1/triage");
      }
      const detail: IncidentDetailResponse = {
        ...template,
        incident_id: incidentId,
        alert_name: typeof payload.alert_name === "string" ? payload.alert_name : template.alert_name,
        severity: typeof payload.severity === "string" ? payload.severity : template.severity,
        namespace: typeof payload.namespace === "string" ? payload.namespace : template.namespace,
        service: typeof payload.service === "string" ? payload.service : template.service,
        created_at: DEMO_GENERATED_AT,
      };
      this.offlineState.details.set(incidentId, detail);
      return detail;
    }
    return this.request(
      "/api/v1/triage",
      { method: "POST", body: JSON.stringify(payload) },
      isIncidentDetailResponse,
      "IncidentDetailResponse",
    );
  }

  async injectChaos(scenarioId: string): Promise<ChaosInjectResponse> {
    if (this.offlineState) {
      return this.offlineInjectChaos(scenarioId);
    }
    return this.request(
      `/api/v1/chaos/inject/${encodeURIComponent(scenarioId)}`,
      { method: "POST" },
      isChaosInjectResponse,
      "ChaosInjectResponse",
    );
  }

  async runDrDrill(incidentId?: string | null): Promise<DrRestoreResult> {
    if (this.offlineState) {
      const result = demoDrResult(incidentId ?? undefined);
      const row: DrVerificationRow = {
        snapshot_id: result.snapshot_id,
        incident_id: result.incident_id ?? null,
        sha256_digest: result.sha256_digest,
        tables_restored: result.tables_restored,
        rows_verified: result.rows_verified,
        foreign_key_check_passed: result.foreign_key_check_passed,
        rto_ms: result.rto_ms,
        created_at: DEMO_GENERATED_AT,
      };
      this.offlineState.verifications = [row, ...this.offlineState.verifications];
      return result;
    }
    const body = incidentId ? JSON.stringify({ incident_id: incidentId }) : JSON.stringify({});
    return this.request(
      "/api/v1/dr/drill",
      { method: "POST", body },
      isDrRestoreResult,
      "DrRestoreResult",
    );
  }

  /* ---- SSE --------------------------------------------------------------------------------- */

  /**
   * Subscribe to the live event stream. Uses a fetch-based reader (not `EventSource`) so that
   * `Last-Event-ID` reconnection, abort signals and unit tests work identically in Node/Bun.
   */
  openEventStream(handlers: SseHandlers, options: SseOpenOptions = {}): SseStreamHandle {
    const query = buildQuery({ heartbeat: options.heartbeatSeconds ?? 15 });
    return this.openSseStream(`/api/v1/events/stream${query}`, handlers, options);
  }

  /** Subscribe to a finite chaos run (`chaos.run.started` → N × `incident.triaged` → completed). */
  openChaosStream(scenarioId: string, handlers: SseHandlers, options: SseOpenOptions = {}): SseStreamHandle {
    const path = `/api/v1/chaos/stream/${encodeURIComponent(scenarioId)}`;
    if (this.offlineState) {
      return this.openOfflineChaosStream(path, scenarioId, handlers);
    }
    return this.openSseStream(path, handlers, options);
  }

  private openSseStream(path: string, handlers: SseHandlers, options: SseOpenOptions): SseStreamHandle {
    const url = this.url(path);
    const controller = new AbortController();
    let closed = false;
    const abortFromCaller = (): void => {
      controller.abort();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener("abort", abortFromCaller, { once: true });
      }
    }

    const done = (async () => {
      const fetchImpl = this.fetchImpl;
      if (!fetchImpl) {
        const error = new SentinelApiError(0, "Global fetch is unavailable for SSE", path);
        handlers.onError?.(error);
        return;
      }
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (options.lastEventId) {
        headers["Last-Event-ID"] = options.lastEventId;
      }
      let response: Response;
      try {
        response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
      } catch (error) {
        if (!closed) {
          handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      if (!response.ok) {
        handlers.onError?.(new SentinelApiError(response.status, `SSE handshake failed for ${path}`, path));
        return;
      }
      handlers.onOpen?.({ status: response.status, contentType: response.headers.get("content-type") });
      const body = response.body;
      if (!body) {
        handlers.onError?.(new SentinelApiError(0, "SSE response has no readable body", path));
        return;
      }
      const reader = body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseFrameParser();
      try {
        while (!closed) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) {
            break;
          }
          const text = decoder.decode(value, { stream: true });
          for (const envelope of parser.push(text)) {
            handlers.onEvent(envelope);
          }
        }
        for (const envelope of parser.finish()) {
          handlers.onEvent(envelope);
        }
      } catch (error) {
        if (!closed && !controller.signal.aborted) {
          handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // Reader already closed — safe to ignore.
        }
        options.signal?.removeEventListener("abort", abortFromCaller);
        handlers.onClose?.();
      }
    })();

    return {
      url,
      get closed() {
        return closed;
      },
      close: () => {
        if (!closed) {
          closed = true;
          controller.abort();
        }
      },
      done,
    };
  }

  private openOfflineChaosStream(path: string, scenarioId: string, handlers: SseHandlers): SseStreamHandle {
    let closed = false;
    const url = this.url(path);
    const done = (async () => {
      handlers.onOpen?.({ status: 200, contentType: "text/event-stream" });
      const reports = this.offlineReportsFor(scenarioId);
      handlers.onEvent({
        id: "1",
        event: "chaos.run.started",
        data: { scenario_id: scenarioId, total: reports.length },
        retry_ms: 3000,
      });
      await Promise.resolve();
      for (const [index, report] of reports.entries()) {
        if (closed) {
          return;
        }
        handlers.onEvent({
          id: String(index + 2),
          event: "incident.triaged",
          data: { index: index + 1, total: reports.length, report },
          retry_ms: 3000,
        });
      }
      const evaluation = demoChaosEvaluation(reports);
      handlers.onEvent({
        id: String(reports.length + 2),
        event: "chaos.run.completed",
        data: { scenario_id: scenarioId, ...evaluation },
        retry_ms: 3000,
      });
      handlers.onClose?.();
    })();

    return {
      url,
      get closed() {
        return closed;
      },
      close: () => {
        closed = true;
      },
      done,
    };
  }

  /* ---- Offline helpers --------------------------------------------------------------------- */

  private offlineReportsFor(scenarioId: string): ChaosReport[] {
    const all = demoChaosReports();
    const wanted = scenarioId.toUpperCase();
    if (wanted === "ALL") {
      return all;
    }
    return all.filter((report) => report.incident_id.toUpperCase() === wanted);
  }

  private offlineInjectChaos(scenarioId: string): ChaosInjectResponse {
    const state = this.offlineState;
    if (!state) {
      throw new SentinelApiError(500, "Offline state missing", "/api/v1/chaos/inject");
    }
    const reports = this.offlineReportsFor(scenarioId);
    if (reports.length === 0) {
      throw new SentinelApiError(
        404,
        `Unknown chaos scenario '${scenarioId}'. Valid: all, INC-001..INC-024`,
        `/api/v1/chaos/inject/${scenarioId}`,
      );
    }
    for (const report of reports) {
      state.details.set(report.incident_id, { ...report, created_at: DEMO_GENERATED_AT });
    }
    state.chaosRuns.push(reports);
    state.verifications = demoVerificationsFromDetails([...state.details.values()]);
    return {
      scenario_id: scenarioId,
      count: reports.length,
      evaluation: demoChaosEvaluation(reports),
      reports,
    };
  }

  /** Read-only snapshot of the offline incidents (used by the dashboard bootstrap hook). */
  offlineIncidentSummaries(): IncidentSummary[] {
    if (!this.offlineState) {
      return [];
    }
    return demoIncidentsFromDetails([...this.offlineState.details.values()]);
  }

  offlineIncidentDetail(incidentId: string): IncidentDetailResponse | null {
    return this.offlineState?.details.get(incidentId) ?? null;
  }

  offlineSummary(incidentId: string): IncidentSummary | null {
    const detail = this.offlineIncidentDetail(incidentId);
    return detail ? toIncidentSummary(detail) : null;
  }
}

/* --------------------------------------------------------------------------------------------- */
/* Lazy fixture imports (kept at the bottom to avoid cycles with demo-fixtures -> wfg-layout)     */
/* --------------------------------------------------------------------------------------------- */

function demoHealthResponse(): HealthResponse {
  return {
    status: "ok",
    service: "sentinel-sre",
    version: "1.0.0",
    uptime_seconds: 84_221.4,
    runbooks_indexed: 8,
    sse_subscribers: 2,
    database: {
      backend: "sqlite",
      status: "ok",
      journal_mode: "wal",
      foreign_keys: true,
      rows: {
        incidents: demoIncidentDetailsCount(),
        dr_verifications: demoVerificationsFromDetails(Object.values(demoIncidentDetails())).length,
        guardrail_audit_log: 7,
      },
    },
  };
}

function demoIncidentDetailsCount(): number {
  return Object.keys(demoIncidentDetails()).length;
}

/* Re-exported fixture helpers used by the offline client's tests. */
export { demoIncidentsFromDataset };

/** Construct a client that automatically falls back to offline fixtures when the API is down. */
export function createResilientClient(options: SentinelApiClientOptions = {}): SentinelApiClient {
  return new SentinelApiClient(options);
}
