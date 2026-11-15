import { useState } from "react";
import { motion } from "framer-motion";
import { Loader2, PlayCircle, RotateCcw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAdminSummaryQueryKey, getGetRouteQueryKey, getListAdminEventsQueryKey, getListAdminRequestsQueryKey, getListAdminVehiclesQueryKey,
  getListLiveTripsQueryKey, useGetAdminSummary, useGetRoute, useListAdminEvents, useListAdminRequests, useListAdminVehicles, useListLiveTrips, usePrepareDemo, useResetDemo, useStepDemoTrip,
  type RequestStatus,
} from "@workspace/api-client-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Guard } from "@/components/shell";
import { LineMap } from "@/components/line-map";
import { DemoTag, EmptyState, ErrorState, Panel, RequestRow, SectionTitle, SkeletonBlock, StatusChip } from "@/components/kit";
import { POLL, ROLE_LABEL, STATUS_LABEL, fmtTime, useActionHelpers } from "@/lib/app";
import { cn } from "@/lib/utils";

const live = { refetchInterval: POLL, refetchOnWindowFocus: true, refetchOnReconnect: true };
const FILTERS: (RequestStatus | "all")[] = ["all", "pending", "accepted", "boarded", "completed", "cancelled", "expired"];

function AdminBody() {
  const step = useStepDemoTrip();
  const qc = useQueryClient();
  const { fail, ok } = useActionHelpers();
  const [filter, setFilter] = useState<RequestStatus | "all">("all");
  const params = filter === "all" ? undefined : { status: filter };
  const summary = useGetAdminSummary({ query: { queryKey: getGetAdminSummaryQueryKey(), ...live } });
  const vehicles = useListAdminVehicles({ query: { queryKey: getListAdminVehiclesQueryKey(), ...live } });
  const requests = useListAdminRequests(params, { query: { queryKey: getListAdminRequestsQueryKey(params), ...live } });
  const events = useListAdminEvents({ query: { queryKey: getListAdminEventsQueryKey(), ...live } });
  const route = useGetRoute({ query: { queryKey: getGetRouteQueryKey() } });
  const trips = useListLiveTrips({ query: { queryKey: getListLiveTripsQueryKey(), ...live } });
  const reset = useResetDemo();
  const prepare = usePrepareDemo();

  const s = summary.data;
  const isEmpty = !!s && s.activeTrips + s.pendingRequests + s.acceptedRequests + s.boardedRequests + s.completedRequests + s.cancelledRequests + s.expiredRequests === 0;
  const tiles = s ? [
    { k: "سرافيس نشطة", v: `${s.activeTrips}/${s.totalVehicles}`, tone: "bg-basalt text-limestone" },
    { k: STATUS_LABEL.pending, v: s.pendingRequests, tone: "bg-mandarin text-basalt" },
    { k: STATUS_LABEL.accepted, v: s.acceptedRequests, tone: "bg-teal text-chalk" },
    { k: STATUS_LABEL.boarded, v: s.boardedRequests, tone: "bg-basalt-2 text-limestone" },
    { k: STATUS_LABEL.completed, v: s.completedRequests, tone: "bg-olive-soft text-olive" },
    { k: STATUS_LABEL.cancelled, v: s.cancelledRequests, tone: "bg-brick-soft text-brick" },
    { k: STATUS_LABEL.expired, v: s.expiredRequests, tone: "bg-stone-soft text-stone" },
    { k: "مقاعد فارغة", v: s.freeSeats, tone: "bg-chalk text-basalt border border-basalt/10" },
  ] : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">غرفة العمليات</h1>
          <p className="text-sm text-muted-foreground">تتحدّث كل ٣ ثوانٍ · <DemoTag /></p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => prepare.mutate(undefined, { onSuccess: (r) => { ok("تم تجهيز السيناريو", r.message); qc.invalidateQueries(); }, onError: fail })}
            disabled={prepare.isPending || !isEmpty}
            title={isEmpty ? undefined : "متاح فقط بعد إعادة الضبط إلى حالة فارغة"}
            className="inline-flex items-center gap-2 rounded-full bg-basalt px-4 py-2 text-sm font-bold text-limestone active:scale-95 disabled:opacity-40"
            data-testid="button-prepare-demo"
          >
            {prepare.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
            تجهيز سيناريو العرض
          </button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button disabled={reset.isPending} className="inline-flex items-center gap-2 rounded-full border-2 border-brick/40 px-4 py-2 text-sm font-bold text-brick active:scale-95 disabled:opacity-50" data-testid="button-reset-demo">
              {reset.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              إفراغ البيانات التجريبية
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent dir="rtl" className="rounded-3xl">
            <AlertDialogHeader className="text-right sm:text-right">
              <AlertDialogTitle className="font-display">إفراغ بيانات العرض؟</AlertDialogTitle>
              <AlertDialogDescription>ستُحذف فقط الطلبات والرحلات الموسومة كتجريبية وأحداثها. البيانات غير التجريبية والحسابات ومفاتيح المحاولات محفوظة. لن يُنشأ سيناريو تلقائيًا. لا يمكن التراجع.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="gap-2 sm:justify-start">
              <AlertDialogCancel data-testid="button-reset-cancel">تراجع</AlertDialogCancel>
              <AlertDialogAction
                className="bg-brick text-chalk hover:bg-brick/90"
                onClick={() => reset.mutate(undefined, { onSuccess: (r) => { ok("أُفرغت البيانات", r.message); qc.invalidateQueries(); }, onError: fail })}
                data-testid="button-reset-confirm"
              >
                نعم، أفرغ البيانات
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        </div>
      </div>

      <Panel testId="panel-demo-help">
        <p className="font-display font-bold">ضبط العرض</p>
        <ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-muted-foreground">
          <li><b className="text-foreground">إفراغ البيانات التجريبية</b> يحذف البيانات المتغيرة فقط ويتركها فارغة.</li>
          <li><b className="text-foreground">تجهيز سيناريو العرض</b> متاح فقط عندما تكون البيانات فارغة، وينشئ سيناريو محددًا وواضحًا.</li>
        </ol>
        <p className="mt-3 rounded-2xl bg-limestone p-3 text-xs" data-testid="text-account-setup">
          الحسابات (راكب، سائق، مشرف) تُنشأ مسبقًا عبر أداة سطر الأوامر الموجودة في الخادم، وليست جزءًا من هذين الزرين: لا الإفراغ ولا التجهيز يحذف الحسابات أو يعيد ضبطها.
        </p>
      </Panel>

      {summary.isLoading && <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <SkeletonBlock key={i} className="h-20" />)}</div>}
      {summary.isError && <ErrorState onRetry={() => summary.refetch()} />}
      {s && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {tiles.map((t, i) => (
              <motion.div key={t.k} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }} className={cn("rounded-2xl p-3.5", t.tone)} data-testid={`tile-${i}`}>
                <p className="text-xs font-semibold opacity-80">{t.k}</p>
                <p className="num mt-1 text-3xl font-semibold">{t.v}</p>
              </motion.div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {s.directions.map((d, i) => (
              <Panel key={d.directionId} testId={`panel-direction-${d.directionId}`}>
                <div className="flex items-center gap-2">
                  <span className={cn("h-3 w-5 rounded-sm", i === 0 ? "bg-mandarin" : "bg-teal")} />
                  <p className="font-display font-bold">{d.directionName}</p>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-limestone p-2"><p className="num text-xl font-semibold">{d.activeTrips}</p><p className="text-[11px] text-muted-foreground">سرافيس</p></div>
                  <div className="rounded-xl bg-mandarin-soft p-2"><p className="num text-xl font-semibold">{d.pendingRequests}</p><p className="text-[11px] text-muted-foreground">ينتظرون</p></div>
                  <div className="rounded-xl bg-teal-soft p-2"><p className="num text-xl font-semibold">{d.freeSeats}</p><p className="text-[11px] text-muted-foreground">مقاعد فارغة</p></div>
                </div>
              </Panel>
            ))}
          </div>
        </>
      )}

      {route.data && <LineMap stops={route.data.stops} directions={route.data.directions} trips={trips.data ?? []} />}

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <section>
          <SectionTitle>الأسطول</SectionTitle>
          {vehicles.isLoading && <SkeletonBlock className="h-40" />}
          {vehicles.isError && <ErrorState onRetry={() => vehicles.refetch()} />}
          <div className="space-y-2">
            {vehicles.data?.map((v, i) => (
              <motion.div key={v.vehicle.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }} className="flex items-center gap-3 rounded-2xl border border-basalt/10 bg-card p-3" data-testid={`row-vehicle-${v.vehicle.id}`}>
                <span className="num rounded-md border-2 border-basalt bg-chalk px-2 text-sm font-bold">{v.vehicle.plate}</span>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-semibold">{v.vehicle.driverName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {v.trip ? `${v.trip.directionName} · عند ${v.trip.currentStopName} · ${v.trip.seatsTaken}/${v.trip.capacity}` : "متوقف — لا رحلة"}
                  </p>
                </div>
                <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", v.trip ? "bg-olive-soft text-olive" : "bg-stone-soft text-stone")}>{v.trip ? "على الخط" : "خارج الخدمة"}</span>
                <span className="num text-xs text-muted-foreground" title="طلبات نشطة">{v.activeRequests}</span>
                {v.trip && <button className="rounded-xl bg-mandarin p-2 text-xs font-bold disabled:opacity-50"
                  disabled={step.isPending} onClick={() => step.mutate({ id: v.trip!.id },
                    { onSuccess: () => { ok("تحركت المركبة", "محاكاة فقط"); qc.invalidateQueries(); }, onError: fail })}
                  data-testid={`button-demo-step-${v.trip.id}`}>النقطة التالية — محاكاة</button>}
              </motion.div>
            ))}
          </div>
        </section>

        <section>
          <SectionTitle>آخر النشاط</SectionTitle>
          {events.isLoading && <SkeletonBlock className="h-40" />}
          {events.isError && <ErrorState onRetry={() => events.refetch()} />}
          {events.data?.length === 0 && <EmptyState title="هادئ حالياً" hint="أي طلب أو قبول سيظهر هنا فوراً." />}
          <ol className="space-y-2">
            {events.data?.slice(0, 20).map((e, i) => (
              <motion.li key={e.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 10) * 0.03 }} className="rounded-2xl bg-chalk p-3 text-sm" data-testid={`event-${e.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip status={e.toStatus} />
                  <span className="font-semibold">{e.passengerName}</span>
                  <span className="num mr-auto text-xs text-muted-foreground">{fmtTime(e.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {e.pickupStopName} ← {e.dropoffStopName} · {e.actorName} ({ROLE_LABEL[e.actorRole] ?? e.actorRole}){e.note ? ` · ${e.note}` : ""}
                </p>
              </motion.li>
            ))}
          </ol>
        </section>
      </div>

      <section>
        <SectionTitle>كل الطلبات</SectionTitle>
        <div className="-mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 pb-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn("shrink-0 rounded-full border px-3 py-1.5 text-sm font-semibold transition", filter === f ? "border-basalt bg-basalt text-limestone" : "border-basalt/15 bg-chalk")}
              data-testid={`filter-${f}`}
            >
              {f === "all" ? "الكل" : STATUS_LABEL[f]}
            </button>
          ))}
        </div>
        {requests.isLoading && <SkeletonBlock className="h-40" />}
        {requests.isError && <ErrorState onRetry={() => requests.refetch()} />}
        {requests.data?.length === 0 && <EmptyState title="لا طلبات بهذه الحالة" />}
        <div className="grid gap-2 md:grid-cols-2">
          {requests.data?.map((r, i) => <RequestRow key={r.id} r={r} index={Math.min(i, 10)} href={`/requests/${r.id}`} />)}
        </div>
      </section>
    </div>
  );
}

export default function AdminPage() {
  return <Guard role="admin">{() => <AdminBody />}</Guard>;
}
