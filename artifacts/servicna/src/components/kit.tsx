import { type ReactNode } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { ArrowLeft, CircleDot, FlaskConical, RotateCw } from "lucide-react";
import type { RequestEvent, RequestStatus, RideRequest } from "@workspace/api-client-react";
import { ROLE_LABEL, STATUS_LABEL, STATUS_STYLE, fmtDateTime, fmtTime } from "@/lib/app";
import { cn } from "@/lib/utils";

export function DemoTag({ className, text = "بيانات تجريبية" }: { className?: string; text?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full border border-dashed border-basalt/40 bg-chalk px-2 py-0.5 text-[11px] font-semibold text-basalt/80", className)}
      data-testid="tag-demo-data"
    >
      <FlaskConical className="h-3 w-3" />
      {text}
    </span>
  );
}

export function StatusChip({ status, className }: { status: RequestStatus; className?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold", s.chip, className)} data-testid={`status-${status}`}>
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot, status === "boarded" && "bg-mandarin")} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 className="font-display text-lg font-bold tracking-tight text-basalt">{children}</h2>
      {aside}
    </div>
  );
}

export function Panel({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={cn("rounded-3xl border border-basalt/10 bg-card p-4 shadow-[0_1px_0_#1e1b1810,0_12px_30px_-18px_#1e1b1840] sm:p-5", className)} data-testid={testId}>
      {children}
    </section>
  );
}

export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-2xl bg-basalt/[0.07]", className)} />;
}

export function ErrorState({ onRetry, text = "تعذّر تحميل البيانات." }: { onRetry: () => void; text?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-3xl border border-brick/30 bg-brick-soft/60 p-6 text-center" data-testid="state-error">
      <p className="font-semibold text-brick">{text}</p>
      <button onClick={onRetry} className="inline-flex items-center gap-2 rounded-full bg-basalt px-4 py-2 text-sm font-bold text-limestone active:scale-95" data-testid="button-retry">
        <RotateCw className="h-4 w-4" /> إعادة المحاولة
      </button>
    </div>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-3xl border border-dashed border-basalt/20 px-5 py-8 text-center" data-testid="state-empty">
      <div className="mb-1 grid h-12 w-12 place-items-center rounded-2xl bg-limestone text-basalt/60">{icon ?? <CircleDot className="h-5 w-5" />}</div>
      <p className="font-display font-bold text-basalt">{title}</p>
      {hint && <p className="max-w-xs text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function StopsRoute({ from, to, compact }: { from: string; to: string; compact?: boolean }) {
  return (
    <div className={cn("flex items-stretch gap-3", compact && "gap-2")}>
      <div className="flex flex-col items-center py-1">
        <span className="h-2.5 w-2.5 rounded-full border-2 border-basalt bg-mandarin" />
        <span className="ablaq-v my-0.5 w-[3px] flex-1 rounded" />
        <span className="h-2.5 w-2.5 rounded-full border-2 border-basalt bg-teal" />
      </div>
      <div className={cn("flex flex-col justify-between gap-1", compact ? "text-sm" : "text-base")}>
        <span className="font-semibold">{from}</span>
        <span className="font-semibold">{to}</span>
      </div>
    </div>
  );
}

export function Timeline({ events }: { events: RequestEvent[] }) {
  if (!events.length) return <p className="text-sm text-muted-foreground">لا توجد أحداث بعد.</p>;
  return (
    <ol className="relative space-y-4 pr-5" data-testid="list-timeline">
      <span className="absolute bottom-2 right-[7px] top-2 w-[2px] bg-basalt/10" />
      {events.map((e, i) => (
        <motion.li
          key={e.id}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.06 }}
          className="relative"
          data-testid={`event-${e.id}`}
        >
          <span className={cn("absolute -right-5 top-1 h-4 w-4 rounded-full border-[3px] border-card", STATUS_STYLE[e.toStatus].dot)} />
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={e.toStatus} />
            <span className="num text-xs text-muted-foreground">{fmtTime(e.createdAt)}</span>
          </div>
          <p className="mt-1 text-sm">
            <span className="font-semibold">{e.actorName}</span>
            <span className="text-muted-foreground"> · {ROLE_LABEL[e.actorRole] ?? e.actorRole}</span>
          </p>
          {e.note && <p className="text-sm text-muted-foreground">{e.note}</p>}
        </motion.li>
      ))}
    </ol>
  );
}

export function RequestRow({ r, index = 0, href }: { r: RideRequest; index?: number; href?: string }) {
  const body = (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={r.status} />
          <span className="text-xs text-muted-foreground">{r.directionName}</span>
        </div>
        <StopsRoute from={r.pickupStop.name} to={r.dropoffStop.name} compact />
      </div>
      <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
        <span className="num">#{r.id}</span>
        <span className="num">{fmtDateTime(r.createdAt)}</span>
        {href && <ArrowLeft className="mt-1 h-4 w-4 text-basalt" />}
      </div>
    </>
  );
  const cls = "flex items-start gap-3 rounded-2xl border border-basalt/10 bg-chalk p-3.5 transition-transform active:scale-[0.99]";
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05, ease: [0.2, 0.8, 0.2, 1] }}>
      {href ? (
        <Link href={href} className={cn(cls, "hover:border-basalt/30")} data-testid={`link-request-${r.id}`}>{body}</Link>
      ) : (
        <div className={cls} data-testid={`row-request-${r.id}`}>{body}</div>
      )}
    </motion.div>
  );
}
