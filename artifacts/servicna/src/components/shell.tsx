import { type ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, WifiOff } from "lucide-react";
import { getGetSessionQueryKey, useGetSession, useSignOut, recoverPendingOperations, type User } from "@workspace/api-client-react";
import { ROLE_LABEL, roleHome, useActionHelpers, fmtTime } from "@/lib/app";
import { DemoTag, SkeletonBlock } from "@/components/kit";
import { cn } from "@/lib/utils";

export function Logo({ light }: { light?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className="relative grid h-9 w-9 place-items-center overflow-hidden rounded-xl bg-mandarin">
        <span className="ablaq absolute inset-x-0 bottom-0 h-2" />
        <span className="font-display text-lg font-bold leading-none text-basalt">س</span>
      </span>
      <span className={cn("font-display text-xl font-bold tracking-tight", light ? "text-limestone" : "text-basalt")}>سرفيسنا</span>
    </span>
  );
}

export function OfflineBanner() {
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const qc = useQueryClient();
  useEffect(() => {
    const recover = () => { void recoverPendingOperations().then(() => qc.invalidateQueries()); };
    const on = () => { setOnline(true); recover(); };
    const off = () => setOnline(false);
    const connection = (event: Event) => {
      const detail = (event as CustomEvent<{ online: boolean; at?: number }>).detail;
      setOnline(detail.online);
      if (detail.at) setLastUpdate(detail.at);
    };
    const visible = () => { if (!document.hidden) qc.invalidateQueries(); };
    // Defer until auth/me has left its own query's fetch cycle; replay recovery
    // may refetch auth/me, and must not await that query from inside itself.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const session = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void recoverPendingOperations(); }, 0);
    };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    window.addEventListener("servicna:connection", connection);
    window.addEventListener("servicna:session", session);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", on); window.removeEventListener("offline", off);
      window.removeEventListener("servicna:connection", connection);
      window.removeEventListener("servicna:session", session);
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [qc]);
  if (online) return null;
  return (
    <div className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-brick px-4 py-2 text-sm font-bold text-chalk" data-testid="banner-offline">
      <WifiOff className="h-4 w-4" />
      الاتصال منقطع — آخر تحديث {lastUpdate ? fmtTime(new Date(lastUpdate).toISOString()) : "غير متاح"} — نجلب الحالة فور عودة الاتصال
    </div>
  );
}

const NAV: Record<string, { href: string; label: string }[]> = {
  passenger: [{ href: "/passenger", label: "رحلتي" }, { href: "/passenger/history", label: "السجل" }],
  driver: [{ href: "/driver", label: "خطّي" }],
  admin: [{ href: "/admin", label: "العمليات" }],
};

function Header({ user }: { user: User }) {
  const [loc, setLocation] = useLocation();
  const qc = useQueryClient();
  const signOut = useSignOut();
  const { fail } = useActionHelpers();
  const doSignOut = () =>
    signOut.mutate(undefined, {
      onSuccess: () => { qc.clear(); setLocation("/"); },
      onError: fail,
    });
  return (
    <header className="sticky top-0 z-40 bg-basalt text-limestone">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-3 sm:flex-nowrap sm:gap-3">
        <Link href={roleHome(user.role)} className="shrink-0" data-testid="link-home"><Logo light /></Link>
        <nav className="order-last flex w-full justify-center gap-1 sm:order-none sm:w-auto">
          {(NAV[user.role] ?? []).map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn("rounded-full px-3 py-1.5 text-sm font-semibold transition-colors", loc === n.href ? "bg-limestone text-basalt" : "text-limestone/70 hover:text-limestone")}
              data-testid={`link-nav-${n.href.replace(/\//g, "-")}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="mr-auto flex shrink-0 items-center gap-2">
          <div className="hidden text-left leading-tight sm:block">
            <p className="text-sm font-bold" data-testid="text-user-name">{user.name}</p>
            <p className="text-[11px] text-limestone/60" data-testid="text-user-role">{ROLE_LABEL[user.role]}</p>
          </div>
          <span className="rounded-full bg-mandarin px-2 py-0.5 text-[11px] font-bold text-basalt sm:hidden">{ROLE_LABEL[user.role]}</span>
          <button
            onClick={doSignOut}
            disabled={signOut.isPending}
            className="grid h-9 w-9 place-items-center rounded-full bg-limestone/10 transition hover:bg-limestone/20 active:scale-90 disabled:opacity-50"
            aria-label="تسجيل الخروج"
            data-testid="button-sign-out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="ablaq h-1.5 w-full opacity-90" />
      <div className="bg-limestone">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 py-1.5 text-[11px] text-basalt/70">
          <span className="truncate">خط الوعر ↔ وسط حمص · نموذج أولي</span>
          <DemoTag />
        </div>
      </div>
    </header>
  );
}

export function Guard({ role, children }: { role: User["role"]; children: (user: User) => ReactNode }) {
  const { data, isLoading } = useGetSession({ query: { queryKey: getGetSessionQueryKey(), retry: 1 } });
  const [, setLocation] = useLocation();
  const user = data?.authenticated ? data.user : undefined;
  useEffect(() => {
    if (isLoading) return;
    if (!user) setLocation("/");
    else if (user.role !== role) setLocation(roleHome(user.role));
  }, [isLoading, user, role, setLocation]);

  if (isLoading || !user || user.role !== role) {
    return (
      <div className="min-h-[100dvh]">
        <div className="h-16 bg-basalt" />
        <div className="mx-auto max-w-5xl space-y-4 p-4">
          <SkeletonBlock className="h-40" />
          <SkeletonBlock className="h-24" />
          <SkeletonBlock className="h-24" />
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-[100dvh] pb-16">
      <Header user={user} />
      <main className="mx-auto max-w-5xl px-4 pt-5">{children(user)}</main>
    </div>
  );
}
