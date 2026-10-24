/**
 * Sentinel-SRE console contract & behaviour suite.
 *
 * Runs with `bun test` from `frontend/` and requires **no npm install**:
 *  - `bun:test` provides the runner and assertions,
 *  - the Web-standard `fetch` / `ReadableStream` globals provide the transport,
 *  - `python3` (stdlib only) is spawned to serve the real WMGI API on an ephemeral port.
 *
 * Coverage map
 * ------------
 * 1. `types/sentinel.ts` guards validated against **real Python JSON** (never hand-written stubs).
 * 2. `lib/wfg-layout.ts` geometry for INC-004 (deadlock cycle) and INC-005 (head-of-line blocker).
 * 3. `lib/console-store.ts` reducer transitions for every action named in the brief, including
 *    `SSE_TRIAGE_EVENT` / `SSE_DR_EVENT` and chaos progress.
 * 4. `lib/api-client.ts` SSE parser, live chaos stream, offline fixture backend and error mapping.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ChaosInjectResponse,
  ChaosReport,
  DashboardStats,
  DrRestoreResult,
  HealthResponse,
  IncidentDetailResponse,
  IncidentSummary,
  IncidentsListResponse,
  JsonRecord,
  SseEventEnvelope,
  SseTriageEventData,
} from "../types/sentinel";
import {
  isChaosCatalogResponse,
  isChaosInjectResponse,
  isDashboardStats,
  isDrRestoreResult,
  isDrVerificationRow,
  isDrVerificationsResponse,
  isHealthResponse,
  isIncidentDetailResponse,
  isIncidentSummary,
  isIncidentsListResponse,
  isKnownCategory,
  isKnownRunbook,
  isSseEventEnvelope,
  isSseTriageEventData,
  isWaitForGraphPayload,
} from "../types/sentinel";
import {
  SentinelApiClient,
  SentinelApiError,
  SseFrameParser,
  encodeSseEvent,
  parseSseText,
} from "../lib/api-client";
import {
  EVENT_LOG_LIMIT,
  applySseEnvelope,
  consoleReducer,
  createInitialConsoleState,
  incidentSummaryFromDetail,
  kpiCardsFromStats,
  selectChaosProgress,
  selectFilteredIncidents,
  selectKpiCards,
  sseEnvelopeToAction,
  type ConsoleState,
} from "../lib/console-store";
import {
  buildBezierPath,
  buildWaitForGraph,
  describeWaitForGraph,
  detectDeadlockCycles,
  detectRootBlockers,
  layoutWaitForGraph,
  normalizeWaitForGraph,
  summarizeWaitForGraph,
} from "../lib/wfg-layout";
import { demoIncidentDetails, demoStats } from "../lib/demo-fixtures";

/* --------------------------------------------------------------------------------------------- */
/* Harness: ephemeral Python WSGI server                                                          */
/* --------------------------------------------------------------------------------------------- */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(TEST_DIR, "../..");
const PROJECT_ROOT = resolve(FRONTEND_ROOT, "..");

const SERVER_SOURCE = `
import io
import json
import sys
import threading
import socketserver

from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from sentinel.api import SentinelService, create_wsgi_app
from sentinel.store import IncidentPersistenceStore


def dispatch_wsgi(wsgi_app, req: dict) -> dict:
    method = str(req.get("method") or "GET").upper()
    path = str(req.get("path") or "/")
    query = str(req.get("query") or "")
    raw_body = req.get("body") or ""
    body_bytes = raw_body.encode("utf-8") if isinstance(raw_body, str) else b""
    headers = req.get("headers") or {}

    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "QUERY_STRING": query,
        "CONTENT_TYPE": headers.get("content-type", "application/json"),
        "CONTENT_LENGTH": str(len(body_bytes)),
        "SERVER_NAME": "127.0.0.1",
        "SERVER_PORT": "8000",
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(body_bytes),
        "wsgi.errors": sys.stderr,
        "wsgi.multithread": True,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
    }
    for k, v in headers.items():
        env_key = "HTTP_" + str(k).upper().replace("-", "_")
        environ[env_key] = str(v)

    status_holder = ["200 OK", []]

    def start_response(status, response_headers, exc_info=None):
        status_holder[0] = status
        status_holder[1] = list(response_headers)

    chunks = []
    result_iter = wsgi_app(environ, start_response)
    try:
        for chunk in result_iter:
            if isinstance(chunk, bytes):
                chunks.append(chunk)
            elif isinstance(chunk, str):
                chunks.append(chunk.encode("utf-8"))
    finally:
        if hasattr(result_iter, "close"):
            result_iter.close()

    status_code = int(str(status_holder[0]).split(" ", 1)[0])
    resp_headers = {str(k).lower(): str(v) for k, v in status_holder[1]}
    return {
        "id": req.get("id"),
        "status": status_code,
        "headers": resp_headers,
        "body": b"".join(chunks).decode("utf-8", errors="replace"),
    }


def main() -> None:
    database_path = sys.argv[1]
    store = IncidentPersistenceStore("sqlite:///" + database_path)
    service = SentinelService(store=store)
    wsgi_app = create_wsgi_app(service)

    port = 0
    try:
        class ThreadingWSGIServer(socketserver.ThreadingMixIn, WSGIServer):
            daemon_threads = True

        class QuietHandler(WSGIRequestHandler):
            def log_message(self, fmt, *args):  # noqa: A003 - stdlib signature
                pass

        httpd = make_server(
            "127.0.0.1",
            0,
            wsgi_app,
            server_class=ThreadingWSGIServer,
            handler_class=QuietHandler,
        )
        port = httpd.server_port
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
    except OSError:
        port = 0

    sys.stdout.write("PORT=%d\\n" % port)
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            resp = dispatch_wsgi(wsgi_app, req)
        except Exception as exc:
            resp = {
                "id": None,
                "status": 500,
                "headers": {"content-type": "application/json"},
                "body": json.dumps({"error": str(exc)}),
            }
        sys.stdout.write("WSGI_RPC=" + json.dumps(resp) + "\\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
`;

interface ApiResult {
  status: number;
  body: unknown;
  text: string;
}

interface PendingRpc {
  resolve: (value: { status: number; headers: Record<string, string>; body: string }) => void;
  reject: (reason: Error) => void;
}

let serverProcess: ReturnType<typeof spawn> | null = null;
let workDir = "";
let baseUrl = "";
let rpcCounter = 0;
const pendingRpcs = new Map<number, PendingRpc>();
let api: SentinelApiClient;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function callWsgiRpc(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (!serverProcess || !serverProcess.stdin) {
    throw new Error("Python WSGI server process is not running");
  }
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const parsed = new URL(rawUrl, "http://127.0.0.1:8000");
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

  let bodyText = "";
  if (typeof init?.body === "string") {
    bodyText = init.body;
  } else if (init?.body instanceof Uint8Array) {
    bodyText = new TextDecoder().decode(init.body);
  }

  const headers: Record<string, string> = {};
  if (init?.headers) {
    const h = new Headers(init.headers);
    h.forEach((value, key) => {
      headers[key] = value;
    });
  }

  const id = ++rpcCounter;
  const payload = JSON.stringify({
    id,
    method,
    path: parsed.pathname,
    query: parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search,
    body: bodyText,
    headers,
  });

  const rpcResult = await new Promise<{ status: number; headers: Record<string, string>; body: string }>(
    (resolveRpc, rejectRpc) => {
      pendingRpcs.set(id, { resolve: resolveRpc, reject: rejectRpc });
      serverProcess!.stdin!.write(payload + "\n", "utf8");
    },
  );

  const encoder = new TextEncoder();
  const bodyBytes = encoder.encode(rpcResult.body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bodyBytes);
      controller.close();
    },
  });

  return new Response(stream, {
    status: rpcResult.status,
    headers: rpcResult.headers,
  });
}

const hybridFetch: typeof fetch = async (input, init) => {
  if (!baseUrl.endsWith(":0")) {
    try {
      return await fetch(input, init);
    } catch (error) {
      const code = (error as { code?: string })?.code ?? "";
      const message = error instanceof Error ? error.message : String(error);
      if (!code.includes("EPERM") && !message.includes("EPERM")) {
        throw error;
      }
    }
  }
  return callWsgiRpc(input as string | URL | Request, init);
};

async function startServer(): Promise<string> {
  workDir = mkdtempSync(join(tmpdir(), "sentinel-console-test-"));
  const scriptPath = join(workDir, "serve.py");
  const databasePath = join(workDir, "sentinel-test.db");
  writeFileSync(scriptPath, SERVER_SOURCE, "utf8");

  const child = spawn("python3", ["-u", scriptPath, databasePath], {
    cwd: PROJECT_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONPATH: PROJECT_ROOT, PYTHONDONTWRITEBYTECODE: "1" },
  });
  serverProcess = child;

  let stdoutBuffer = "";
  let bootLog = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    bootLog += text;
    stdoutBuffer += text;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.startsWith("WSGI_RPC=")) {
        try {
          const parsed = JSON.parse(line.slice("WSGI_RPC=".length)) as {
            id: number;
            status: number;
            headers: Record<string, string>;
            body: string;
          };
          const pending = pendingRpcs.get(parsed.id);
          if (pending) {
            pendingRpcs.delete(parsed.id);
            pending.resolve(parsed);
          }
        } catch {
          // Ignore malformed RPC line
        }
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const match = /PORT=(\d+)/.exec(bootLog);
    if (match?.[1]) {
      return `http://127.0.0.1:${match[1]}`;
    }
    if (child.exitCode !== null) {
      throw new Error(`Python API exited with code ${child.exitCode}\n${stderr}`);
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for the Python API to boot\nstdout: ${bootLog}\nstderr: ${stderr}`);
}

async function request(pathname: string, init?: RequestInit): Promise<ApiResult> {
  const response = await hybridFetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, text };
}

async function getJson(pathname: string): Promise<unknown> {
  const { status, body, text } = await request(pathname);
  if (status !== 200) {
    throw new Error(`GET ${pathname} -> ${status}: ${text}`);
  }
  return body;
}

/** Seed the database through the real chaos engine (no mocks, no manually-built fixtures). */
async function seedIncident(scenarioId: string): Promise<ChaosReport> {
  const { status, body, text } = await request(`/api/v1/chaos/inject/${scenarioId}`, { method: "POST" });
  if (status !== 200) {
    throw new Error(`chaos inject ${scenarioId} -> ${status}: ${text}`);
  }
  if (!isChaosInjectResponse(body)) {
    throw new Error(`chaos inject ${scenarioId} returned a contract violation`);
  }
  const report = body.reports[0];
  if (!report) {
    throw new Error(`chaos inject ${scenarioId} returned no reports`);
  }
  return report;
}

beforeAll(async () => {
  baseUrl = await startServer();
  api = new SentinelApiClient({ baseUrl, timeoutMs: 30_000, fetchImpl: hybridFetch });
  await seedIncident("INC-004");
  await seedIncident("INC-005");
}, 60_000);

afterAll(() => {
  if (serverProcess) {
    serverProcess.kill("SIGKILL");
    serverProcess = null;
  }
  if (workDir.length > 0) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------------------------------------- */
/* Fixtures & builders                                                                            */
/* --------------------------------------------------------------------------------------------- */

function statsFixture(overrides: Partial<DashboardStats> = {}): DashboardStats {
  return {
    total_incidents_triaged: 24,
    mean_confidence: 0.923,
    labeled_incidents: 24,
    correct_diagnoses: 23,
    accuracy: 0.958,
    prompt_injections_neutralized: 4,
    guardrail_blocked_commands_total: 6,
    dr_drills_total: 24,
    dr_drills_passed: 24,
    mean_rto_ms: 842.5,
    mean_latency_ms: 118.4,
    p50_latency_ms: 96.2,
    p95_latency_ms: 210.7,
    category_breakdown: { OOMKilled: 3, CoreDnsFailure: 2 },
    severity_breakdown: { critical: 20, warning: 4 },
    last_incident_at: "2026-10-25T09:30:00Z",
    runbooks_indexed: 8,
    chaos_scenarios_available: 24,
    generated_at: "2026-10-25T09:31:00Z",
    ...overrides,
  };
}

function triageEnvelope(
  overrides: Partial<SseTriageEventData> = {},
  envelope: Partial<SseEventEnvelope> = {},
): SseEventEnvelope {
  return {
    id: "17",
    event: "incident.triaged",
    retry_ms: 3000,
    ...envelope,
    data: {
      incident_id: "INC-101",
      alert_name: "VxlanMtuMismatch",
      severity: "critical",
      service: "payments-api",
      diagnosed_category: "VxlanMtuMismatch",
      confidence: 0.94,
      cited_runbook_id: "RB-NET-01",
      prompt_injection_neutralized: false,
      blocked_command_count: 0,
      dr_drill_passed: true,
      triage_latency_ms: 84.5,
      ...overrides,
    },
  };
}

function drEnvelope(
  overrides: JsonRecord = {},
  event = "dr.drill.completed",
  id = "dr-1",
): SseEventEnvelope {
  return {
    id,
    event,
    retry_ms: 3000,
    data: {
      snapshot_id: "snapshot-001",
      incident_id: "INC-004",
      sha256_digest: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      tables_restored: 4,
      rows_verified: 1024,
      foreign_key_check_passed: true,
      rto_ms: 812.4,
      rpo_seconds: 15,
      ...overrides,
    },
  };
}

function summaryFixture(overrides: Partial<IncidentSummary> = {}): IncidentSummary {
  return {
    incident_id: "INC-201",
    alert_name: "NodeDiskPressure",
    severity: "critical",
    namespace: "production",
    service: "storage-api",
    diagnosed_category: "NodeDiskPressure",
    confidence: 0.88,
    cited_runbook_id: "RB-INF-02",
    root_cause_summary: "kubelet evicted pods after the volume hit 97% utilisation.",
    prompt_injection_neutralized: false,
    triage_latency_ms: 121.2,
    expected_category: "NodeDiskPressure",
    created_at: "2026-10-25T09:00:00Z",
    dr_drills_passed: 1,
    ...overrides,
  };
}

/* --------------------------------------------------------------------------------------------- */
/* 1. Live Python API + type guards                                                               */
/* --------------------------------------------------------------------------------------------- */

describe("live Python API contract", () => {
  test("GET /api/v1/healthz satisfies isHealthResponse", async () => {
    const { status, body } = await request("/api/v1/healthz");
    expect(status).toBe(200);
    expect(isHealthResponse(body)).toBe(true);
    const health = body as HealthResponse;
    expect(health.status).toBe("ok");
    expect(health.service).toBe("sentinel-sre");
    expect(health.runbooks_indexed).toBeGreaterThan(0);
  });

  test("GET /api/v1/stats satisfies isDashboardStats and projects KPI cards", async () => {
    const body = await getJson("/api/v1/stats");
    expect(isDashboardStats(body)).toBe(true);
    const stats = body as DashboardStats;
    expect(stats.total_incidents_triaged).toBeGreaterThanOrEqual(2);
    expect(stats.chaos_scenarios_available).toBe(24);

    const cards = kpiCardsFromStats(stats);
    expect(cards).toHaveLength(6);
    expect(cards.map((card) => card.id)).toEqual([
      "triaged",
      "accuracy",
      "injections",
      "blocked",
      "dr",
      "latency",
    ]);
    expect(cards.every((card) => card.value.length > 0)).toBe(true);
  });

  test("GET /api/v1/incidents satisfies isIncidentsListResponse", async () => {
    const body = await getJson("/api/v1/incidents?limit=50&offset=0");
    expect(isIncidentsListResponse(body)).toBe(true);
    const list = body as IncidentsListResponse;
    expect(list.count).toBeGreaterThanOrEqual(2);
    expect(list.incidents.every(isIncidentSummary)).toBe(true);
    expect(list.incidents.some((incident) => incident.incident_id === "INC-004")).toBe(true);
    expect(list.incidents.some((incident) => incident.incident_id === "INC-005")).toBe(true);
  });

  test("INC-004 detail exposes a real deadlock Wait-For Graph", async () => {
    const body = await getJson("/api/v1/incidents/INC-004");
    expect(isIncidentDetailResponse(body)).toBe(true);
    const detail = body as IncidentDetailResponse;
    expect(detail.incident_id).toBe("INC-004");
    expect(isWaitForGraphPayload(detail.wait_for_graph)).toBe(true);

    const wfg = detail.wait_for_graph;
    expect(wfg.nodes.map((node) => node.pid).sort((a, b) => a - b)).toEqual([4101, 4102]);
    expect(wfg.edges).toHaveLength(2);
    expect(wfg.deadlock_cycles).toEqual([[4101, 4102, 4101]]);
    expect(wfg.deadlock_cycles_found).toBe(1);
    expect(wfg.root_blockers).toEqual([]);
    expect(wfg.nodes.every((node) => node.is_cycle_member === true)).toBe(true);
    expect(wfg.lock_evidence.length).toBeGreaterThan(0);
    expect(Array.isArray(detail.agent_findings)).toBe(true);
    expect(detail.agent_findings.length).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(detail.guardrail_audit_log)).toBe(true);
    expect(Array.isArray(detail.dr_verifications)).toBe(true);
    expect(isKnownCategory(detail.diagnosed_category)).toBe(true);
    expect(isKnownRunbook(detail.cited_runbook_id)).toBe(true);
  });

  test("INC-005 detail exposes the head-of-line root blocker", async () => {
    const body = await getJson("/api/v1/incidents/INC-005");
    expect(isIncidentDetailResponse(body)).toBe(true);
    const wfg = (body as IncidentDetailResponse).wait_for_graph;

    expect(wfg.nodes.map((node) => node.pid).sort((a, b) => a - b)).toEqual([5000, 5001, 5002]);
    expect(wfg.edges).toHaveLength(2);
    expect(wfg.deadlock_cycles).toEqual([]);
    expect(wfg.deadlock_cycles_found).toBe(0);
    expect(wfg.root_blocker_pids).toEqual([5000]);
    expect(wfg.root_blockers).toHaveLength(1);

    const blocker = wfg.root_blockers[0];
    expect(blocker?.pid).toBe(5000);
    expect(blocker?.blocked_count).toBe(2);
    expect(blocker?.lock_mode).toBe("AccessExclusiveLock");
    expect(blocker?.state).toBe("idle in transaction");
    expect(wfg.pg_connection_ratio).toBeGreaterThan(0);
  });

  test("unknown incident returns a structured 404 through the typed client", async () => {
    const { status, body } = await request("/api/v1/incidents/INC-999");
    expect(status).toBe(404);
    expect(body).not.toBeNull();

    let captured: SentinelApiError | null = null;
    try {
      await api.getIncident("INC-999");
    } catch (error) {
      expect(error).toBeInstanceOf(SentinelApiError);
      captured = error as SentinelApiError;
    }
    expect(captured).not.toBeNull();
    expect(captured?.status).toBe(404);
    expect(captured?.isNotFound).toBe(true);
    expect(captured?.path).toBe("/api/v1/incidents/INC-999");
  });

  test("POST /api/v1/chaos/inject/INC-001 satisfies isChaosInjectResponse", async () => {
    const report = await seedIncident("INC-001");
    expect(isIncidentDetailResponse(report)).toBe(true);
    expect(report.is_adversarial).toBe(false);
    expect(typeof report.diagnosis_correct).toBe("boolean");
    expect(report.incident_id).toBe("INC-001");

    const { body } = await request("/api/v1/chaos/inject/INC-001", { method: "POST" });
    expect(isChaosInjectResponse(body)).toBe(true);
    const injected = body as ChaosInjectResponse;
    expect(injected.count).toBeGreaterThanOrEqual(1);
    expect(injected.evaluation.total).toBeGreaterThanOrEqual(1);
    expect(injected.evaluation.accuracy).toBeGreaterThanOrEqual(0);
    expect(injected.evaluation.accuracy).toBeLessThanOrEqual(1);
  });

  test("GET /api/v1/chaos/scenarios satisfies isChaosCatalogResponse", async () => {
    const body = await getJson("/api/v1/chaos/scenarios");
    expect(isChaosCatalogResponse(body)).toBe(true);
    const catalog = body as { count: number; scenarios: Array<{ scenario_id: string; is_adversarial: boolean }> };
    expect(catalog.count).toBe(24);
    expect(catalog.scenarios).toHaveLength(24);
    expect(catalog.scenarios[0]?.scenario_id).toBe("INC-001");
    expect(catalog.scenarios.filter((scenario) => scenario.is_adversarial).length).toBeGreaterThan(0);
  });

  test("POST /api/v1/dr/drill satisfies isDrRestoreResult", async () => {
    const { status, body } = await request("/api/v1/dr/drill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ incident_id: "INC-004" }),
    });
    expect(status).toBe(200);
    expect(isDrRestoreResult(body)).toBe(true);
    const result = body as DrRestoreResult;
    expect(result.incident_id).toBe("INC-004");
    expect(result.foreign_key_check_passed).toBe(true);
    expect(result.sha256_digest).toMatch(/^[0-9a-f]{16,64}$/);
    expect(result.rto_ms).toBeGreaterThan(0);
  });

  test("GET /api/v1/dr/verifications satisfies isDrVerificationsResponse", async () => {
    const body = await getJson("/api/v1/dr/verifications?limit=10");
    expect(isDrVerificationsResponse(body)).toBe(true);
    const response = body as { count: number; verifications: unknown[] };
    expect(response.count).toBeGreaterThanOrEqual(1);
    expect(response.verifications.every(isDrVerificationRow)).toBe(true);
  });

  test("GET /metrics returns Prometheus exposition", async () => {
    const text = await api.metricsText();
    expect(text).toContain("sentinel_incidents_triaged_total");
    expect(text).toContain("# HELP");
  });
});

/* --------------------------------------------------------------------------------------------- */
/* 2. Wait-For Graph layout: real backend payloads                                                */
/* --------------------------------------------------------------------------------------------- */

describe("Wait-For Graph layout", () => {
  test("INC-004 renders a two-node deadlock cycle", async () => {
    const details = demoIncidentDetails();
    const demo = details["INC-004"];
    expect(demo).toBeDefined();

    const live = await getJson("/api/v1/incidents/INC-004");
    expect(isIncidentDetailResponse(live)).toBe(true);

    const payloads = [demo!.wait_for_graph, (live as IncidentDetailResponse).wait_for_graph];
    for (const payload of payloads) {
      const layout = layoutWaitForGraph(payload);
      expect(layout.isEmpty).toBe(false);
      expect(layout.nodes).toHaveLength(2);
      expect(layout.edges).toHaveLength(2);
      expect(layout.cycles).toHaveLength(1);
      expect(layout.cycles[0]?.pids.slice().sort((a, b) => a - b)).toEqual([4101, 4102]);
      expect(layout.metrics.hasDeadlock).toBe(true);
      expect(layout.metrics.cycleMemberCount).toBe(2);
      expect(layout.metrics.cycleCount).toBe(1);
      expect(layout.metrics.rootBlockerCount).toBe(0);
      expect(layout.metrics.criticalChainDepth).toBe(2);
      expect(layout.metrics.criticalChainPids.slice().sort((a, b) => a - b)).toEqual([4101, 4102]);
      expect(layout.metrics.severity).toBe("critical");
      expect(layout.metrics.nodeCount).toBe(2);
      expect(layout.metrics.edgeCount).toBe(2);

      // Reciprocal edges must bow in opposite directions to remain visually distinct.
      const paths = layout.edges.map((edge) => edge.path);
      expect(paths[0]).not.toBe(paths[1]);
      expect(layout.edges.every((edge) => edge.inCycle)).toBe(true);
      expect(layout.edges.every((edge) => edge.path.startsWith("M "))).toBe(true);

      const badge = layout.badges.find((candidate) => candidate.kind === "cycle");
      expect(badge).toBeDefined();
      expect(badge?.tone).toBe("crimson");

      const narrative = describeWaitForGraph(layout);
      expect(narrative.tone).toBe("critical");
      expect(narrative.headline).toContain("circular deadlock");
      expect(summarizeWaitForGraph(layout)).toContain("1 deadlock");
    }
  });

  test("INC-005 renders a layered chain behind an AccessExclusiveLock blocker", async () => {
    const demo = demoIncidentDetails()["INC-005"];
    expect(demo).toBeDefined();
    const live = await getJson("/api/v1/incidents/INC-005");
    expect(isIncidentDetailResponse(live)).toBe(true);

    const payloads = [demo!.wait_for_graph, (live as IncidentDetailResponse).wait_for_graph];
    for (const payload of payloads) {
      const layout = layoutWaitForGraph(payload);
      expect(layout.nodes).toHaveLength(3);
      expect(layout.edges).toHaveLength(2);
      expect(layout.cycles).toHaveLength(0);
      expect(layout.rootBlockers).toHaveLength(1);
      expect(layout.rootBlockers[0]?.pid).toBe(5000);
      expect(layout.metrics.rootBlockerCount).toBe(1);
      expect(layout.metrics.maxFanOut).toBe(2);
      expect(layout.metrics.widestBlockerPid).toBe(5000);
      expect(layout.metrics.hasAccessExclusiveBlocker).toBe(true);
      expect(layout.metrics.hasDeadlock).toBe(false);
      expect(layout.metrics.severity).toBe("warning");
      expect(layout.metrics.hotspotPid).toBe(5000);
      expect(layout.metrics.criticalChainDepth).toBe(3);
      expect(layout.metrics.criticalChainPids).toEqual([5000, 5001, 5002]);
      expect(layout.metrics.lockModes).toContain("AccessExclusiveLock");

      const blockedNode = layout.nodes.find((node) => node.pid === 5000);
      expect(blockedNode?.isRootBlocker).toBe(true);
      expect(blockedNode?.blockedCount).toBe(2);

      const badge = layout.badges.find((candidate) => candidate.id.startsWith("badge-root"));
      expect(badge?.tone).toBe("amber");
      expect(badge?.pid).toBe(5000);

      const narrative = describeWaitForGraph(layout);
      expect(narrative.tone).toBe("warning");
      expect(narrative.headline).toContain("head-of-line blocker PID 5000");
      expect(narrative.detail).toContain("critical chain depth 3");
      expect(summarizeWaitForGraph(layout)).toContain("1 root blocker");
    }
  });

  test("layout is deterministic and keeps every node inside the canvas", () => {
    const payload = demoIncidentDetails()["INC-005"]!.wait_for_graph;
    const first = layoutWaitForGraph(payload, { width: 640, height: 420 });
    const second = layoutWaitForGraph(payload, { width: 640, height: 420 });

    expect(first).toEqual(second);
    expect(first.width).toBe(640);
    expect(first.height).toBe(420);
    for (const node of first.nodes) {
      expect(node.x - node.radius).toBeGreaterThanOrEqual(0);
      expect(node.x + node.radius).toBeLessThanOrEqual(640);
      expect(node.y - node.radius).toBeGreaterThanOrEqual(0);
      expect(node.y + node.radius).toBeLessThanOrEqual(420);
    }
    for (const edge of first.edges) {
      expect(Number.isFinite(edge.source.x)).toBe(true);
      expect(Number.isFinite(edge.target.y)).toBe(true);
      expect(edge.label.length).toBeGreaterThan(0);
    }
  });

  test("empty payload degrades gracefully to a healthy narrative", () => {
    const layout = layoutWaitForGraph(null);
    expect(layout.isEmpty).toBe(true);
    expect(layout.nodes).toEqual([]);
    expect(layout.metrics.severity).toBe("healthy");
    expect(describeWaitForGraph(layout).tone).toBe("healthy");
    expect(summarizeWaitForGraph(layout)).toBe("no pg_locks contention");
  });

  test("normalizeWaitForGraph derives edges from blocking_pids when absent", () => {
    const payload = normalizeWaitForGraph({
      nodes: [
        {
          pid: 1,
          usename: "app",
          application_name: "api",
          state: "active",
          wait_event_type: "Lock",
          wait_event: "relation",
          blocking_pids: [2],
          query: "SELECT 1",
          xact_duration_sec: 1.5,
          lock_mode: "ShareLock",
        },
      ],
    });
    expect(payload.nodes).toHaveLength(1);
    expect(payload.edges).toHaveLength(1);
    expect(payload.edges[0]?.waiter_pid).toBe(1);
    expect(payload.edges[0]?.blocker_pid).toBe(2);
    expect(payload.deadlock_cycles).toEqual([]);
    expect(payload.deadlock_cycles_found).toBe(0);
  });

  test("cycle detection and root blocker heuristics agree with the layout engine", () => {
    const details = demoIncidentDetails();
    const sessions4 = details["INC-004"]!.wait_for_graph.nodes;
    const sessions5 = details["INC-005"]!.wait_for_graph.nodes;

    const cycles = detectDeadlockCycles(sessions4);
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0])).toEqual(new Set([4101, 4102]));

    const blockers4 = detectRootBlockers(sessions4);
    expect(blockers4).toEqual([]);

    const blockers5 = detectRootBlockers(sessions5);
    expect(blockers5).toHaveLength(1);
    expect(blockers5[0]?.pid).toBe(5000);
    expect(blockers5[0]?.blocked_count).toBe(2);

    const rebuilt = buildWaitForGraph(sessions5, 0.91);
    expect(rebuilt.root_blocker_pids).toEqual([5000]);
    expect(rebuilt.edges).toHaveLength(2);
    expect(rebuilt.pg_connection_ratio).toBe(0.91);
    expect(rebuilt.source).toBe("client-reconstruction");
    expect(rebuilt.nodes.find((node) => node.pid === 5000)?.blocked_count).toBe(2);
  });

  test("bezier path is a cubic curve with a midpoint label offset", () => {
    const path = buildBezierPath({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(path.startsWith("M 0 0")).toBe(true);
    expect(path.split("C")).toHaveLength(2);
    const reversed = buildBezierPath({ x: 100, y: 0 }, { x: 0, y: 0 });
    expect(reversed).not.toBe(path);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* 3. Console reducer                                                                             */
/* --------------------------------------------------------------------------------------------- */

describe("console reducer", () => {
  test("STATS_LOADED marks the console ready and keeps the highest incident total", () => {
    const state = createInitialConsoleState({ incidentTotal: 30 });
    const next = consoleReducer(state, { type: "STATS_LOADED", stats: statsFixture() });
    expect(next.status).toBe("ready");
    expect(next.stats?.total_incidents_triaged).toBe(24);
    expect(next.incidentTotal).toBe(30);
    expect(next.error).toBeNull();
    expect(next).not.toBe(state);
  });

  test("INCIDENTS_LOADED sorts the queue newest-first", () => {
    const older = summaryFixture({ incident_id: "INC-100", created_at: "2026-10-24T09:00:00Z" });
    const newer = summaryFixture({ incident_id: "INC-102", created_at: "2026-10-25T10:00:00Z" });
    const middle = summaryFixture({ incident_id: "INC-101", created_at: "2026-10-25T09:00:00Z" });

    const next = consoleReducer(createInitialConsoleState(), {
      type: "INCIDENTS_LOADED",
      incidents: [older, newer, middle],
      total: 3,
    });
    expect(next.status).toBe("ready");
    expect(next.incidentTotal).toBe(3);
    expect(next.incidents.map((incident) => incident.incident_id)).toEqual(["INC-102", "INC-101", "INC-100"]);
  });

  test("INCIDENT_SELECTED upserts the summary and adopts DR history", () => {
    const detail = demoIncidentDetails()["INC-004"]!;
    const next = consoleReducer(createInitialConsoleState({ incidents: [summaryFixture()] }), {
      type: "INCIDENT_SELECTED",
      incident: detail,
    });

    expect(next.selectedIncidentId).toBe("INC-004");
    expect(next.selectedIncident?.incident_id).toBe("INC-004");
    expect(next.incidents.some((inc) => inc.incident_id === "INC-004")).toBe(true);
    expect(next.incidents).toHaveLength(2);
    expect(next.drVerifications.length).toBeGreaterThanOrEqual(0);
    expect(incidentSummaryFromDetail(detail).incident_id).toBe(detail.incident_id);
  });

  test("SSE_TRIAGE_EVENT appends the incident, increments KPIs and logs the event", () => {
    const base = consoleReducer(createInitialConsoleState(), { type: "STATS_LOADED", stats: statsFixture() });
    const next = consoleReducer(base, {
      type: "SSE_TRIAGE_EVENT",
      envelope: triageEnvelope(),
      receivedAt: "2026-10-25T10:00:00Z",
    });

    expect(next.incidents).toHaveLength(1);
    expect(next.incidents[0]?.incident_id).toBe("INC-101");
    expect(next.incidentTotal).toBe(25);
    expect(next.stats?.total_incidents_triaged).toBe(25);
    expect(next.stats?.dr_drills_total).toBe(25);
    expect(next.stats?.dr_drills_passed).toBe(25);
    expect(next.stats?.last_incident_at).toBe("2026-10-25T10:00:00Z");
    expect(next.stats?.category_breakdown.VxlanMtuMismatch).toBeDefined();
    expect(next.stats?.severity_breakdown.critical).toBe(21);
    expect(next.latencySamples).toEqual([84.5]);
    expect(next.stats?.mean_latency_ms).toBe(84.5);
    expect(next.lastEventId).toBe("17");
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.headline).toContain("INC-101");
    expect(next.events[0]?.tone).toBe("critical");
    expect(next.events[0]?.data).toEqual((triageEnvelope() as SseEventEnvelope).data);
  });

  test("SSE_TRIAGE_EVENT is idempotent for repeated incident ids", () => {
    let state = createInitialConsoleState();
    const envelope = triageEnvelope();
    state = consoleReducer(state, { type: "SSE_TRIAGE_EVENT", envelope, receivedAt: "t1" });
    state = consoleReducer(state, {
      type: "SSE_TRIAGE_EVENT",
      envelope: { ...envelope, id: "18" },
      receivedAt: "t2",
    });
    expect(state.incidents).toHaveLength(1);
    expect(state.incidentTotal).toBe(1);
    expect(state.events).toHaveLength(2);
    expect(state.latencySamples).toEqual([84.5, 84.5]);
  });

  test("SSE_TRIAGE_EVENT drops malformed payloads without corrupting state", () => {
    const base = consoleReducer(createInitialConsoleState(), { type: "STATS_LOADED", stats: statsFixture() });
    const next = consoleReducer(base, {
      type: "SSE_TRIAGE_EVENT",
      envelope: { id: "19", event: "incident.triaged", data: { incident_id: 5 }, retry_ms: null },
      receivedAt: "2026-10-25T10:05:00Z",
    });
    expect(next.stats).toEqual(base.stats);
    expect(next.incidents).toEqual([]);
    expect(next.events[0]?.tone).toBe("critical");
    expect(next.events[0]?.headline).toBe("Contract violation");
  });

  test("SSE_DR_EVENT records a verified drill and pushes an RTO sample", () => {
    const base = consoleReducer(createInitialConsoleState(), { type: "STATS_LOADED", stats: statsFixture() });
    const next = consoleReducer(base, {
      type: "SSE_DR_EVENT",
      envelope: drEnvelope(),
      receivedAt: "2026-10-25T10:10:00Z",
    });

    expect(next.rtoSamples).toEqual([812.4]);
    expect(next.stats?.dr_drills_total).toBe(25);
    expect(next.stats?.dr_drills_passed).toBe(25);
    expect(next.stats?.mean_rto_ms).toBe(812.4);
    expect(next.drVerifications).toHaveLength(1);
    expect(next.drVerifications[0]?.snapshot_id).toBe("snapshot-001");
    expect(next.drDrill.status).toBe("success");
    expect(next.drDrill.result?.sha256_digest).toHaveLength(64);
    expect(next.events[0]?.tone).toBe("success");
    expect(next.lastEventId).toBe("dr-1");
  });

  test("SSE_DR_EVENT handles failures and malformed payloads", () => {
    const failed = consoleReducer(createInitialConsoleState({ drDrill: { status: "running", incidentId: "INC-004", startedAt: "t0", result: null, error: null } }), {
      type: "SSE_DR_EVENT",
      envelope: drEnvelope(
        { foreign_key_check_passed: false, rto_ms: undefined, sha256_digest: undefined, error: "FK violation" },
        "dr.drill.failed",
      ),
      receivedAt: "2026-10-25T10:11:00Z",
    });
    expect(failed.drDrill.status).toBe("error");
    expect(failed.drDrill.error).toBe("FK violation");
    expect(failed.events[0]?.tone).toBe("critical");
    expect(failed.rtoSamples).toEqual([]);

    const malformed = consoleReducer(createInitialConsoleState(), {
      type: "SSE_DR_EVENT",
      envelope: { id: "x", event: "dr.drill.completed", data: { rto_ms: "fast" }, retry_ms: null },
      receivedAt: "t",
    });
    expect(malformed.drDrill.status).toBe("idle");
    expect(malformed.events[0]?.headline).toBe("Contract violation");
  });

  test("CHAOS_INJECTION_STARTED opens a run that SSE triage events advance", () => {
    let state = consoleReducer(createInitialConsoleState(), {
      type: "CHAOS_INJECTION_STARTED",
      scenarioId: "all",
      total: 3,
      startedAt: "2026-10-25T10:20:00Z",
    });
    expect(state.chaosRun?.scenarioId).toBe("all");
    expect(state.chaosRun?.total).toBe(3);
    expect(state.chaosRun?.status).toBe("running");
    expect(state.chaosRun?.message).toContain("3");

    state = consoleReducer(state, {
      type: "SSE_TRIAGE_EVENT",
      envelope: triageEnvelope({ index: 1, total: 3 }),
      receivedAt: "t1",
    });
    expect(state.chaosRun?.completed).toBe(1);
    expect(state.chaosRun?.status).toBe("streaming");

    state = consoleReducer(state, {
      type: "CHAOS_PROGRESS",
      completed: 2,
      total: 3,
    });
    expect(state.chaosRun?.completed).toBe(2);

    const progress = selectChaosProgress(state);
    expect(progress.percent).toBe(67);
    expect(progress.label).toBe("2/3 scenarios");

    state = consoleReducer(state, {
      type: "CHAOS_COMPLETED",
      evaluation: {
        total: 3,
        correct_category: 3,
        correct_runbook: 3,
        accuracy: 1,
        runbook_recall_at_1: 1,
        adversarial_total: 0,
        adversarial_intercepted: 0,
        dr_drills_passed: 3,
      },
    });
    expect(state.chaosRun?.status).toBe("complete");
    expect(state.chaosRun?.evaluation?.accuracy).toBe(1);
  });

  test("FILTER_CHANGED and SEARCH_CHANGED drive selectFilteredIncidents", () => {
    const incidents = [
      summaryFixture({ incident_id: "INC-300", diagnosed_category: "OOMKilled", severity: "critical" }),
      summaryFixture({
        incident_id: "INC-301",
        diagnosed_category: "TlsCertExpiry",
        severity: "warning",
        prompt_injection_neutralized: true,
        dr_drills_passed: 0,
        service: "edge-gateway",
      }),
      summaryFixture({ incident_id: "INC-302", diagnosed_category: "CoreDnsFailure", severity: "critical" }),
    ];

    let state = consoleReducer(createInitialConsoleState(), { type: "INCIDENTS_LOADED", incidents });
    expect(selectFilteredIncidents(state)).toHaveLength(3);

    state = consoleReducer(state, { type: "FILTER_CHANGED", patch: { severity: "critical" } });
    expect(selectFilteredIncidents(state).map((incident) => incident.incident_id)).toEqual([
      "INC-302",
      "INC-300",
    ]);

    state = consoleReducer(state, { type: "FILTER_CHANGED", patch: { severity: "all", onlyAdversarial: true } });
    expect(selectFilteredIncidents(state).map((incident) => incident.incident_id)).toEqual(["INC-301"]);

    state = consoleReducer(state, { type: "FILTER_CHANGED", patch: { onlyAdversarial: false, onlyWithDr: true } });
    expect(selectFilteredIncidents(state).map((incident) => incident.incident_id)).toEqual([
      "INC-302",
      "INC-300",
    ]);

    state = consoleReducer(state, { type: "FILTER_CHANGED", patch: { onlyWithDr: false } });
    state = consoleReducer(state, { type: "SEARCH_CHANGED", search: "  edge-gateway " });
    expect(state.filters.search).toBe("  edge-gateway ");
    expect(selectFilteredIncidents(state).map((incident) => incident.incident_id)).toEqual(["INC-301"]);

    state = consoleReducer(state, { type: "SEARCH_CHANGED", search: "" });
    state = consoleReducer(state, { type: "FILTER_CHANGED", patch: { category: "OOMKilled" } });
    expect(selectFilteredIncidents(state).map((incident) => incident.incident_id)).toEqual(["INC-300"]);
  });

  test("event log is capped at EVENT_LOG_LIMIT entries", () => {
    let state: ConsoleState = createInitialConsoleState();
    for (let index = 0; index < EVENT_LOG_LIMIT + 15; index += 1) {
      state = consoleReducer(state, {
        type: "SSE_TRIAGE_EVENT",
        envelope: triageEnvelope(
          { incident_id: `INC-${500 + index}` },
          { id: String(index), event: "incident.triaged" },
        ),
        receivedAt: `t${index}`,
      });
    }
    expect(state.events).toHaveLength(EVENT_LOG_LIMIT);
    expect(state.incidents).toHaveLength(EVENT_LOG_LIMIT + 15);
    expect(state.events[0]?.receivedAt).toBe(`t${EVENT_LOG_LIMIT + 14}`);
  });

  test("selectKpiCards delegates to the stats projection", () => {
    const state = consoleReducer(createInitialConsoleState(), { type: "STATS_LOADED", stats: statsFixture() });
    const placeholder = selectKpiCards(createInitialConsoleState());
    expect(placeholder.every((card) => card.value === "—")).toBe(true);
    expect(selectKpiCards(state)).toEqual(kpiCardsFromStats(statsFixture()));
  });

  test("sseEnvelopeToAction routes known events and ignores heartbeats", () => {
    expect(sseEnvelopeToAction(triageEnvelope(), "t")?.type).toBe("SSE_TRIAGE_EVENT");
    expect(sseEnvelopeToAction(drEnvelope(), "t")?.type).toBe("SSE_DR_EVENT");
    expect(
      sseEnvelopeToAction({ id: null, event: "chaos.run.started", data: { scenario_id: "all", total: 2 }, retry_ms: null }, "t")
        ?.type,
    ).toBe("SSE_CHAOS_EVENT");
    expect(sseEnvelopeToAction({ id: null, event: "heartbeat", data: {}, retry_ms: null }, "t")).toBeNull();
    expect(applySseEnvelope(createInitialConsoleState(), { id: null, event: "heartbeat", data: {}, retry_ms: null }, "t").events).toEqual([]);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* 4. SSE frame parser                                                                            */
/* --------------------------------------------------------------------------------------------- */

describe("SSE frame parser", () => {
  test("parses ids, events, retry hints and JSON data", () => {
    const frames = parseSseText(
      'id: 7\nevent: incident.triaged\nretry: 2500\ndata: {"incident_id":"INC-001"}\n\n' +
        'event: dr.drill.completed\ndata: {"rto_ms":12.5}\n\n',
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({
      id: "7",
      event: "incident.triaged",
      data: { incident_id: "INC-001" },
      retry_ms: 2500,
    });
    expect(frames[1]?.event).toBe("dr.drill.completed");
    expect(frames[1]?.id).toBe("7");
    expect(frames[1]?.data).toEqual({ rto_ms: 12.5 });
  });

  test("handles chunk splits, CRLF, comments and multi-line data", () => {
    const parser = new SseFrameParser();
    const stream =
      ": keep-alive\r\n" +
      "event: chaos.run.started\r\n" +
      "data: {\"scenario_id\":\r\n" +
      "data: \"INC-004\",\"total\":1}\r\n" +
      "\r\n";

    const mid = Math.floor(stream.length / 2);
    const first = parser.push(stream.slice(0, mid));
    const second = [...parser.push(stream.slice(mid)), ...parser.finish()];
    const frames = [...first, ...second];

    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe("chaos.run.started");
    expect(frames[0]?.data).toEqual({ scenario_id: "INC-004", total: 1 });
  });

  test("defaults to the message event and wraps non-object JSON", () => {
    const [frame] = parseSseText('data: "plain string"\n\n');
    expect(frame?.event).toBe("message");
    expect(frame?.data).toEqual({ value: "plain string" });
  });

  test("preserves broken JSON as raw text instead of throwing", () => {
    const [frame] = parseSseText("event: incident.triaged\ndata: {not json}\n\n");
    expect(frame?.data).toEqual({ raw: "{not json}" });
  });

  test("finish() flushes a frame without a trailing blank line", () => {
    const parser = new SseFrameParser();
    expect(parser.push('id: 3\nevent: incident.triaged\ndata: {"a":1}\n')).toEqual([]);
    expect(parser.finish()).toEqual([
      { id: "3", event: "incident.triaged", data: { a: 1 }, retry_ms: null },
    ]);
  });

  test("encodeSseEvent round-trips through parseSseText", () => {
    const text = encodeSseEvent("incident.triaged", { incident_id: "INC-004" }, 11);
    expect(text).toBe('id: 11\nevent: incident.triaged\ndata: {"incident_id":"INC-004"}\n\n');
    expect(parseSseText(text)).toEqual([
      { id: "11", event: "incident.triaged", data: { incident_id: "INC-004" }, retry_ms: null },
    ]);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* 5. Live SSE stream through the typed client                                                    */
/* --------------------------------------------------------------------------------------------- */

describe("live SSE chaos stream", () => {
  test("streams started → triaged → completed and drives the reducer to completion", async () => {
    const envelopes: SseEventEnvelope[] = [];
    const handle = api.openChaosStream("INC-007", { onEvent: (envelope) => envelopes.push(envelope) });

    await Promise.race([
      handle.done,
      sleep(25_000).then(() => {
        throw new Error("Timed out waiting for the chaos SSE stream");
      }),
    ]);

    expect(envelopes.length).toBeGreaterThanOrEqual(3);
    expect(envelopes.every(isSseEventEnvelope)).toBe(true);
    expect(envelopes.map((envelope) => envelope.event)).toEqual([
      "chaos.run.started",
      "incident.triaged",
      "chaos.run.completed",
    ]);

    const triage = envelopes[1]!;
    expect(isSseTriageEventData(triage.data)).toBe(true);
    expect(triage.data.report).toBeDefined();

    let state = consoleReducer(createInitialConsoleState(), {
      type: "CHAOS_INJECTION_STARTED",
      scenarioId: "INC-007",
      total: 1,
      startedAt: "2026-10-25T11:00:00Z",
    });
    for (const envelope of envelopes) {
      state = applySseEnvelope(state, envelope, "2026-10-25T11:00:01Z");
    }

    expect(state.chaosRun?.status).toBe("complete");
    expect(state.chaosRun?.completed).toBe(1);
    expect(state.chaosRun?.evaluation?.total).toBe(1);
    expect(state.incidents.some((incident) => incident.incident_id === "INC-007")).toBe(true);
    expect(state.events.length).toBeGreaterThanOrEqual(3);
  }, 30_000);
});

/* --------------------------------------------------------------------------------------------- */
/* 6. Offline demo client                                                                         */
/* --------------------------------------------------------------------------------------------- */

describe("offline demo client", () => {
  test("serves health, stats and the full 24-scenario incident catalog", async () => {
    const client = SentinelApiClient.offline();
    expect(client.offline).toBe(true);

    const health = await client.healthz();
    expect(isHealthResponse(health)).toBe(true);
    expect(health.database.backend).toBe("sqlite");

    const stats = await client.stats();
    expect(isDashboardStats(stats)).toBe(true);
    expect(stats.total_incidents_triaged).toBe(24);
    expect(stats).toEqual(demoStats());

    const list = await client.listIncidents({ limit: 100 });
    expect(isIncidentsListResponse(list)).toBe(true);
    expect(list.total).toBe(24);
    expect(list.count).toBe(24);
    expect(list.incidents.every(isIncidentSummary)).toBe(true);

    const paged = await client.listIncidents({ limit: 5, offset: 20 });
    expect(paged.count).toBe(4);
    expect(paged.limit).toBe(5);
    expect(paged.offset).toBe(20);
  });

  test("serves incident details that satisfy the live contract", async () => {
    const client = SentinelApiClient.offline();
    const catalog = await client.chaosCatalog();
    expect(isChaosCatalogResponse(catalog)).toBe(true);
    expect(catalog.count).toBe(24);

    for (const scenario of catalog.scenarios) {
      const detail = await client.getIncident(scenario.scenario_id);
      expect(isIncidentDetailResponse(detail)).toBe(true);
      expect(detail.incident_id).toBe(scenario.scenario_id);
      expect(layoutWaitForGraph(detail.wait_for_graph).isEmpty).toBe(detail.wait_for_graph.nodes.length === 0);
    }
  });

  test("simulates a chaos run, a DR drill and unknown ids", async () => {
    const client = SentinelApiClient.offline();

    const injected = await client.injectChaos("INC-004");
    expect(isChaosInjectResponse(injected)).toBe(true);
    expect(injected.scenario_id).toBe("INC-004");
    expect(injected.reports).toHaveLength(1);
    expect(injected.evaluation.total).toBe(1);
    expect(injected.evaluation.accuracy).toBe(1);

    const all = await client.injectChaos("all");
    expect(all.count).toBe(24);
    expect(all.evaluation.total).toBe(24);
    expect(all.evaluation.adversarial_total).toBeGreaterThan(0);

    const drill = await client.runDrDrill("INC-005");
    expect(isDrRestoreResult(drill)).toBe(true);
    expect(drill.incident_id).toBe("INC-005");

    const verifications = await client.listDrVerifications(5);
    expect(isDrVerificationsResponse(verifications)).toBe(true);
    expect(verifications.count).toBeLessThanOrEqual(5);
    expect(verifications.verifications[0]?.snapshot_id).toBe(drill.snapshot_id);

    await expect(client.getIncident("INC-999")).rejects.toBeInstanceOf(SentinelApiError);
    await expect(client.injectChaos("INC-999")).rejects.toBeInstanceOf(SentinelApiError);
  });

  test("offline chaos stream replays every frame and then closes", async () => {
    const client = SentinelApiClient.offline();
    const events: SseEventEnvelope[] = [];
    const handle = client.openChaosStream("INC-004", { onEvent: (envelope) => events.push(envelope) });

    await handle.done;
    expect(handle.closed).toBe(false);
    expect(events.map((event) => event.event)).toEqual([
      "chaos.run.started",
      "incident.triaged",
      "chaos.run.completed",
    ]);
    expect(events.every(isSseEventEnvelope)).toBe(true);

    const report = (events[1]?.data as { report?: ChaosReport }).report;
    expect(report?.incident_id).toBe("INC-004");
    expect(report?.wait_for_graph.deadlock_cycles_found).toBe(1);
  });

  test("offline client refuses HTTP requests but still exposes metrics", async () => {
    const client = SentinelApiClient.offline();
    const triaged = await client.triage({ incident_id: "INC-DEMO", alert_name: "Synthetic" });
    expect(triaged.incident_id).toBe("INC-DEMO");
    expect(triaged.alert_name).toBe("Synthetic");

    const metrics = await client.metricsText();
    expect(metrics).toContain("sentinel_incidents_total");

    expect(client.offlineSummary("INC-004")?.incident_id).toBe("INC-004");
    expect(client.offlineSummary("INC-999")).toBeNull();
    expect(client.offlineIncidentSummaries()).toHaveLength(25);
  });
});
