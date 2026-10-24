"use client";

import type { DrRestoreResult, DrVerificationRow, IncidentDetailResponse } from "../types/sentinel";
import { runbookById } from "../lib/runbooks";
import {
  categoryAccent,
  categoryLabel,
  cn,
  formatCommandCount,
  formatDigest,
  formatLatency,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  toneClasses,
} from "../lib/format";
import { ActionButton, Badge, CodeChip, EmptyState, KeyValue, Panel, PanelHeader, Spinner } from "./ui";
import {
  AlertTriangleIcon,
  CheckIcon,
  DatabaseIcon,
  LockIcon,
  ShieldIcon,
  SparkIcon,
  TerminalIcon,
} from "./icons";

export interface GuardrailAndDrAuditPanelProps {
  incident: IncidentDetailResponse | null;
  verifications: DrVerificationRow[];
  drilling: boolean;
  drillResult: DrRestoreResult | null;
  drillError: string | null;
  onRunDrill: () => void;
}

export function GuardrailAndDrAuditPanel({
  incident,
  verifications,
  drilling,
  drillResult,
  drillError,
  onRunDrill,
}: GuardrailAndDrAuditPanelProps) {
  if (!incident) {
    return (
      <Panel id="guardrail-dr-audit">
        <PanelHeader
          eyebrow="Zero-trust guardrail"
          title="Guardrail & DR Audit"
          subtitle="Every candidate command passes through the shlex read-only allowlist before execution; stateful incidents trigger a cryptographic restore verification drill."
          icon={<ShieldIcon size={17} />}
          tone="success"
        />
        <div className="px-5 pb-5 pt-4">
          <EmptyState
            title="Waiting for an incident"
            detail="Select an incident to inspect the cited runbook, approved read-only diagnostics, blocked destructive commands and the SHA-256 DR restore digest."
            icon={<ShieldIcon size={22} />}
          />
        </div>
      </Panel>
    );
  }

  const runbook = runbookById(incident.cited_runbook_id);
  const audit = incident.guardrail_audit_log ?? [];
  const latestDr = drillResult ?? incident.dr_drill_result;
  const history = verifications.length > 0 ? verifications : incident.dr_verifications ?? [];
  const blockedCount = Math.max(incident.blocked_unsafe_commands.length, audit.filter((entry) => entry.blocked_command !== null).length);
  const injectionBlocked = incident.prompt_injection_neutralized;

  return (
    <Panel tone="accent" id="guardrail-dr-audit">
      <PanelHeader
        eyebrow="Zero-trust guardrail · cryptographic DR"
        title="Guardrail & DR Audit"
        subtitle={`${incident.incident_id} · ${incident.service} · ${incident.namespace}`}
        icon={<ShieldIcon size={17} />}
        tone={injectionBlocked ? "critical" : "success"}
        actions={
          <>
            <Badge tone={injectionBlocked ? "critical" : "success"} dot>
              {injectionBlocked ? "injection neutralized" : "clean telemetry"}
            </Badge>
            <Badge tone="neutral">{formatCommandCount(blockedCount)} blocked</Badge>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 px-5 pb-5 pt-4 xl:grid-cols-2">
        <section className="rounded-xl border border-sky-500/20 bg-sky-500/[0.035] p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-sky-400/25 bg-sky-400/10 text-sky-200">
                <SparkIcon size={15} />
              </span>
              <div>
                <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-sky-300/60">Cited runbook</p>
                <p className="mt-0.5 font-mono text-xs font-semibold text-sky-100">{incident.cited_runbook_id}</p>
              </div>
            </div>
            <span className={cn("rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", categoryAccent(incident.diagnosed_category))}>
              {categoryLabel(incident.diagnosed_category)}
            </span>
          </div>

          <h3 className="mt-2.5 text-xs font-semibold leading-relaxed text-slate-100">
            {runbook?.title ?? incident.cited_runbook_title}
          </h3>
          <p className="mt-1 text-[10px] text-slate-500">
            Hybrid BM25 + TF-IDF cosine + RRF fusion · confidence {formatPercent(incident.confidence)}
          </p>

          <div className="mt-3">
            <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-600">Remediation steps</p>
            <ol className="space-y-1.5">
              {(runbook?.remediation ?? []).map((step, index) => (
                <li key={index} className="flex gap-2 text-[11px] leading-relaxed text-slate-400">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-sky-400/20 bg-sky-400/10 font-mono text-[9px] text-sky-200">
                    {index + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge tone="success">
              <CheckIcon size={10} />
              category match
            </Badge>
            <Badge tone="info">top-1 RRF</Badge>
            <Badge tone="neutral">{incident.approved_readonly_commands.length} approved cmds</Badge>
          </div>
        </section>

        <section className="rounded-xl border border-white/[0.07] bg-black/20 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <TerminalIcon size={14} className="text-slate-400" />
              <p className="text-[11px] font-semibold text-slate-200">shlex command guardrail</p>
            </div>
            <Badge tone={blockedCount > 0 ? "warning" : "success"}>{blockedCount > 0 ? "destructive blocked" : "all read-only"}</Badge>
          </div>

          <div className="mt-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-emerald-300/70">
              <CheckIcon size={10} /> Approved read-only
            </p>
            <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
              {incident.approved_readonly_commands.length === 0 ? (
                <p className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-[10px] text-slate-500">
                  No commands approved for this incident.
                </p>
              ) : (
                incident.approved_readonly_commands.map((command) => (
                  <CodeChip key={command} tone="safe" title={command}>
                    {command}
                  </CodeChip>
                ))
              )}
            </div>
          </div>

          <div className="mt-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-rose-300/70">
              <LockIcon size={10} /> Blocked destructive
            </p>
            <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
              {incident.blocked_unsafe_commands.length === 0 && audit.length === 0 ? (
                <p className="rounded-lg border border-emerald-500/15 bg-emerald-500/[0.03] px-2.5 py-2 text-[10px] text-emerald-200/60">
                  No destructive command attempted.
                </p>
              ) : (
                <>
                  {incident.blocked_unsafe_commands.map((command) => (
                    <CodeChip key={command} tone="blocked" title={command}>
                      {command}
                    </CodeChip>
                  ))}
                  {audit
                    .filter((entry) => entry.blocked_command !== null && !incident.blocked_unsafe_commands.includes(entry.blocked_command))
                    .map((entry) => (
                      <CodeChip key={`audit-${entry.id}`} tone="blocked" title={`audit row ${entry.id}`}>
                        {entry.blocked_command}
                      </CodeChip>
                    ))}
                </>
              )}
            </div>
          </div>

          {injectionBlocked ? (
            <p className="mt-3 flex gap-1.5 rounded-lg border border-rose-500/25 bg-rose-500/[0.06] p-2 text-[10px] leading-relaxed text-rose-200/80">
              <AlertTriangleIcon size={12} className="mt-0.5 shrink-0" />
              Adversarial prompt injection detected and scrubbed before agent dispatch. All executable payloads were rejected by the shlex allowlist.
            </p>
          ) : null}
        </section>
      </div>

      <div className="border-t border-white/[0.06] px-5 pb-5 pt-4">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.035] p-3.5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-emerald-400/25 bg-emerald-400/10 text-emerald-200">
                  <DatabaseIcon size={15} />
                </span>
                <div>
                  <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-emerald-300/60">
                    Cryptographic DR restore
                  </p>
                  <p className="mt-0.5 text-xs font-semibold text-slate-100">
                    {latestDr ? latestDr.snapshot_id : "No drill on record"}
                  </p>
                </div>
              </div>
              <ActionButton
                variant="primary"
                size="sm"
                onClick={onRunDrill}
                disabled={drilling}
                title="Execute a verified backup/restore drill against an isolated SQLite/PostgreSQL replica"
              >
                {drilling ? <Spinner className="h-3.5 w-3.5" label="Running DR drill" /> : <DatabaseIcon size={13} />}
                {drilling ? "Verifying…" : "Run Cryptographic DR Drill"}
              </ActionButton>
            </div>

            {drillError ? (
              <p className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-2.5 py-2 text-[10px] leading-relaxed text-rose-200">
                {drillError}
              </p>
            ) : null}

            {latestDr ? (
              <>
                <dl className="mt-3 grid grid-cols-1 gap-x-5 sm:grid-cols-2">
                  <KeyValue label="SHA-256 digest" value={formatDigest(latestDr.sha256_digest)} mono />
                  <KeyValue label="PRAGMA foreign_key_check" value={latestDr.foreign_key_check_passed ? "passed · 0 violations" : "FAILED"} />
                  <KeyValue label="RTO" value={formatLatency(latestDr.rto_ms)} />
                  <KeyValue label="RPO" value={`${formatNumber(latestDr.rpo_seconds)} s`} />
                  <KeyValue label="Tables restored" value={formatNumber(latestDr.tables_restored)} />
                  <KeyValue label="Rows verified" value={formatNumber(latestDr.rows_verified)} />
                </dl>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <Badge tone={latestDr.foreign_key_check_passed ? "success" : "critical"} dot>
                    {latestDr.foreign_key_check_passed ? "integrity verified" : "integrity failed"}
                  </Badge>
                  <Badge tone="neutral">row-level SHA-256</Badge>
                  <Badge tone="info">isolated replica</Badge>
                </div>
              </>
            ) : (
              <p className="mt-3 rounded-lg border border-white/[0.07] bg-black/20 px-2.5 py-2.5 text-[10px] leading-relaxed text-slate-500">
                This incident is stateless (no PostgreSQL or disk-pressure blast radius), so no automatic DR drill ran.
                The on-demand drill still verifies the cryptographic backup/restore path end-to-end.
              </p>
            )}
          </section>

          <section className="rounded-xl border border-white/[0.07] bg-black/20 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold text-slate-200">DR verification history</p>
              <Badge tone="neutral">{history.length} records</Badge>
            </div>
            {history.length === 0 ? (
              <p className="mt-3 text-[11px] text-slate-500">No persisted DR verifications yet.</p>
            ) : (
              <ul className="mt-2 max-h-44 space-y-1.5 overflow-y-auto pr-1">
                {history.slice(0, 8).map((row) => (
                  <li
                    key={row.snapshot_id}
                    className={cn(
                      "rounded-lg border px-2.5 py-2",
                      row.foreign_key_check_passed
                        ? "border-emerald-500/15 bg-emerald-500/[0.03]"
                        : "border-rose-500/20 bg-rose-500/[0.04]",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[10px] text-slate-300" title={row.snapshot_id}>
                        {row.snapshot_id}
                      </span>
                      <span className={cn("text-[9px] font-semibold uppercase", row.foreign_key_check_passed ? "text-emerald-300" : "text-rose-300")}>
                        {row.foreign_key_check_passed ? "pass" : "fail"}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[9px] text-slate-500">
                      <span className="font-mono">{formatDigest(row.sha256_digest)}</span>
                      <span>
                        {formatLatency(row.rto_ms)} · {formatRelativeTime(row.created_at)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className={cn("mt-3 rounded-lg border p-2 text-[10px] leading-relaxed", toneClasses("info"))}>
              <span className="font-semibold">Verification chain: </span>
              dump → SHA-256 → isolated replay → row hash → PRAGMA foreign_key_check → RTO measurement.
            </div>
          </section>
        </div>
      </div>
    </Panel>
  );
}
