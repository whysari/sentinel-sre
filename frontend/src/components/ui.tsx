import type { ReactNode } from "react";
import { cn, toneClasses, type Tone } from "../lib/format";

/* --------------------------------------------------------------------------------------------- */
/* Panel                                                                                          */
/* --------------------------------------------------------------------------------------------- */

export interface PanelProps {
  children: ReactNode;
  className?: string;
  id?: string;
  tone?: Tone | "accent";
  as?: "section" | "article" | "aside" | "div";
}

export function Panel({ children, className, id, tone, as = "section" }: PanelProps) {
  const Tag = as;
  return (
    <Tag
      id={id}
      className={cn(
        "relative overflow-hidden rounded-2xl border border-white/[0.07] bg-sentinel-panel/80 shadow-[0_20px_60px_-40px_rgba(0,0,0,0.9)] backdrop-blur",
        tone === "critical" && "border-rose-500/25",
        tone === "warning" && "border-amber-500/25",
        tone === "success" && "border-emerald-500/25",
        tone === "info" && "border-sky-500/25",
        tone === "accent" && "border-sky-400/30",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
      {children}
    </Tag>
  );
}

export interface PanelHeaderProps {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  tone?: Tone;
  className?: string;
}

export function PanelHeader({ title, subtitle, eyebrow, icon, actions, tone, className }: PanelHeaderProps) {
  return (
    <header className={cn("flex flex-wrap items-start justify-between gap-4 px-5 pt-5", className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon ? (
          <span
            className={cn(
              "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border",
              tone ? toneClasses(tone) : "border-white/10 bg-white/[0.04] text-sky-300",
            )}
          >
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">{eyebrow}</p>
          ) : null}
          <h2 className="truncate text-[15px] font-semibold tracking-tight text-slate-100">{title}</h2>
          {subtitle ? <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-400">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/* --------------------------------------------------------------------------------------------- */
/* Badge / pill                                                                                   */
/* --------------------------------------------------------------------------------------------- */

export interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  dot?: boolean;
  title?: string;
}

export function Badge({ children, tone = "neutral", className, dot, title }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
        toneClasses(tone),
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

/* --------------------------------------------------------------------------------------------- */
/* Progress bar                                                                                   */
/* --------------------------------------------------------------------------------------------- */

const PROGRESS_TONES: Record<string, string> = {
  critical: "from-rose-500 to-rose-400",
  warning: "from-amber-500 to-amber-300",
  info: "from-sky-500 to-cyan-300",
  success: "from-emerald-500 to-emerald-300",
  neutral: "from-slate-500 to-slate-400",
};

export interface ProgressBarProps {
  value: number;
  tone?: Tone;
  height?: "xs" | "sm" | "md";
  className?: string;
  label?: string;
}

export function ProgressBar({ value, tone = "info", height = "sm", className, label }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const heights = { xs: "h-1", sm: "h-1.5", md: "h-2.5" } as const;
  return (
    <div
      className={cn("w-full overflow-hidden rounded-full bg-white/[0.06]", heights[height], className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 100)}
      aria-label={label}
    >
      <div
        className={cn("h-full rounded-full bg-gradient-to-r transition-[width] duration-500", PROGRESS_TONES[tone] ?? PROGRESS_TONES.info)}
        style={{ width: `${pct * 100}%` }}
      />
    </div>
  );
}

/* --------------------------------------------------------------------------------------------- */
/* Command / code chips                                                                           */
/* --------------------------------------------------------------------------------------------- */

export interface CodeChipProps {
  children: ReactNode;
  tone?: "safe" | "blocked" | "neutral";
  className?: string;
  title?: string;
}

export function CodeChip({ children, tone = "neutral", className, title }: CodeChipProps) {
  return (
    <code
      title={title}
      className={cn(
        "block overflow-hidden text-ellipsis whitespace-nowrap rounded-lg border px-2.5 py-1.5 font-mono text-[11px] leading-relaxed",
        tone === "safe" && "border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-200",
        tone === "blocked" && "border-rose-500/20 bg-rose-500/[0.06] text-rose-200",
        tone === "neutral" && "border-white/10 bg-black/30 text-slate-300",
        className,
      )}
    >
      {children}
    </code>
  );
}

/* --------------------------------------------------------------------------------------------- */
/* Buttons                                                                                        */
/* --------------------------------------------------------------------------------------------- */

export interface ActionButtonProps {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "danger" | "ghost" | "outline";
  size?: "xs" | "sm" | "md";
  className?: string;
  title?: string;
  type?: "button" | "submit";
}

export function ActionButton({
  children,
  onClick,
  disabled,
  variant = "outline",
  size = "sm",
  className,
  title,
  type = "button",
}: ActionButtonProps) {
  const sizes = {
    xs: "px-2.5 py-1 text-[11px]",
    sm: "px-3 py-1.5 text-xs",
    md: "px-4 py-2 text-sm",
  } as const;
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg border font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 disabled:cursor-not-allowed disabled:opacity-40",
        sizes[size],
        variant === "primary" && "border-sky-400/40 bg-sky-500/15 text-sky-100 hover:bg-sky-500/25",
        variant === "danger" && "border-rose-400/40 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25",
        variant === "ghost" && "border-transparent bg-transparent text-slate-300 hover:bg-white/[0.05]",
        variant === "outline" && "border-white/10 bg-white/[0.03] text-slate-200 hover:border-white/25 hover:bg-white/[0.06]",
        className,
      )}
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------------------------------------- */
/* Misc                                                                                           */
/* --------------------------------------------------------------------------------------------- */

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn("inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-sky-300", className)}
    />
  );
}

export function EmptyState({
  title,
  detail,
  icon,
  action,
  className,
}: {
  title: string;
  detail: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/10 px-6 py-10 text-center", className)}>
      {icon ? <div className="text-slate-500">{icon}</div> : null}
      <div>
        <p className="text-sm font-semibold text-slate-200">{title}</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">{detail}</p>
      </div>
      {action}
    </div>
  );
}

export function KeyValue({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.045] py-1.5 last:border-0">
      <dt className="shrink-0 text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={cn("min-w-0 truncate text-right text-xs text-slate-200", mono && "font-mono text-[11px]")}>{value}</dd>
    </div>
  );
}

export function LiveDot({ active, tone = "success" }: { active: boolean; tone?: "success" | "warning" | "critical" }) {
  const color = tone === "success" ? "bg-emerald-400" : tone === "warning" ? "bg-amber-400" : "bg-rose-400";
  return (
    <span className="relative inline-flex h-2 w-2">
      {active ? <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", color)} /> : null}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", active ? color : "bg-slate-600")} />
    </span>
  );
}

export function SkeletonLine({ className }: { className?: string }) {
  return <div className={cn("h-3 w-full animate-pulse rounded bg-white/[0.06]", className)} />;
}
