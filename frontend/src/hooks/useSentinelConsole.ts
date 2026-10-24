"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { SentinelApiClient, SentinelApiError, type SseStreamHandle } from "../lib/api-client";
import {
  consoleReducer,
  createInitialConsoleState,
  sseEnvelopeToAction,
  type ConsoleAction,
  type ConsoleFilters,
  type ConsoleState,
} from "../lib/console-store";
import type { ChaosInjectResponse, SseEventEnvelope } from "../types/sentinel";

const API_BASE =
  process.env.NEXT_PUBLIC_SENTINEL_API_URL ??
  process.env.NEXT_PUBLIC_SENTINEL_API_BASE ??
  "http://127.0.0.1:8000";

function shouldDefaultToOfflineDemo(): boolean {
  if (process.env.NEXT_PUBLIC_SENTINEL_OFFLINE_DEMO === "true") {
    return true;
  }
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    const isLocalPage = host === "localhost" || host === "127.0.0.1";
    const isLocalApi = API_BASE.includes("localhost") || API_BASE.includes("127.0.0.1");
    if (!isLocalPage && isLocalApi) {
      return true;
    }
  }
  return false;
}

export interface SentinelConsoleApi {
  state: ConsoleState;
  streaming: boolean;
  loading: boolean;
  lastSyncedAt: string | null;
  refresh: () => Promise<void>;
  selectIncident: (incidentId: string) => Promise<void>;
  injectChaos: (scenarioId: string) => Promise<void>;
  streamAllChaos: () => void;
  cancelChaos: () => void;
  runDrDrill: () => Promise<void>;
  changeFilter: (patch: Partial<ConsoleFilters>) => void;
  search: (value: string) => void;
  clearError: () => void;
  toggleOffline: () => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof SentinelApiError) {
    return error.isNetworkError
      ? `Cannot reach the Sentinel-SRE API at ${API_BASE}. Start the Python service or switch to offline demo mode.`
      : String(error.detail ?? error.message);
  }
  return error instanceof Error ? error.message : String(error);
}

export function useSentinelConsole(): SentinelConsoleApi {
  const [state, dispatch] = useReducer(consoleReducer, undefined, () => createInitialConsoleState());
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const clientRef = useRef<SentinelApiClient>(new SentinelApiClient({ baseUrl: API_BASE }));
  const streamRef = useRef<SseStreamHandle | null>(null);
  const eventStreamRef = useRef<SseStreamHandle | null>(null);
  const mountedRef = useRef(true);
  const selectedOnceRef = useRef(false);

  const safeDispatch = useCallback((action: ConsoleAction) => {
    if (mountedRef.current) {
      dispatch(action);
    }
  }, []);

  const loadResources = useCallback(
    async (client: SentinelApiClient, options: { selectFirst?: boolean } = {}) => {
      const [statsResult, incidentsResult, catalogResult, drResult] = await Promise.allSettled([
        client.stats(),
        client.listIncidents({ limit: 50, offset: 0 }),
        client.chaosCatalog(),
        client.listDrVerifications(50),
      ]);

      if (statsResult.status === "fulfilled") {
        safeDispatch({ type: "STATS_LOADED", stats: statsResult.value });
      }
      let firstIncidentId: string | null = null;
      if (incidentsResult.status === "fulfilled") {
        const { incidents, total } = incidentsResult.value;
        safeDispatch({ type: "INCIDENTS_LOADED", incidents, total });
        firstIncidentId = incidents[0]?.incident_id ?? null;
      }
      if (catalogResult.status === "fulfilled") {
        safeDispatch({ type: "CHAOS_CATALOG_LOADED", catalog: catalogResult.value });
      }
      if (drResult.status === "fulfilled") {
        safeDispatch({ type: "DR_VERIFICATIONS_LOADED", verifications: drResult.value.verifications });
      }

      const firstFailure = [statsResult, incidentsResult, catalogResult, drResult].find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (firstFailure) {
        throw firstFailure.reason;
      }

      if (options.selectFirst && firstIncidentId && !selectedOnceRef.current) {
        selectedOnceRef.current = true;
        const preferred = firstIncidentId === "INC-024" ? "INC-004" : firstIncidentId;
        try {
          const detail = await client.getIncident(preferred);
          safeDispatch({ type: "INCIDENT_SELECTED", incident: detail });
        } catch {
          try {
            const detail = await client.getIncident(firstIncidentId);
            safeDispatch({ type: "INCIDENT_SELECTED", incident: detail });
          } catch {
            // Leave the queue populated even if the detail request fails.
          }
        }
      }
    },
    [safeDispatch],
  );

  const bootstrap = useCallback(
    async (client: SentinelApiClient, offline: boolean) => {
      setLoading(true);
      try {
        await loadResources(client, { selectFirst: true });
        safeDispatch({ type: "OFFLINE_MODE_CHANGED", offline });
        setLastSyncedAt(new Date().toISOString());
      } catch (error) {
        if (offline) {
          safeDispatch({ type: "ERROR", error: errorMessage(error) });
        } else {
          // Automatic offline demo fallback: the console must never be a blank page.
          const offlineClient = SentinelApiClient.offline();
          clientRef.current = offlineClient;
          safeDispatch({ type: "OFFLINE_MODE_CHANGED", offline: true });
          try {
            await loadResources(offlineClient, { selectFirst: true });
            setLastSyncedAt(new Date().toISOString());
            safeDispatch({
              type: "ERROR",
              error: "Python API unreachable — serving deterministic offline demo fixtures.",
            });
          } catch (fallbackError) {
            safeDispatch({ type: "ERROR", error: errorMessage(fallbackError) });
          }
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    },
    [loadResources, safeDispatch],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (shouldDefaultToOfflineDemo()) {
      const offlineClient = SentinelApiClient.offline();
      clientRef.current = offlineClient;
      void bootstrap(offlineClient, true);
    } else {
      void bootstrap(clientRef.current, false);
    }
    return () => {
      mountedRef.current = false;
      streamRef.current?.close();
      eventStreamRef.current?.close();
    };
  }, [bootstrap]);

  // Live SSE subscription (skipped in offline demo mode, where there is no server).
  useEffect(() => {
    if (state.offline) {
      setStreaming(false);
      return;
    }
    const client = clientRef.current;
    setStreaming(true);
    const handle = client.openEventStream(
      {
        onOpen: () => {
          if (mountedRef.current) {
            setStreaming(true);
          }
        },
        onEvent: (envelope: SseEventEnvelope) => {
          const receivedAt = new Date().toISOString();
          const action = sseEnvelopeToAction(envelope, receivedAt);
          if (action !== null) {
            safeDispatch(action);
          }
        },
        onError: () => {
          if (mountedRef.current) {
            setStreaming(false);
          }
        },
        onClose: () => {
          if (mountedRef.current) {
            setStreaming(false);
          }
        },
      },
      { heartbeatSeconds: 20 },
    );
    eventStreamRef.current = handle;
    return () => {
      handle.close();
      eventStreamRef.current = null;
      setStreaming(false);
    };
  }, [state.offline, safeDispatch]);

  // Lightweight polling keeps KPIs fresh even if SSE reconnects silently.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !state.offline) {
        void clientRef.current
          .stats()
          .then((stats) => safeDispatch({ type: "STATS_LOADED", stats }))
          .catch(() => undefined);
      }
    }, 20_000);
    return () => clearInterval(timer);
  }, [state.offline, safeDispatch]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await loadResources(clientRef.current, { selectFirst: !state.selectedIncidentId });
      setLastSyncedAt(new Date().toISOString());
      safeDispatch({ type: "ERROR", error: null });
    } catch (error) {
      safeDispatch({ type: "ERROR", error: errorMessage(error) });
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [loadResources, safeDispatch, state.selectedIncidentId]);

  const selectIncident = useCallback(
    async (incidentId: string) => {
      try {
        const detail = await clientRef.current.getIncident(incidentId);
        safeDispatch({ type: "INCIDENT_SELECTED", incident: detail });
      } catch (error) {
        safeDispatch({ type: "ERROR", error: errorMessage(error) });
      }
    },
    [safeDispatch],
  );

  const injectChaos = useCallback(
    async (scenarioId: string) => {
      safeDispatch({ type: "CHAOS_INJECTION_STARTED", scenarioId, total: 1, startedAt: new Date().toISOString() });
      try {
        const response: ChaosInjectResponse = await clientRef.current.injectChaos(scenarioId);
        const firstReport = response.reports[0];
        if (firstReport) {
          safeDispatch({ type: "INCIDENT_SELECTED", incident: firstReport });
        }
        safeDispatch({ type: "CHAOS_COMPLETED", evaluation: response.evaluation, receivedAt: new Date().toISOString() });
        await loadResources(clientRef.current, { selectFirst: false });
      } catch (error) {
        safeDispatch({ type: "CHAOS_FAILED", message: errorMessage(error) });
      }
    },
    [loadResources, safeDispatch],
  );

  const streamAllChaos = useCallback(() => {
    streamRef.current?.close();
    safeDispatch({ type: "CHAOS_INJECTION_STARTED", scenarioId: "all", total: 24, startedAt: new Date().toISOString() });
    const handle = clientRef.current.openChaosStream("all", {
      onEvent: (envelope) => {
        const receivedAt = new Date().toISOString();
        const action = sseEnvelopeToAction(envelope, receivedAt);
        if (action !== null) {
          safeDispatch(action);
        }
        if (envelope.event === "incident.triaged" && envelope.data.report) {
          // Keep the visualiser glued to the most recent scenario as it streams.
          const report = envelope.data.report;
          if (typeof report === "object" && report !== null && "incident_id" in report) {
            const candidate = report as unknown as { incident_id: string };
            if (typeof candidate.incident_id === "string") {
              void clientRef.current
                .getIncident(candidate.incident_id)
                .then((detail) => safeDispatch({ type: "INCIDENT_SELECTED", incident: detail }))
                .catch(() => undefined);
            }
          }
        }
      },
      onError: (error) => {
        safeDispatch({ type: "CHAOS_FAILED", message: errorMessage(error) });
      },
      onClose: () => {
        void loadResources(clientRef.current, { selectFirst: false }).catch(() => undefined);
      },
    });
    streamRef.current = handle;
  }, [loadResources, safeDispatch]);

  const cancelChaos = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
    safeDispatch({ type: "CHAOS_FAILED", message: "Chaos stream cancelled by operator" });
  }, [safeDispatch]);

  const runDrDrill = useCallback(async () => {
    const incidentId = state.selectedIncidentId;
    safeDispatch({ type: "DR_DRILL_STARTED", incidentId, startedAt: new Date().toISOString() });
    try {
      const result = await clientRef.current.runDrDrill(incidentId);
      safeDispatch({ type: "DR_DRILL_COMPLETED", result, receivedAt: new Date().toISOString() });
      const verifications = await clientRef.current.listDrVerifications(50);
      safeDispatch({ type: "DR_VERIFICATIONS_LOADED", verifications: verifications.verifications });
      if (incidentId) {
        const detail = await clientRef.current.getIncident(incidentId);
        safeDispatch({ type: "INCIDENT_SELECTED", incident: detail });
      }
      const stats = await clientRef.current.stats();
      safeDispatch({ type: "STATS_LOADED", stats });
    } catch (error) {
      safeDispatch({ type: "DR_DRILL_FAILED", error: errorMessage(error) });
    }
  }, [safeDispatch, state.selectedIncidentId]);

  const changeFilter = useCallback(
    (patch: Partial<ConsoleFilters>) => {
      safeDispatch({ type: "FILTER_CHANGED", patch });
    },
    [safeDispatch],
  );

  const search = useCallback(
    (value: string) => {
      safeDispatch({ type: "SEARCH_CHANGED", search: value });
    },
    [safeDispatch],
  );

  const clearError = useCallback(() => {
    safeDispatch({ type: "ERROR", error: null });
  }, [safeDispatch]);

  const toggleOffline = useCallback(() => {
    const next = !state.offline;
    streamRef.current?.close();
    eventStreamRef.current?.close();
    if (next) {
      const offlineClient = SentinelApiClient.offline();
      clientRef.current = offlineClient;
      void bootstrap(offlineClient, true);
    } else {
      const liveClient = new SentinelApiClient({ baseUrl: API_BASE });
      clientRef.current = liveClient;
      void bootstrap(liveClient, false);
    }
  }, [bootstrap, state.offline]);

  return useMemo(
    () => ({
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
    }),
    [
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
    ],
  );
}
