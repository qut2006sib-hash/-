import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Check, ChevronsLeft, Flag, Loader2, Play, Square, UserCheck, Users } from "lucide-react";
import {
  getGetDriverRequestsQueryKey, getGetDriverStateQueryKey, getGetRouteQueryKey, getListLiveTripsQueryKey,
  useAcceptRideRequest, useCancelRideRequest, useHeartbeatTrip, useUpdateExternalOccupancy, useCompleteRideRequest, useEndTrip,
  useGetDriverRequests, useGetDriverState, useGetRoute, useListLiveTrips, useStartTrip,
  type DriverState, type RideRequest, type RouteDetail, type AvailableRequest,
} from "@workspace/api-client-react";
import { Guard } from "@/components/shell";
import { LineMap } from "@/components/line-map";
import { DemoTag, EmptyState, ErrorState, Panel, SectionTitle, SkeletonBlock, StatusChip, StopsRoute } from "@/components/kit";
import { POLL, fmtTime, useActionHelpers } from "@/lib/app";
import { cn } from "@/lib/utils";

const live = { refetchInterval: POLL, refetchOnWindowFocus: true, refetchOnReconnect: true };

function StartTrip({ state, route }: { state: DriverState; route: RouteDetail }) {
  const start = useStartTrip();
  const [externalOccupied, setExternalOccupied] = useState(0);
  const { fail, ok, refresh } = useActionHelpers();
  return (
    <div className="space-y-4">
      <Panel>
        <p className="text-sm text-muted-foreground">صباح الخير {state.driver.name}</p>
        <h1 className="font-display text-2xl font-bold">بأي اتجاه تنطلق؟</h1>
        <div className="mt-3 flex items-center gap-2 text-sm">
          <span className="num rounded-md border-2 border-basalt bg-chalk px-2 font-bold">{state.vehicle.plate}</span>
          <span className="text-muted-foreground">{state.vehicle.label} · {state.vehicle.capacity} مقاعد</span>
          <DemoTag className="mr-auto" />
        </div>
      </Panel>
      <Panel>
        <label className="block text-sm font-bold">المركبة المسموحة
          <select className="mt-2 w-full rounded-xl border p-3" value={state.vehicle.id} disabled>
            <option value={state.vehicle.id}>{state.vehicle.plate} — {state.vehicle.capacity} مقاعد</option>
          </select>
        </label>
        <p className="mt-4 font-bold">الركاب خارج التطبيق عند الانطلاق</p>
        <div className="mt-2 flex items-center justify-between gap-4">
          <button aria-label="تقليل الركاب" className="h-14 w-16 rounded-xl bg-limestone text-3xl" disabled={externalOccupied === 0}
            onClick={() => setExternalOccupied((n) => n - 1)}>−</button>
          <output className="num text-2xl">{externalOccupied}</output>
          <button aria-label="زيادة الركاب" className="h-14 w-16 rounded-xl bg-mandarin text-3xl" disabled={externalOccupied >= state.vehicle.capacity}
            onClick={() => setExternalOccupied((n) => n + 1)}>+</button>
        </div>
      </Panel>
      <div className="grid gap-3 sm:grid-cols-2">
        {route.directions.map((d, i) => (
          <motion.button
            key={d.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.08 }}
            whileTap={{ scale: 0.97 }}
            disabled={start.isPending}
             onClick={() => start.mutate({ data: { directionId: d.id, vehicleId: state.vehicle.id, externalOccupied } }, { onSuccess: () => { ok("بدأت الرحلة", d.name); refresh(); }, onError: fail })}
            className={cn("relative overflow-hidden rounded-3xl p-5 text-right disabled:opacity-60", i === 0 ? "bg-mandarin text-basalt" : "bg-teal text-chalk")}
            data-testid={`button-start-${d.code}`}
          >
            <span className="ablaq absolute inset-x-0 bottom-0 h-1.5 opacity-70" />
            <span className="text-xs font-semibold opacity-75">{d.fromName}</span>
            <span className="mt-1 block font-display text-2xl font-bold">{d.toName}</span>
            <span className="mt-4 inline-flex items-center gap-2 rounded-full bg-basalt px-3 py-1.5 text-sm font-bold text-limestone">
              {start.isPending && start.variables?.data.directionId === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              ابدأ الرحلة
            </span>
          </motion.button>
        ))}
      </div>
      <LineMap stops={route.stops} directions={route.directions} />
    </div>
  );
}

function ReqCard({ r, i, children }: { r: RideRequest | AvailableRequest; i: number; children: React.ReactNode }) {
  const assigned = "status" in r;
  const name = assigned ? r.passengerName : null;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.25 } }}
      transition={{ delay: i * 0.05, ease: [0.2, 0.8, 0.2, 1] }}
      className="rounded-3xl border border-basalt/10 bg-card p-4"
      data-testid={`card-driver-request-${r.id}`}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-limestone font-bold">{name?.slice(0, 1) ?? "#"}</span>
          <div>
            <p className="font-bold leading-tight">{name ?? `طلب #${r.id}`}</p>
            <p className="num text-[11px] text-muted-foreground">
              {assigned ? `#${r.id} · ${fmtTime(r.createdAt)}` : `ينتظر منذ ${Math.floor(r.waitingSeconds / 60)} د و${r.waitingSeconds % 60} ث`}
            </p>
          </div>
        </div>
        <StatusChip status={assigned ? r.status : "pending"} />
      </div>
      <StopsRoute from={r.pickupStop.name} to={r.dropoffStop.name} compact />
      <div className="mt-3">{children}</div>
    </motion.div>
  );
}

function OnTrip({ state, route }: { state: DriverState; route: RouteDetail }) {
  const trip = state.trip!;
  const reqs = useGetDriverRequests({ query: { queryKey: getGetDriverRequestsQueryKey(), ...live } });
  const trips = useListLiveTrips({ query: { queryKey: getListLiveTripsQueryKey(), ...live } });
  const occupancy = useUpdateExternalOccupancy();
  const heartbeat = useHeartbeatTrip();
  const cancel = useCancelRideRequest();
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const end = useEndTrip();
  const accept = useAcceptRideRequest();
  const complete = useCompleteRideRequest();
  const { fail, ok, refresh } = useActionHelpers();
  const dirIdx = route.directions.findIndex((d) => d.id === trip.directionId);
  const otherTrips = (trips.data ?? []).filter((t) => t.id !== trip.id);
  const sendHeartbeat = heartbeat.mutate;
  useEffect(() => {
    const beat = () => sendHeartbeat({ data: { tripId: trip.id } });
    beat();
    const timer = window.setInterval(beat, 10_000);
    return () => window.clearInterval(timer);
  }, [trip.id, sendHeartbeat]);
  const changeOccupancy = (externalOccupied: number) => occupancy.mutate({
    data: { tripId: trip.id, externalOccupied, expectedVersion: trip.version! },
  }, { onSuccess: () => refresh(), onError: fail });

  return (
    <div className="grid gap-4 md:grid-cols-[1.05fr_1fr]">
      <div className="space-y-4">
        <div className={cn("relative overflow-hidden rounded-3xl p-5", dirIdx === 0 ? "bg-mandarin text-basalt" : "bg-teal text-chalk")} data-testid="panel-trip">
          <span className="ablaq absolute inset-x-0 top-0 h-1.5 opacity-70" />
          <div className="flex items-center justify-between">
            <span className="num rounded-md border-2 border-current px-2 text-sm font-bold" data-testid="text-plate">{trip.plate}</span>
            <DemoTag className="border-current/40 bg-transparent text-current" />
          </div>
          <p className="mt-3 text-sm opacity-80">{trip.directionName}</p>
          <AnimatePresence mode="wait">
            <motion.p
              key={trip.currentStopId}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="font-display text-3xl font-bold"
              data-testid="text-current-stop"
            >
              {trip.currentStopName}
            </motion.p>
          </AnimatePresence>
          <div className="mt-4 flex items-center gap-1.5" data-testid="seats">
            {Array.from({ length: trip.capacity }).map((_, i) => (
              <motion.span
                key={i}
                initial={false}
                animate={{ scale: i < trip.seatsTaken ? 1 : 0.85 }}
                className={cn("h-6 flex-1 rounded-md border-2 border-current", i < trip.seatsTaken ? "bg-basalt" : "bg-transparent opacity-50")}
              />
            ))}
          </div>
          <p className="mt-1.5 text-sm font-semibold">
            <span className="num">{trip.seatsTaken}</span> مشغول · <span className="num">{trip.seatsFree}</span> فارغ
          </p>
           <dl className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-white/20 p-3 text-sm">
             <div>السعة: <b>{trip.capacity}</b></div><div>المحجوز: <b>{trip.reservedSeats ?? 0}</b></div>
             <div>الصاعد عبر التطبيق: <b>{trip.boardedSeats ?? 0}</b></div><div>خارج التطبيق: <b>{trip.externalOccupancy ?? 0}</b></div>
             <div>المتاح: <b>{trip.seatsFree}</b></div>
           </dl>
           <div className="mt-3 flex items-center justify-between gap-3">
             <button aria-label="تقليل الركاب خارج التطبيق" onClick={() => changeOccupancy((trip.externalOccupancy ?? 0) - 1)}
               disabled={occupancy.isPending || !trip.externalOccupancy} className="h-14 w-16 rounded-xl bg-white/30 text-3xl disabled:opacity-40">−</button>
             <span className="text-sm font-bold">ركاب خارج التطبيق</span>
             <button aria-label="زيادة الركاب خارج التطبيق" onClick={() => changeOccupancy((trip.externalOccupancy ?? 0) + 1)}
               disabled={occupancy.isPending || trip.seatsFree <= 0} className="h-14 w-16 rounded-xl bg-white/30 text-3xl disabled:opacity-40">+</button>
           </div>
           <p className="mt-3 text-xs">آخر حضور: {fmtTime(trip.lastSeenAt)} · آخر موقع: {fmtTime(trip.lastLocationAt)} ({trip.locationSource})</p>
           {(trip.isStale || heartbeat.isError) && <p role="alert" className="mt-2 rounded-xl bg-chalk p-3 text-sm text-brick">الحضور قديم — لا يمكن قبول طلبات جديدة حتى عودة الاتصال. الحجوزات الحالية محفوظة حتى مهلتها.</p>}
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-2">
           <p className="p-3 text-xs text-muted-foreground">تحريك المركبة التجريبية متاح من شاشة الإدارة فقط. استخدم إجراءات السائق أثناء التوقف.</p>
          <button
            onClick={() => end.mutate(undefined, { onSuccess: () => { ok("انتهت الرحلة"); refresh(); }, onError: fail })}
             disabled={end.isPending || (trip.boardedSeats ?? 0) > 0}
            className="flex items-center gap-2 rounded-2xl border-2 border-brick/40 px-4 font-bold text-brick active:scale-95 disabled:opacity-50"
            data-testid="button-end-trip"
          >
            <Square className="h-4 w-4" /> إنهاء
          </button>
        </div>

        <LineMap
          stops={route.stops}
          directions={route.directions}
          trips={[trip, ...otherTrips]}
          currentStopId={trip.currentStopId}
          highlightTripId={trip.id}
        />
      </div>

      <div className="space-y-5">
        {reqs.isLoading && <><SkeletonBlock className="h-32" /><SkeletonBlock className="h-32" /></>}
        {reqs.isError && <ErrorState onRetry={() => reqs.refetch()} />}
        {reqs.data && (
          <>
            <section>
              <SectionTitle aside={<span className="num rounded-full bg-basalt px-2.5 py-0.5 text-xs font-bold text-limestone">{reqs.data.mine.length}</span>}>ركّابي</SectionTitle>
              <div className="space-y-3">
                {reqs.data.mine.length === 0 && <EmptyState icon={<Users className="h-5 w-5" />} title="لا ركّاب مقبولين" hint="اقبل طلباً من الأسفل وسيظهر هنا." />}
                <AnimatePresence>
                  {reqs.data.mine.map((r, i) => (
                    <ReqCard key={r.id} r={r} i={i}>
                      {r.status === "accepted" ? (
                         <div className="space-y-2">
                           <p className="text-xs">بانتظار تأكيد الراكب للصعود · نهاية المهلة {fmtTime(r.expiresAt)}</p>
                           {r.pickupPassed && <p role="alert" className="rounded-xl bg-brick-soft p-3 text-sm text-brick">تجاوزت نقطة التقاء هذا الراكب. لم يُسجّل صعود؛ عالج الطلب أو ألغِه مع سبب.</p>}
                           <input aria-label={`سبب إلغاء الطلب ${r.id}`} value={reasons[r.id] ?? ""} maxLength={300}
                             onChange={(e) => setReasons((v) => ({ ...v, [r.id]: e.target.value }))}
                             placeholder="سبب الإلغاء" className="w-full rounded-xl border p-3" />
                           <button onClick={() => cancel.mutate({ id: r.id, data: { reason: reasons[r.id] } },
                             { onSuccess: () => { ok("أُلغي الطلب"); refresh(); }, onError: fail })}
                             disabled={cancel.isPending || !reasons[r.id]?.trim()}
                             className="w-full rounded-xl border border-brick p-3 font-bold text-brick disabled:opacity-40">إلغاء مع سبب</button>
                         </div>
                      ) : (
                         <div>
                         <p className="mb-2 text-xs">أكد الراكب الصعود · {fmtTime(r.boardedAt)}</p>
                        <button
                          onClick={() => complete.mutate({ id: r.id }, { onSuccess: () => { ok("وصل الراكب", r.dropoffStop.name); refresh(); }, onError: fail })}
                          disabled={complete.isPending}
                          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-olive py-2.5 font-bold text-chalk active:scale-[0.98] disabled:opacity-50"
                          data-testid={`button-complete-${r.id}`}
                        >
                          {complete.isPending && complete.variables?.id === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flag className="h-4 w-4" />}
                          نزل الراكب — إنهاء
                        </button>
                         </div>
                      )}
                    </ReqCard>
                  ))}
                </AnimatePresence>
              </div>
            </section>
            <section>
              <SectionTitle aside={<span className="num rounded-full bg-mandarin px-2.5 py-0.5 text-xs font-bold text-basalt">{reqs.data.available.length}</span>}>ينتظرون أمامك</SectionTitle>
              <div className="space-y-3">
                {reqs.data.available.length === 0 && <EmptyState title="لا أحد ينتظر على طريقك" hint="الطلبات في اتجاهك وأمام موقفك الحالي تظهر هنا تلقائياً." />}
                <AnimatePresence>
                  {reqs.data.available.map((r, i) => (
                    <ReqCard key={r.id} r={r} i={i}>
                      <button
                        onClick={() => accept.mutate({ id: r.id }, { onSuccess: (accepted) => { ok("قبلت الطلب", `${accepted.passengerName ?? "الراكب"} عند ${r.pickupStop.name}`); refresh(); }, onError: fail })}
                         disabled={accept.isPending || trip.seatsFree <= 0 || trip.isStale}
                        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-mandarin py-3 font-display font-bold text-basalt active:scale-[0.97] disabled:opacity-50"
                        data-testid={`button-accept-${r.id}`}
                      >
                        {accept.isPending && accept.variables?.id === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-5 w-5" />}
                        {trip.seatsFree <= 0 ? "لا مقاعد فارغة" : "اقبل الراكب"}
                      </button>
                    </ReqCard>
                  ))}
                </AnimatePresence>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function DriverBody() {
  const state = useGetDriverState({ query: { queryKey: getGetDriverStateQueryKey(), ...live } });
  const route = useGetRoute({ query: { queryKey: getGetRouteQueryKey() } });
  if (state.isLoading || route.isLoading) return <div className="grid gap-4 md:grid-cols-2"><SkeletonBlock className="h-80" /><SkeletonBlock className="h-80" /></div>;
  if (state.isError || route.isError || !state.data || !route.data) return <ErrorState onRetry={() => { state.refetch(); route.refetch(); }} />;
  return state.data.trip && state.data.trip.status === "active"
    ? <OnTrip state={state.data} route={route.data} />
    : <StartTrip state={state.data} route={route.data} />;
}

export default function DriverPage() {
  return <Guard role="driver">{() => <DriverBody />}</Guard>;
}
