/**
 * Deterministic Wait-For Graph layout & telemetry engine.
 *
 * Pure TypeScript (no React, no DOM, no `fetch`) so it is fully unit-testable under `bun test`.
 * The input is the materialised PostgreSQL `Wait-ForGraphPayload` returned by
 * `GET /api/v1/incidents/{id}`; the output is an SVG-ready scene graph with:
 *
 *  - stable 2-D coordinates for every `pg_stat_activity` backend,
 *  - cubic Bézier edge paths for every `pg_locks` waiter → blocker relationship,
 *  - crimson highlighting for circular deadlock cycles,
 *  - amber root-blocker badges / ranks for head-of-line `AccessExclusiveLock` chains,
 *  - critical lock-chain depth, fan-out and transaction-age metrics for the KPI strip.
 *
 * All layout maths is deterministic for a given payload + options (no randomness, no timestamps),
 * which makes the scene snapshot-testable and SSR-safe.
 */

import type {
  PgSessionNode,
  RootBlockerRef,
  WaitForGraphEdge,
  WaitForGraphPayload,
} from "../types/sentinel";

/* --------------------------------------------------------------------------------------------- */
/* Public types                                                                                   */
/* --------------------------------------------------------------------------------------------- */

export interface WfgLayoutOptions {
  width: number;
  height: number;
  padding: number;
  nodeRadius: number;
  innerRadius: number;
  outerRadiusX: number;
  outerRadiusY: number;
  curvature: number;
}

export const DEFAULT_WFG_LAYOUT_OPTIONS: WfgLayoutOptions = {
  width: 960,
  height: 620,
  padding: 96,
  nodeRadius: 25,
  innerRadius: 92,
  outerRadiusX: 330,
  outerRadiusY: 212,
  curvature: 0.16,
};

export type WfgPoint = { x: number; y: number };

export type WfgNodeTone = "healthy" | "waiting" | "root-blocker" | "cycle" | "external";

export interface WfgLayoutNode {
  pid: number;
  x: number;
  y: number;
  radius: number;
  label: string;
  applicationName: string;
  usename: string;
  state: string;
  lockMode: string;
  query: string;
  xactDurationSec: number;
  waitEventType: string | null;
  waitEvent: string | null;
  blockingPids: number[];
  isCycleMember: boolean;
  cycleIndex: number | null;
  isRootBlocker: boolean;
  rootBlockerRank: number | null;
  blockedCount: number;
  tone: WfgNodeTone;
  synthetic: boolean;
  depth: number;
}

export interface WfgLayoutEdge {
  id: string;
  waiterPid: number;
  blockerPid: number;
  path: string;
  source: WfgPoint;
  target: WfgPoint;
  labelPoint: WfgPoint;
  label: string;
  inCycle: boolean;
  cycleIndex: number | null;
  lockMode: string | null;
  waitEvent: string | null;
}

export interface WfgLayoutCycle {
  index: number;
  pids: number[];
  memberCount: number;
  color: string;
  centroid: WfgPoint;
  radius: number;
  label: string;
  lockModes: string[];
  maxXactDurationSec: number;
  pidsText: string;
}

export type WfgBadgeKind = "root-blocker" | "cycle" | "adversarial";

export interface WfgLayoutBadge {
  id: string;
  kind: WfgBadgeKind;
  label: string;
  pid: number | null;
  x: number;
  y: number;
  tone: "amber" | "crimson" | "violet";
}

export interface WfgLayoutMetrics {
  nodeCount: number;
  edgeCount: number;
  cycleCount: number;
  cycleMemberCount: number;
  rootBlockerCount: number;
  blockedSessionCount: number;
  blockingSessionCount: number;
  criticalChainDepth: number;
  criticalChainPids: number[];
  maxFanOut: number;
  widestBlockerPid: number | null;
  longestTransactionSec: number;
  longestTransactionPid: number | null;
  hotspotPid: number | null;
  hasDeadlock: boolean;
  hasAccessExclusiveBlocker: boolean;
  severity: "healthy" | "warning" | "critical";
  lockModes: string[];
}

export interface WaitForGraphLayout {
  width: number;
  height: number;
  isEmpty: boolean;
  nodes: WfgLayoutNode[];
  edges: WfgLayoutEdge[];
  cycles: WfgLayoutCycle[];
  badges: WfgLayoutBadge[];
  rootBlockers: RootBlockerRef[];
  metrics: WfgLayoutMetrics;
  payload: WaitForGraphPayload;
}

export interface WfgCycleDetectionResult {
  cycles: number[][];
  rootBlockers: RootBlockerRef[];
}

/* --------------------------------------------------------------------------------------------- */
/* Colour tokens (shared with the SVG renderer and legend)                                        */
/* --------------------------------------------------------------------------------------------- */

export const WFG_COLORS = {
  cycle: ["#f43f5e", "#fb7185", "#e11d48", "#f97316"],
  rootBlocker: "#fbbf24",
  waiting: "#38bdf8",
  healthy: "#34d399",
  external: "#a78bfa",
  edge: "#334155",
  edgeCycle: "#f43f5e",
  edgeHot: "#fbbf24",
  grid: "#16223a",
  ink: "#e7edf8",
  muted: "#8593ad",
} as const;

export function cycleColor(index: number): string {
  const palette = WFG_COLORS.cycle;
  return palette[index % palette.length] ?? WFG_COLORS.cycle[0]!;
}

/* --------------------------------------------------------------------------------------------- */
/* Small numeric helpers                                                                          */
/* --------------------------------------------------------------------------------------------- */

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function uniqueNumbers(values: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function cycleWithoutReturn(cycle: readonly number[]): number[] {
  if (cycle.length >= 2 && cycle[0] === cycle[cycle.length - 1]) {
    return cycle.slice(0, -1);
  }
  return [...cycle];
}

function point(x: number, y: number): WfgPoint {
  return { x: round2(x), y: round2(y) };
}

/* --------------------------------------------------------------------------------------------- */
/* Graph construction (mirrors sentinel/agents.py + sentinel/api.py)                              */
/* --------------------------------------------------------------------------------------------- */

/**
 * Depth-first search over `waiter -> blocker` adjacency, exactly matching the Python
 * `DatabaseStorageAgent._analyze_wait_for_graph` semantics: every back-edge to a node on the
 * current stack emits a closed cycle (first PID repeated at the end).
 */
export function detectDeadlockCycles(sessions: readonly PgSessionNode[]): number[][] {
  const adjacency = new Map<number, number[]>();
  for (const session of sessions) {
    adjacency.set(session.pid, [...session.blocking_pids]);
  }

  const visited = new Set<number>();
  const onStack = new Set<number>();
  const path: number[] = [];
  const cycles: number[][] = [];

  const walk = (pid: number): void => {
    visited.add(pid);
    onStack.add(pid);
    path.push(pid);
    for (const next of adjacency.get(pid) ?? []) {
      if (!visited.has(next)) {
        if (!adjacency.has(next)) {
          adjacency.set(next, []);
        }
        walk(next);
      } else if (onStack.has(next)) {
        const index = path.indexOf(next);
        if (index >= 0) {
          cycles.push([...path.slice(index), next]);
        }
      }
    }
    path.pop();
    onStack.delete(pid);
  };

  for (const pid of adjacency.keys()) {
    if (!visited.has(pid)) {
      walk(pid);
    }
  }
  return cycles;
}

/**
 * Identify head-of-line blockers: sessions that wait on nobody (`blocking_pids` empty) while at
 * least one other session waits on them. `blocked_count` is the transitive waiter count.
 */
export function detectRootBlockers(sessions: readonly PgSessionNode[]): RootBlockerRef[] {
  const byPid = new Map<number, PgSessionNode>();
  const reverse = new Map<number, number[]>();
  for (const session of sessions) {
    byPid.set(session.pid, session);
    if (!reverse.has(session.pid)) {
      reverse.set(session.pid, []);
    }
  }
  for (const session of sessions) {
    for (const blocker of session.blocking_pids) {
      const waiters = reverse.get(blocker) ?? [];
      waiters.push(session.pid);
      reverse.set(blocker, waiters);
    }
  }

  const rootBlockers: RootBlockerRef[] = [];
  for (const session of sessions) {
    if (session.blocking_pids.length > 0) {
      continue;
    }
    const direct = reverse.get(session.pid) ?? [];
    if (direct.length === 0) {
      continue;
    }
    const queue = [...direct];
    const seen = new Set<number>(queue);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        break;
      }
      for (const waiter of reverse.get(current) ?? []) {
        if (!seen.has(waiter)) {
          seen.add(waiter);
          queue.push(waiter);
        }
      }
    }
    rootBlockers.push({
      pid: session.pid,
      blocked_count: seen.size,
      state: session.state,
      lock_mode: session.lock_mode,
      xact_duration_sec: session.xact_duration_sec,
      query: session.query,
      application_name: session.application_name,
    });
  }

  rootBlockers.sort((a, b) => b.blocked_count - a.blocked_count || a.pid - b.pid);
  return rootBlockers;
}

/**
 * Build a complete `WaitForGraphPayload` from raw `pg_stat_activity` sessions. Used by the
 * offline demo dataset and by tests to reproduce what the Python API materialises at triage time.
 */
export function buildWaitForGraph(
  sessions: readonly PgSessionNode[],
  pgConnectionRatio = 0,
): WaitForGraphPayload {
  const cycles = detectDeadlockCycles(sessions);
  const rootBlockers = detectRootBlockers(sessions);
  const cycleMembers = new Set<number>(cycles.flat());
  const blockedCounts = new Map<number, number>(rootBlockers.map((ref) => [ref.pid, ref.blocked_count]));
  const byPid = new Map<number, PgSessionNode>(sessions.map((session) => [session.pid, session]));

  const nodes: PgSessionNode[] = sessions.map((session) => ({
    ...session,
    blocking_pids: [...session.blocking_pids],
    is_cycle_member: cycleMembers.has(session.pid),
    is_root_blocker: blockedCounts.has(session.pid),
    blocked_count: blockedCounts.get(session.pid) ?? 0,
  }));

  const edges: WaitForGraphEdge[] = [];
  for (const session of sessions) {
    for (const blockerPid of session.blocking_pids) {
      const blocker = byPid.get(blockerPid);
      edges.push({
        waiter_pid: session.pid,
        blocker_pid: blockerPid,
        waiter_application: session.application_name,
        blocker_application: blocker?.application_name ?? null,
        lock_mode: blocker?.lock_mode ?? null,
        wait_event: session.wait_event,
        wait_event_type: session.wait_event_type,
      });
    }
  }

  return {
    nodes,
    edges,
    deadlock_cycles: cycles,
    root_blockers: rootBlockers,
    deadlock_cycles_found: cycles.length,
    root_blocker_pids: rootBlockers.map((ref) => ref.pid),
    pg_connection_ratio: round2(pgConnectionRatio),
    lock_evidence: [],
    source: "client-reconstruction",
  };
}

/** Coerce a possibly-partial payload into the full shape the layout engine expects. */
export function normalizeWaitForGraph(
  payload: Partial<WaitForGraphPayload> | null | undefined,
): WaitForGraphPayload {
  if (!payload) {
    return {
      nodes: [],
      edges: [],
      deadlock_cycles: [],
      root_blockers: [],
      deadlock_cycles_found: 0,
      root_blocker_pids: [],
      pg_connection_ratio: 0,
      lock_evidence: [],
    };
  }
  const nodes = Array.isArray(payload.nodes) ? payload.nodes.map((node) => ({ ...node })) : [];
  const edges = Array.isArray(payload.edges)
    ? payload.edges.map((edge) => ({ ...edge }))
    : nodes.flatMap((node) =>
        node.blocking_pids.map((blockerPid) => ({
          waiter_pid: node.pid,
          blocker_pid: blockerPid,
          waiter_application: node.application_name,
          blocker_application: null,
          lock_mode: null,
          wait_event: node.wait_event,
          wait_event_type: node.wait_event_type,
        })),
      );
  const cycles = Array.isArray(payload.deadlock_cycles) ? payload.deadlock_cycles.map((c) => [...c]) : [];
  const rootBlockers = Array.isArray(payload.root_blockers) ? payload.root_blockers.map((r) => ({ ...r })) : [];
  return {
    nodes,
    edges,
    deadlock_cycles: cycles,
    root_blockers: rootBlockers,
    deadlock_cycles_found:
      typeof payload.deadlock_cycles_found === "number" ? payload.deadlock_cycles_found : cycles.length,
    root_blocker_pids:
      Array.isArray(payload.root_blocker_pids) && payload.root_blocker_pids.length > 0
        ? [...payload.root_blocker_pids]
        : rootBlockers.map((ref) => ref.pid),
    pg_connection_ratio: typeof payload.pg_connection_ratio === "number" ? payload.pg_connection_ratio : 0,
    lock_evidence: Array.isArray(payload.lock_evidence) ? [...payload.lock_evidence] : [],
    ...(payload.source === undefined ? {} : { source: payload.source }),
  };
}

/* --------------------------------------------------------------------------------------------- */
/* Bézier path construction                                                                       */
/* --------------------------------------------------------------------------------------------- */

/**
 * Cubic Bézier path between two node centres. Reciprocal edges (A→B and B→A, the signature of a
 * two-node deadlock) bow in opposite directions so both arrows remain visible.
 */
export function buildBezierPath(
  source: WfgPoint,
  target: WfgPoint,
  curvature = DEFAULT_WFG_LAYOUT_OPTIONS.curvature,
  reciprocal = false,
  sourcePid = 0,
): string {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  const direction = reciprocal ? (sourcePid % 2 === 0 ? 1 : -1) : 1;
  const offset = clamp(length * curvature, 10, 72) * direction;
  const c1 = point(source.x + dx * 0.34 + nx * offset, source.y + dy * 0.34 + ny * offset);
  const c2 = point(source.x + dx * 0.66 + nx * offset, source.y + dy * 0.66 + ny * offset);
  return `M ${round2(source.x)} ${round2(source.y)} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${round2(target.x)} ${round2(target.y)}`;
}

function bezierLabelPoint(source: WfgPoint, target: WfgPoint, curvature: number): WfgPoint {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  const offset = clamp(length * curvature, 10, 72);
  return point(
    source.x + dx * 0.5 + nx * offset * 0.75,
    source.y + dy * 0.5 + ny * offset * 0.75,
  );
}

/* --------------------------------------------------------------------------------------------- */
/* Layout                                                                                         */
/* --------------------------------------------------------------------------------------------- */

interface NodeSeed {
  pid: number;
  applicationName: string;
  usename: string;
  state: string;
  lockMode: string;
  query: string;
  xactDurationSec: number;
  waitEventType: string | null;
  waitEvent: string | null;
  blockingPids: number[];
  cycleIndex: number | null;
  isRootBlocker: boolean;
  rootBlockerRank: number | null;
  blockedCount: number;
  synthetic: boolean;
}

function seedFromNode(node: PgSessionNode): NodeSeed {
  return {
    pid: node.pid,
    applicationName: node.application_name,
    usename: node.usename,
    state: node.state,
    lockMode: node.lock_mode,
    query: node.query,
    xactDurationSec: node.xact_duration_sec,
    waitEventType: node.wait_event_type,
    waitEvent: node.wait_event,
    blockingPids: [...node.blocking_pids],
    cycleIndex: null,
    isRootBlocker: node.is_root_blocker === true,
    rootBlockerRank: null,
    blockedCount: node.blocked_count ?? 0,
    synthetic: false,
  };
}

function seedFromPid(pid: number): NodeSeed {
  return {
    pid,
    applicationName: "external-session",
    usename: "unknown",
    state: "unknown",
    lockMode: "unknown",
    query: "Session not present in pg_stat_activity snapshot",
    xactDurationSec: 0,
    waitEventType: null,
    waitEvent: null,
    blockingPids: [],
    cycleIndex: null,
    isRootBlocker: false,
    rootBlockerRank: null,
    blockedCount: 0,
    synthetic: true,
  };
}

function computeDepths(
  seeds: ReadonlyMap<number, NodeSeed>,
  edges: readonly WaitForGraphEdge[],
): Map<number, number> {
  // Reverse adjacency: blocker -> direct waiters. Roots are nodes that block while waiting on none.
  const reverse = new Map<number, number[]>();
  const hasInbound = new Set<number>();
  for (const edge of edges) {
    const waiters = reverse.get(edge.blocker_pid) ?? [];
    waiters.push(edge.waiter_pid);
    reverse.set(edge.blocker_pid, waiters);
    hasInbound.add(edge.waiter_pid);
  }

  const depths = new Map<number, number>();
  const queue: number[] = [];
  for (const seed of seeds.values()) {
    if (seed.blockingPids.length === 0 || !hasInbound.has(seed.pid)) {
      if (!hasInbound.has(seed.pid)) {
        depths.set(seed.pid, 0);
        queue.push(seed.pid);
      }
    }
  }
  // Ensure at least one source exists even for pure cycles.
  if (queue.length === 0) {
    for (const pid of seeds.keys()) {
      depths.set(pid, 0);
      queue.push(pid);
      break;
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const depth = depths.get(current) ?? 0;
    for (const waiter of reverse.get(current) ?? []) {
      const next = depth + 1;
      const existing = depths.get(waiter);
      if (existing === undefined || next < existing) {
        depths.set(waiter, next);
        queue.push(waiter);
      }
    }
  }

  for (const pid of seeds.keys()) {
    if (!depths.has(pid)) {
      depths.set(pid, 0);
    }
  }
  return depths;
}

function placeRadial(
  seeds: ReadonlyMap<number, NodeSeed>,
  cycles: readonly number[][],
  depths: ReadonlyMap<number, number>,
  options: WfgLayoutOptions,
): Map<number, WfgPoint> {
  const positions = new Map<number, WfgPoint>();
  const center = point(options.width / 2, options.height / 2 + 4);
  const cycleOrder = uniqueNumbers(cycles.flatMap((cycle) => cycleWithoutReturn(cycle)));
  const cycleSet = new Set(cycleOrder);
  const otherPids = [...seeds.keys()]
    .filter((pid) => !cycleSet.has(pid))
    .sort((a, b) => (depths.get(a) ?? 0) - (depths.get(b) ?? 0) || a - b);

  const innerRadius = Math.max(options.innerRadius, cycleOrder.length * 34);
  cycleOrder.forEach((pid, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(cycleOrder.length, 1)) * Math.PI * 2;
    positions.set(pid, point(center.x + Math.cos(angle) * innerRadius, center.y + Math.sin(angle) * innerRadius));
  });

  if (otherPids.length === 1) {
    const only = otherPids[0];
    if (only !== undefined) {
      positions.set(only, point(center.x + options.outerRadiusX * 0.46, center.y - options.outerRadiusY * 0.5));
    }
    return positions;
  }

  const count = otherPids.length;
  const start = -Math.PI / 2 + Math.PI / Math.max(count, 1);
  otherPids.forEach((pid, index) => {
    const angle = start + (index / Math.max(count, 1)) * Math.PI * 2;
    const scale = 1 + (depths.get(pid) ?? 0) * 0.035;
    positions.set(
      pid,
      point(
        center.x + Math.cos(angle) * options.outerRadiusX * scale,
        center.y + Math.sin(angle) * options.outerRadiusY * scale,
      ),
    );
  });
  return positions;
}

function placeLayered(
  seeds: ReadonlyMap<number, NodeSeed>,
  depths: ReadonlyMap<number, number>,
  options: WfgLayoutOptions,
): Map<number, WfgPoint> {
  const positions = new Map<number, WfgPoint>();
  const layers = new Map<number, number[]>();
  for (const pid of seeds.keys()) {
    const depth = depths.get(pid) ?? 0;
    const bucket = layers.get(depth) ?? [];
    bucket.push(pid);
    layers.set(depth, bucket);
  }
  const depthKeys = [...layers.keys()].sort((a, b) => a - b);
  const usableWidth = options.width - options.padding * 2;
  const usableHeight = options.height - options.padding * 2;

  depthKeys.forEach((depth, layerIndex) => {
    const pids = (layers.get(depth) ?? []).sort((a, b) => a - b);
    const x =
      depthKeys.length === 1
        ? options.width / 2
        : options.padding + (layerIndex / (depthKeys.length - 1)) * usableWidth;
    pids.forEach((pid, rowIndex) => {
      const y =
        pids.length === 1
          ? options.height / 2
          : options.padding + ((rowIndex + 1) / (pids.length + 1)) * usableHeight;
      positions.set(pid, point(x, y));
    });
  });

  // Any node omitted by depth bucketing (defensive) is parked deterministically at the centre.
  for (const pid of seeds.keys()) {
    if (!positions.has(pid)) {
      positions.set(pid, point(options.width / 2, options.height / 2));
    }
  }
  return positions;
}

function longestChain(
  seeds: ReadonlyMap<number, NodeSeed>,
  reverse: ReadonlyMap<number, number[]>,
  cycleMembers: ReadonlySet<number>,
): { depth: number; pids: number[] } {
  const memo = new Map<number, { depth: number; pids: number[] }>();

  const walk = (pid: number, visiting: Set<number>): { depth: number; pids: number[] } => {
    const cached = memo.get(pid);
    if (cached) {
      return cached;
    }
    if (cycleMembers.has(pid) || visiting.has(pid)) {
      return { depth: 0, pids: [] };
    }
    visiting.add(pid);
    let best: { depth: number; pids: number[] } = { depth: 1, pids: [pid] };
    for (const waiter of reverse.get(pid) ?? []) {
      const child = walk(waiter, visiting);
      if (child.depth + 1 > best.depth) {
        best = { depth: child.depth + 1, pids: [pid, ...child.pids] };
      }
    }
    visiting.delete(pid);
    memo.set(pid, best);
    return best;
  };

  let best: { depth: number; pids: number[] } = { depth: 0, pids: [] };
  for (const pid of seeds.keys()) {
    if (cycleMembers.has(pid)) {
      continue;
    }
    const chain = walk(pid, new Set<number>());
    if (chain.depth > best.depth) {
      best = chain;
    }
  }
  return best;
}

/**
 * Compute the complete SVG scene graph. Empty payloads return a valid, renderable empty scene.
 */
export function layoutWaitForGraph(
  input: Partial<WaitForGraphPayload> | null | undefined,
  overrides: Partial<WfgLayoutOptions> = {},
): WaitForGraphLayout {
  const options: WfgLayoutOptions = { ...DEFAULT_WFG_LAYOUT_OPTIONS, ...overrides };
  const payload = normalizeWaitForGraph(input);

  const seeds = new Map<number, NodeSeed>();
  for (const node of payload.nodes) {
    seeds.set(node.pid, seedFromNode(node));
  }
  for (const edge of payload.edges) {
    if (!seeds.has(edge.waiter_pid)) {
      seeds.set(edge.waiter_pid, seedFromPid(edge.waiter_pid));
    }
    if (!seeds.has(edge.blocker_pid)) {
      seeds.set(edge.blocker_pid, seedFromPid(edge.blocker_pid));
    }
  }

  // Normalise cycles, retain only members present in the graph, and annotate cycle membership.
  const cycles = payload.deadlock_cycles
    .map(cycleWithoutReturn)
    .filter((cycle) => cycle.length >= 2)
    .map((cycle) => uniqueNumbers(cycle))
    .filter((cycle) => cycle.every((pid) => seeds.has(pid)));
  const cycleIndexByPid = new Map<number, number>();
  cycles.forEach((cycle, index) => {
    for (const pid of cycle) {
      const seed = seeds.get(pid);
      if (seed && seed.cycleIndex === null) {
        seed.cycleIndex = index;
      }
      if (!cycleIndexByPid.has(pid)) {
        cycleIndexByPid.set(pid, index);
      }
    }
  });
  const cycleMembers = new Set<number>(cycleIndexByPid.keys());

  // Root blockers: trust the API payload, then top up from the graph structure.
  const rootBlockers = [...payload.root_blockers].sort(
    (a, b) => b.blocked_count - a.blocked_count || a.pid - b.pid,
  );
  for (const ref of rootBlockers) {
    const seed = seeds.get(ref.pid);
    if (seed) {
      seed.isRootBlocker = true;
      seed.blockedCount = Math.max(seed.blockedCount, ref.blocked_count);
    }
  }
  const computedRoots = detectRootBlockers(
    [...seeds.values()].map((seed) => ({
      pid: seed.pid,
      usename: seed.usename,
      application_name: seed.applicationName,
      state: seed.state,
      wait_event_type: seed.waitEventType,
      wait_event: seed.waitEvent,
      blocking_pids: seed.blockingPids,
      query: seed.query,
      xact_duration_sec: seed.xactDurationSec,
      lock_mode: seed.lockMode,
    })),
  );
  for (const ref of computedRoots) {
    const seed = seeds.get(ref.pid);
    if (!seed) {
      continue;
    }
    seed.isRootBlocker = true;
    seed.blockedCount = Math.max(seed.blockedCount, ref.blocked_count);
    if (!rootBlockers.some((existing) => existing.pid === ref.pid)) {
      rootBlockers.push(ref);
    }
  }
  rootBlockers.sort((a, b) => b.blocked_count - a.blocked_count || a.pid - b.pid);
  const rankByPid = new Map<number, number>(rootBlockers.map((ref, index) => [ref.pid, index + 1]));
  for (const seed of seeds.values()) {
    seed.rootBlockerRank = rankByPid.get(seed.pid) ?? null;
  }

  const depths = computeDepths(seeds, payload.edges);
  const positions =
    cycles.length > 0 ? placeRadial(seeds, cycles, depths, options) : placeLayered(seeds, depths, options);

  const nodeByPid = new Map<number, WfgLayoutNode>();
  const layoutNodes: WfgLayoutNode[] = [];
  for (const seed of seeds.values()) {
    const position = positions.get(seed.pid) ?? point(options.width / 2, options.height / 2);
    const tone: WfgNodeTone = seed.cycleIndex !== null
      ? "cycle"
      : seed.isRootBlocker
        ? "root-blocker"
        : seed.synthetic
          ? "external"
          : seed.blockingPids.length > 0
            ? "waiting"
            : "healthy";
    const node: WfgLayoutNode = {
      pid: seed.pid,
      x: position.x,
      y: position.y,
      radius: options.nodeRadius,
      label: String(seed.pid),
      applicationName: seed.applicationName,
      usename: seed.usename,
      state: seed.state,
      lockMode: seed.lockMode,
      query: seed.query,
      xactDurationSec: seed.xactDurationSec,
      waitEventType: seed.waitEventType,
      waitEvent: seed.waitEvent,
      blockingPids: seed.blockingPids,
      isCycleMember: seed.cycleIndex !== null,
      cycleIndex: seed.cycleIndex,
      isRootBlocker: seed.isRootBlocker,
      rootBlockerRank: seed.rootBlockerRank,
      blockedCount: seed.blockedCount,
      tone,
      synthetic: seed.synthetic,
      depth: depths.get(seed.pid) ?? 0,
    };
    nodeByPid.set(seed.pid, node);
    layoutNodes.push(node);
  }
  layoutNodes.sort((a, b) => a.pid - b.pid);

  // Reciprocal edge pairs need opposing curvature.
  const pairKeys = new Set(
    payload.edges.map((edge) => `${Math.min(edge.waiter_pid, edge.blocker_pid)}:${Math.max(edge.waiter_pid, edge.blocker_pid)}`),
  );
  const edgeSeen = new Map<string, number>();
  const layoutEdges: WfgLayoutEdge[] = payload.edges.map((edge, index) => {
    const sourceNode = nodeByPid.get(edge.waiter_pid);
    const targetNode = nodeByPid.get(edge.blocker_pid);
    const source = sourceNode ? point(sourceNode.x, sourceNode.y) : point(0, 0);
    const target = targetNode ? point(targetNode.x, targetNode.y) : point(0, 0);
    const pairKey = `${Math.min(edge.waiter_pid, edge.blocker_pid)}:${Math.max(edge.waiter_pid, edge.blocker_pid)}`;
    const occurrences = (edgeSeen.get(pairKey) ?? 0) + 1;
    edgeSeen.set(pairKey, occurrences);
    const reciprocal = pairKeys.has(pairKey) && edge.waiter_pid !== edge.blocker_pid;
    const cycleIndex = cycleIndexByPid.get(edge.waiter_pid);
    const inCycle =
      edge.waiter_pid !== edge.blocker_pid &&
      cycleIndex !== undefined &&
      cycleIndexByPid.get(edge.blocker_pid) === cycleIndex;
    const curvature = reciprocal ? options.curvature * 1.6 : options.curvature;
    const path =
      edge.waiter_pid === edge.blocker_pid
        ? loopPath(source, options.nodeRadius)
        : buildBezierPath(source, target, curvature, reciprocal, edge.waiter_pid + occurrences);
    const labelPoint = edge.waiter_pid === edge.blocker_pid
      ? point(source.x, source.y - options.nodeRadius - 26)
      : bezierLabelPoint(source, target, curvature);
    return {
      id: `wfg-edge-${index}-${edge.waiter_pid}-${edge.blocker_pid}`,
      waiterPid: edge.waiter_pid,
      blockerPid: edge.blocker_pid,
      path,
      source,
      target,
      labelPoint,
      label: `${edge.waiter_pid} → ${edge.blocker_pid}`,
      inCycle,
      cycleIndex: inCycle ? cycleIndex : null,
      lockMode: edge.lock_mode ?? targetNode?.lockMode ?? null,
      waitEvent: edge.wait_event ?? null,
    };
  });

  const layoutCycles: WfgLayoutCycle[] = cycles.map((pids, index) => {
    const members = pids.map((pid) => nodeByPid.get(pid)).filter((node): node is WfgLayoutNode => node !== undefined);
    const centroid = centroidOf(members);
    const radius = Math.max(
      options.innerRadius * 0.9,
      ...members.map((node) => Math.hypot(node.x - centroid.x, node.y - centroid.y)),
    );
    const lockModes = uniqueStrings(members.map((node) => node.lockMode));
    return {
      index,
      pids,
      memberCount: pids.length,
      color: cycleColor(index),
      centroid,
      radius: round2(radius + options.nodeRadius),
      label: `DEADLOCK #${index + 1}`,
      lockModes,
      maxXactDurationSec: Math.max(0, ...members.map((node) => node.xactDurationSec)),
      pidsText: [...pids, pids[0]].filter((pid) => pid !== undefined).join(" → "),
    };
  });

  const badges: WfgLayoutBadge[] = [];
  for (const ref of rootBlockers) {
    const node = nodeByPid.get(ref.pid);
    if (!node) {
      continue;
    }
    const rank = rankByPid.get(ref.pid) ?? 1;
    badges.push({
      id: `badge-root-${ref.pid}`,
      kind: "root-blocker",
      label: `RB#${rank} · ${ref.lock_mode}`,
      pid: ref.pid,
      x: node.x,
      y: round2(node.y - options.nodeRadius - 14),
      tone: "amber",
    });
  }
  for (const cycle of layoutCycles) {
    badges.push({
      id: `badge-cycle-${cycle.index}`,
      kind: "cycle",
      label: cycle.label,
      pid: cycle.pids[0] ?? null,
      x: cycle.centroid.x,
      y: round2(cycle.centroid.y - cycle.radius - 16),
      tone: "crimson",
    });
  }

  const reverse = new Map<number, number[]>();
  for (const edge of payload.edges) {
    const waiters = reverse.get(edge.blocker_pid) ?? [];
    waiters.push(edge.waiter_pid);
    reverse.set(edge.blocker_pid, waiters);
  }
  const chain = longestChain(seeds, reverse, cycleMembers);
  const cycleDepth = Math.max(0, ...cycles.map((cycle) => cycle.length));
  const criticalChainDepth = Math.max(chain.depth, cycleDepth);
  const criticalChainPids =
    chain.pids.length > 0 ? chain.pids : (cycles[0] ?? []).length > 0 ? [...(cycles[0] ?? [])] : [];
  const maxFanOut = Math.max(0, ...rootBlockers.map((ref) => ref.blocked_count));
  const widest = rootBlockers.find((ref) => ref.blocked_count === maxFanOut);
  const longestTransaction = layoutNodes.reduce<WfgLayoutNode | null>(
    (best, node) => (best === null || node.xactDurationSec > best.xactDurationSec ? node : best),
    null,
  );
  const hotspot = rootBlockers[0]?.pid ?? layoutCycles[0]?.pids[0] ?? longestTransaction?.pid ?? null;
  const lockModes = uniqueStrings(layoutNodes.map((node) => node.lockMode));
  const hasAccessExclusiveBlocker = rootBlockers.some(
    (ref) => ref.lock_mode === "AccessExclusiveLock" || ref.lock_mode === "AccessExclusiveLock ",
  );
  const severity: WfgLayoutMetrics["severity"] =
    layoutCycles.length > 0
      ? "critical"
      : hasAccessExclusiveBlocker || rootBlockers.length > 0
        ? "warning"
        : layoutNodes.length > 0
          ? "healthy"
          : "healthy";

  return {
    width: options.width,
    height: options.height,
    isEmpty: layoutNodes.length === 0,
    nodes: layoutNodes,
    edges: layoutEdges,
    cycles: layoutCycles,
    badges,
    rootBlockers,
    metrics: {
      nodeCount: layoutNodes.length,
      edgeCount: layoutEdges.length,
      cycleCount: layoutCycles.length,
      cycleMemberCount: cycleMembers.size,
      rootBlockerCount: rootBlockers.length,
      blockedSessionCount: layoutNodes.filter((node) => node.blockingPids.length > 0).length,
      blockingSessionCount: layoutNodes.filter((node) => node.blockedCount > 0).length,
      criticalChainDepth,
      criticalChainPids,
      maxFanOut,
      widestBlockerPid: widest?.pid ?? null,
      longestTransactionSec: longestTransaction?.xactDurationSec ?? 0,
      longestTransactionPid: longestTransaction?.pid ?? null,
      hotspotPid: hotspot,
      hasDeadlock: layoutCycles.length > 0,
      hasAccessExclusiveBlocker,
      severity,
      lockModes,
    },
    payload,
  };
}

function loopPath(source: WfgPoint, radius: number): string {
  const r = radius * 0.9;
  return `M ${round2(source.x)} ${round2(source.y - r)} C ${round2(source.x + r * 1.8)} ${round2(source.y - r * 1.9)}, ${round2(source.x + r * 1.8)} ${round2(source.y + r * 0.4)}, ${round2(source.x)} ${round2(source.y + r)}`;
}

function centroidOf(nodes: readonly WfgLayoutNode[]): WfgPoint {
  if (nodes.length === 0) {
    return point(0, 0);
  }
  const sum = nodes.reduce((acc, node) => ({ x: acc.x + node.x, y: acc.y + node.y }), { x: 0, y: 0 });
  return point(sum.x / nodes.length, sum.y / nodes.length);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/* --------------------------------------------------------------------------------------------- */
/* Presentation helpers                                                                           */
/* --------------------------------------------------------------------------------------------- */

export interface WfgNarrative {
  headline: string;
  detail: string;
  tone: "healthy" | "warning" | "critical";
}

/** Human-readable explanation rendered above the SVG canvas. */
export function describeWaitForGraph(layout: WaitForGraphLayout): WfgNarrative {
  const m = layout.metrics;
  if (layout.isEmpty) {
    return {
      headline: "No PostgreSQL lock contention observed",
      detail: "pg_locks returned no waiter → blocker edges for this incident snapshot.",
      tone: "healthy",
    };
  }
  if (m.hasDeadlock && m.rootBlockerCount > 0) {
    return {
      headline: `${m.cycleCount} circular deadlock${m.cycleCount === 1 ? "" : "s"} + ${m.rootBlockerCount} head-of-line blocker${m.rootBlockerCount === 1 ? "" : "s"}`,
      detail: `Critical chain depth ${m.criticalChainDepth}; widest blocker PID ${m.widestBlockerPid ?? "n/a"} fans out to ${m.maxFanOut} transactions.`,
      tone: "critical",
    };
  }
  if (m.hasDeadlock) {
    return {
      headline: `${m.cycleCount} circular deadlock${m.cycleCount === 1 ? "" : "s"} detected across ${m.cycleMemberCount} backends`,
      detail: `Cycles: ${layout.cycles.map((cycle) => cycle.pidsText).join(" · ")}. Transactions must be aborted to break the cycle.`,
      tone: "critical",
    };
  }
  if (m.rootBlockerCount > 0) {
    const blocker = layout.rootBlockers[0];
    return {
      headline: `${blocker?.lock_mode ?? "Lock"} head-of-line blocker PID ${blocker?.pid ?? "n/a"}`,
      detail: `Blocking ${m.maxFanOut} downstream transaction${m.maxFanOut === 1 ? "" : "s"} for ${blocker?.xact_duration_sec.toFixed(1) ?? "0.0"}s; critical chain depth ${m.criticalChainDepth}.`,
      tone: "warning",
    };
  }
  return {
    headline: `${m.edgeCount} lock wait edge${m.edgeCount === 1 ? "" : "s"} across ${m.nodeCount} backends`,
    detail: `No circular dependency detected; longest lock chain is ${m.criticalChainDepth} transaction${m.criticalChainDepth === 1 ? "" : "s"} deep.`,
    tone: "warning",
  };
}

/** Compact one-line summary used by the KPI strip and incident queue. */
export function summarizeWaitForGraph(layout: WaitForGraphLayout): string {
  const m = layout.metrics;
  if (m.nodeCount === 0) {
    return "no pg_locks contention";
  }
  const parts = [`${m.nodeCount} sessions`, `${m.edgeCount} waits`];
  if (m.cycleCount > 0) {
    parts.push(`${m.cycleCount} deadlock${m.cycleCount === 1 ? "" : "s"}`);
  }
  if (m.rootBlockerCount > 0) {
    parts.push(`${m.rootBlockerCount} root blocker${m.rootBlockerCount === 1 ? "" : "s"}`);
  }
  parts.push(`depth ${m.criticalChainDepth}`);
  return parts.join(" · ");
}
