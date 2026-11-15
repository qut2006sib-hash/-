import { useParams, Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { getGetRideRequestQueryKey, getGetSessionQueryKey, useGetRideRequest, useGetSession } from "@workspace/api-client-react";
import { DemoTag, ErrorState, Panel, SectionTitle, SkeletonBlock, StatusChip, StopsRoute, Timeline } from "@/components/kit";
import { POLL, STATUS_STYLE, fmtDateTime, roleHome } from "@/lib/app";
import { Guard } from "@/components/shell";
import type { User } from "@workspace/api-client-react";

function Detail({ id, user }: { id: number; user: User }) {
  const q = useGetRideRequest(id, { query: { enabled: !!id, queryKey: getGetRideRequestQueryKey(id), refetchInterval: POLL } });
  const back = user.role === "passenger" ? "/passenger/history" : roleHome(user.role);
  return (
    <div className="space-y-4">
      <Link href={back} className="inline-flex items-center gap-1 text-sm font-semibold text-basalt/70 hover:text-basalt" data-testid="link-back">
        <ArrowRight className="h-4 w-4" /> رجوع
      </Link>
      {q.isLoading && <><SkeletonBlock className="h-40" /><SkeletonBlock className="h-60" /></>}
      {q.isError && <ErrorState text="لم نجد هذا الطلب أو لا تملك صلاحية عرضه." onRetry={() => q.refetch()} />}
      {q.data && (() => {
        const r = q.data.request;
        return (
          <div className="grid gap-4 md:grid-cols-[1.1fr_1fr]">
            <Panel className="overflow-hidden p-0 sm:p-0">
              <div className={`${STATUS_STYLE[r.status].panel} px-5 py-4`}>
                <p className="num text-xs opacity-75">طلب #{r.id}</p>
                <p className="font-display text-2xl font-bold" data-testid="text-request-status">
                  <StatusChip status={r.status} className="border-transparent bg-chalk/90 text-basalt no-underline" />
                </p>
              </div>
              <div className="space-y-4 p-5">
                <StopsRoute from={r.pickupStop.name} to={r.dropoffStop.name} />
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-muted-foreground">الاتجاه</dt><dd className="font-semibold">{r.directionName}</dd></div>
                  <div><dt className="text-muted-foreground">الراكب</dt><dd className="font-semibold">{r.passengerName}</dd></div>
                  <div><dt className="text-muted-foreground">السائق</dt><dd className="font-semibold">{r.driverName ?? "—"}</dd></div>
                  <div><dt className="text-muted-foreground">اللوحة</dt><dd className="num font-semibold">{r.vehiclePlate ?? "—"}</dd></div>
                  <div><dt className="text-muted-foreground">أُرسل</dt><dd className="num">{fmtDateTime(r.createdAt)}</dd></div>
                  <div><dt className="text-muted-foreground">ينتهي</dt><dd className="num">{fmtDateTime(r.expiresAt)}</dd></div>
                </dl>
                {r.cancelReason && <p className="rounded-xl bg-brick-soft p-3 text-sm text-brick">{r.cancelReason}</p>}
                <DemoTag />
              </div>
            </Panel>
            <Panel>
              <SectionTitle>سجل الحالة</SectionTitle>
              <Timeline events={q.data.events} />
            </Panel>
          </div>
        );
      })()}
    </div>
  );
}

export default function RequestDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const session = useGetSession({ query: { queryKey: getGetSessionQueryKey() } });
  const role = session.data?.user?.role;
  return (
    <Guard role={role ?? "passenger"}>{(user) => <Detail id={id} user={user} />}</Guard>
  );
}
