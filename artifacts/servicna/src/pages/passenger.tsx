import { useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bus, Check, Crosshair, FlaskConical, Hand, Loader2, MapPin, MapPinOff, Navigation, Send, X } from "lucide-react";
import {
  getGetActiveRequestQueryKey, getGetRouteQueryKey, getListLiveTripsQueryKey,
  useCancelRideRequest, useCreateRideRequest, useGetActiveRequest, useGetRoute, useListLiveTrips, useSuggestRoute, useBoardRideRequest,
  type ActiveRequest, type RouteDetail, type Stop, type SuggestionInput, type SuggestionResult, type TripSummary,
} from "@workspace/api-client-react";
import { Guard } from "@/components/shell";
import { LineMap } from "@/components/line-map";
import { DemoTag, ErrorState, Panel, SectionTitle, SkeletonBlock, StopsRoute, Timeline } from "@/components/kit";
import { POLL, STATUS_LABEL, STATUS_STYLE, errorMessage, fmtMeters, fmtTime, useActionHelpers } from "@/lib/app";
import { cn } from "@/lib/utils";

type Mode = "gps" | "manual" | "demo";
type Pt = { lat: number; lng: number };
type DestChoice = { kind: "stop"; stopId: number } | { kind: "outside" } | null;

// Clearly far from the demo line (used only to test the out-of-range answer)
const OUTSIDE_POINT: Pt = { lat: 34.6402, lng: 36.5121 };

function fmtDist(m: number | null) {
  return m == null ? null : fmtMeters(m);
}

function Planner({ route, trips }: { route: RouteDetail; trips: TripSummary[] }) {
  const dirs = route.directions;
  const stopsByDir = useMemo(() => {
    const m = new Map<number, Stop[]>();
    for (const d of dirs) m.set(d.id, route.stops.filter((s) => s.directionId === d.id).sort((a, b) => a.seq - b.seq));
    return m;
  }, [route.stops, dirs]);

  const [mode, setMode] = useState<Mode | null>(null);
  const [directionId, setDirectionId] = useState<number | null>(null);
  const [pickupId, setPickupId] = useState<number | null>(null);
  const [dropoffId, setDropoffId] = useState<number | null>(null);
  const [origin, setOrigin] = useState<Pt | null>(null);
  const [dest, setDest] = useState<DestChoice>(null);
  const [locating, setLocating] = useState(false);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  const [result, setResult] = useState<SuggestionResult | null>(null);
  const [suggestErr, setSuggestErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const token = useRef(0);
  const gpsToken = useRef(0);

  const suggest = useSuggestRoute();
  const create = useCreateRideRequest();
  const { fail, ok, refresh } = useActionHelpers();

  /** Any input change: invalidate in-flight responses and clear stale suggestion/selection */
  const invalidate = () => {
    token.current += 1;
    setResult(null); setSuggestErr(null); setLoading(false); setSelected(null); setConfirmed(false);
  };

  const chooseMode = (m: Mode) => {
    invalidate();
    gpsToken.current += 1;
    setMode(m); setGeoMsg(null); setLocating(false);
    setPickupId(null); setDropoffId(null); setDest(null); setOrigin(null);
    if (m === "demo") {
      const first = stopsByDir.get(dirs[0]?.id ?? -1)?.[0];
      if (first) setOrigin({ lat: first.lat + 0.0012, lng: first.lng - 0.0009 });
    }
    if (m === "gps") requestGps();
  };

  const requestGps = () => {
    if (!("geolocation" in navigator)) { setGeoMsg("المتصفح لا يدعم تحديد الموقع. يمكنك اختيار نقطة يدويًا."); return; }
    const t = ++gpsToken.current;
    setLocating(true); setGeoMsg(null);
    navigator.geolocation.getCurrentPosition(
      (p) => { if (t !== gpsToken.current) return; setLocating(false); invalidate(); setOrigin({ lat: p.coords.latitude, lng: p.coords.longitude }); },
      (e) => {
        if (t !== gpsToken.current) return;
        setLocating(false);
        setGeoMsg(e.code === e.TIMEOUT ? "انتهت مهلة تحديد الموقع. اختر نقطة يدويًا أو أعد المحاولة." : "لم نحصل على إذن الموقع. اختر نقطة يدويًا، فهذا يعمل دون GPS.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  };

  const setDir = (id: number) => { invalidate(); setDirectionId(id); setPickupId(null); setDropoffId(null); };
  const setPick = (id: number) => { invalidate(); setPickupId(id); setDropoffId(null); };
  const setDrop = (id: number) => { invalidate(); setDropoffId(id); };
  const setDestination = (d: DestChoice) => { invalidate(); setDest(d); };

  const dirStops = directionId != null ? stopsByDir.get(directionId) ?? [] : [];
  const pickSeq = dirStops.find((s) => s.id === pickupId)?.seq;
  const destStop = dest?.kind === "stop" ? route.stops.find((s) => s.id === dest.stopId) : undefined;
  const destPt: Pt | null = dest?.kind === "outside" ? OUTSIDE_POINT : destStop ? { lat: destStop.lat, lng: destStop.lng } : null;

  const ready = mode === "manual" ? pickupId != null && dropoffId != null : origin != null && destPt != null;

  const runSuggest = () => {
    if (!ready) return;
    const t = ++token.current;
    setLoading(true); setResult(null); setSuggestErr(null); setSelected(null); setConfirmed(false);
    const data: SuggestionInput = mode === "manual"
      ? { mode: "manual", pickupStopId: pickupId!, dropoffStopId: dropoffId! }
      : { mode: "coordinates", originLat: origin!.lat, originLng: origin!.lng, destinationLat: destPt!.lat, destinationLng: destPt!.lng };
    suggest.mutate({ data }, {
      onSuccess: (r) => { if (t !== token.current) return; setLoading(false); setResult(r); },
      onError: (e) => { if (t !== token.current) return; setLoading(false); setSuggestErr(errorMessage(e)); },
    });
  };

  const chosen = selected != null ? result?.suggestions[selected] ?? null : null;

  const send = () => {
    if (!chosen || !confirmed) return;
    const s = chosen;
    create.mutate(
      { data: { directionId: s.directionId, pickupStopId: s.pickupStop.id, dropoffStopId: s.dropoffStop.id } },
      {
        onSuccess: () => {
          ok("أُرسل طلبك", `نقطة الالتقاء: ${s.pickupStop.name}. الطلب غير مقبول بعد حتى يقبله سائق.`);
          refresh();
        },
        onError: fail,
      },
    );
  };

  const dirName = (id: number) => dirs.find((d) => d.id === id)?.name ?? "";
  const anyTrips = result?.suggestions.some((s) => s.availableTrips.length > 0);

  const modeBtn = (m: Mode, icon: ReactNode, label: string, hint: string) => (
    <button
      onClick={() => chooseMode(m)}
      aria-pressed={mode === m}
      className={cn("flex items-start gap-3 rounded-2xl border-2 p-3 text-right transition active:scale-[0.98]", mode === m ? "border-mandarin bg-mandarin-soft" : "border-basalt/10 bg-chalk hover:border-basalt/30")}
      data-testid={`button-mode-${m}`}
    >
      <span className="mt-0.5">{m === "gps" && locating ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}</span>
      <span><span className="block font-bold">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
    </button>
  );

  const chip = (active: boolean, onClick: () => void, label: ReactNode, testId: string, disabled = false, tone: "m" | "t" = "m") => (
    <button
      key={testId}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-1.5 text-sm font-semibold transition active:scale-95 disabled:opacity-30",
        active ? (tone === "m" ? "border-mandarin bg-mandarin text-basalt" : "border-teal bg-teal text-chalk") : "border-basalt/15 bg-chalk hover:border-basalt/40",
      )}
      data-testid={testId}
    >
      {label}
    </button>
  );

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_1.05fr]">
      <div className="space-y-4">
        <Panel testId="panel-planner">
          <h1 className="font-display text-2xl font-bold leading-tight">من وين، ولوين؟</h1>
          <p className="mt-1 text-sm text-muted-foreground">اختر طريقة تحديد نقطتك. لا نطلب موقعك إلا إذا ضغطت على زر الموقع.</p>

          <div className="mt-4 grid gap-2">
            {modeBtn("gps", <Crosshair className="h-4 w-4" />, "استخدم موقعي الحالي", "يطلب إذن الموقع الآن فقط")}
            {modeBtn("manual", <Hand className="h-4 w-4" />, "اختَر نقطة يدويًا", "دون GPS: اختر الاتجاه والموقفين")}
            {modeBtn("demo", <FlaskConical className="h-4 w-4" />, "جرّب موقعًا توضيحيًا", "نقطة انطلاق افتراضية قرب الخط")}
          </div>

          {mode === "gps" && (
            <div className="mt-3 rounded-2xl bg-limestone p-3 text-sm" data-testid="state-gps">
              {locating && <p>جارٍ طلب الموقع...</p>}
              {!locating && origin && <p className="font-semibold text-teal">تم تحديد موقعك التقريبي.</p>}
              {geoMsg && (
                <div className="space-y-2">
                  <p className="font-semibold text-brick" data-testid="text-geo-error">{geoMsg}</p>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={requestGps} className="rounded-full border border-basalt/20 bg-chalk px-3 py-1 text-xs font-bold" data-testid="button-gps-retry">أعد المحاولة</button>
                    <button onClick={() => chooseMode("manual")} className="rounded-full bg-basalt px-3 py-1 text-xs font-bold text-limestone" data-testid="button-gps-fallback-manual">اختَر نقطة يدويًا</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {mode === "demo" && <p className="mt-3 rounded-2xl bg-limestone p-3 text-xs" data-testid="text-demo-origin">نقطة انطلاق توضيحية، ليست موقعك الحقيقي.</p>}

          {mode === "manual" && (
            <div className="mt-4 space-y-3">
              <div>
                <p className="mb-1.5 text-xs font-semibold text-muted-foreground">١. اتجاه الركوب (لأن أسماء المواقف تتكرر في الاتجاهين)</p>
                <div className="grid grid-cols-2 gap-2">
                  {dirs.map((d, i) => (
                    <button
                      key={d.id}
                      onClick={() => setDir(d.id)}
                      aria-pressed={directionId === d.id}
                      className={cn("rounded-2xl border-2 p-2.5 text-right text-sm transition", directionId === d.id ? (i === 0 ? "border-mandarin bg-mandarin-soft" : "border-teal bg-teal-soft") : "border-basalt/10 bg-chalk")}
                      data-testid={`button-direction-${d.id}`}
                    >
                      <span className="block font-bold">{d.name}</span>
                      <span className="block text-[11px] text-muted-foreground">{d.fromName} ← {d.toName}</span>
                    </button>
                  ))}
                </div>
              </div>
              {directionId != null && (
                <>
                  <div>
                    <p className="mb-1.5 text-xs font-semibold text-muted-foreground">٢. موقف الصعود</p>
                    <div className="flex flex-wrap gap-1.5">
                      {dirStops.slice(0, -1).map((s) => chip(pickupId === s.id, () => setPick(s.id), s.name, `button-pickup-${s.id}`))}
                    </div>
                  </div>
                  {pickupId != null && (
                    <div>
                      <p className="mb-1.5 text-xs font-semibold text-muted-foreground">٣. موقف النزول</p>
                      <div className="flex flex-wrap gap-1.5">
                        {dirStops.filter((s) => pickSeq != null && s.seq > pickSeq).map((s) => chip(dropoffId === s.id, () => setDrop(s.id), s.name, `button-dropoff-${s.id}`, false, "t"))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {(mode === "gps" || mode === "demo") && origin && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">الوجهة: اختر موقفًا (الاسم مع الاتجاه)</p>
              {dirs.map((d) => (
                <div key={d.id}>
                  <p className="mb-1 text-[11px] font-bold">{d.name}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(stopsByDir.get(d.id) ?? []).map((s) => chip(dest?.kind === "stop" && dest.stopId === s.id, () => setDestination({ kind: "stop", stopId: s.id }), s.name, `button-dest-${s.id}`, false, "t"))}
                  </div>
                </div>
              ))}
              <button
                onClick={() => setDestination({ kind: "outside" })}
                aria-pressed={dest?.kind === "outside"}
                className={cn("mt-1 inline-flex items-center gap-2 rounded-full border border-dashed px-3 py-1.5 text-xs font-bold", dest?.kind === "outside" ? "border-brick bg-brick-soft text-brick" : "border-basalt/30")}
                data-testid="button-dest-outside"
              >
                <MapPinOff className="h-3.5 w-3.5" /> اختبار: وجهة خارج الخط
              </button>
            </div>
          )}

          <button
            onClick={runSuggest}
            disabled={!ready || loading}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-basalt py-3.5 font-display text-lg font-bold text-limestone transition active:scale-[0.98] disabled:opacity-40"
            data-testid="button-suggest"
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Navigation className="h-5 w-5" />}
            اعرض الاقتراحات
          </button>
          {suggestErr && <p className="mt-2 text-sm font-semibold text-brick" data-testid="text-suggest-error">{suggestErr}</p>}
        </Panel>

        <AnimatePresence mode="popLayout">
          {result && (
            <motion.div key={token.current} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-3">
              <SectionTitle aside={<DemoTag />}>الاقتراحات</SectionTitle>
              {result.suggestions.length === 0 && (
                <div className="rounded-3xl border border-dashed border-brick/40 bg-brick-soft p-5 text-center font-bold text-brick" data-testid="state-no-suggestions">
                  الوجهة خارج نطاق الخط التجريبي
                </div>
              )}
              {result.suggestions.length > 0 && !anyTrips && (
                <div className="rounded-3xl bg-teal-soft p-4 text-center font-bold text-teal" data-testid="state-no-trips">
                  الخط مناسب، ولا يوجد سرفيس متاح الآن
                </div>
              )}
              {result.suggestions.length > 0 && <p className="text-xs text-muted-foreground">اختر اقتراحًا واحدًا لمتابعة الطلب.</p>}
              <div role="radiogroup" aria-label="الاقتراحات" className="space-y-3">
                {result.suggestions.map((s, i) => {
                  const isSel = selected === i;
                  const walkTo = fmtDist(s.walkToPickupMeters);
                  const walkFrom = fmtDist(s.walkFromDropoffMeters);
                  return (
                    <motion.div
                      key={`${s.directionId}-${s.pickupStop.id}-${s.dropoffStop.id}`}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.08 }}
                      role="radio"
                      aria-checked={isSel}
                      tabIndex={0}
                      onClick={() => { setSelected(i); setConfirmed(false); }}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(i); setConfirmed(false); } }}
                      className={cn("cursor-pointer overflow-hidden rounded-3xl border-2 bg-card transition", isSel ? "border-mandarin" : "border-basalt/10 hover:border-basalt/30")}
                      data-testid={`card-suggestion-${i}`}
                    >
                      <div className="flex items-center justify-between gap-2 bg-basalt px-4 py-2.5 text-limestone">
                        <span className="min-w-0">
                          <span className="block truncate text-[11px] text-limestone/70">{route.name}</span>
                          <span className="font-display font-bold">{s.directionName || dirName(s.directionId)}</span>
                        </span>
                        <span className={cn("grid h-5 w-5 shrink-0 place-items-center rounded-full border-2", isSel ? "border-mandarin bg-mandarin" : "border-limestone/50")}>
                          {isSel && <Check className="h-3 w-3 text-basalt" />}
                        </span>
                      </div>
                      <div className="space-y-3 p-4">
                        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
                          <MapPin className="mt-0.5 h-4 w-4 text-mandarin" />
                          <span>الصعود: <b>{s.pickupStop.name}</b>{walkTo && <span className="text-muted-foreground"> · مسافة مباشرة تقريبية <b className="num">{walkTo}</b></span>}</span>
                          <Bus className="mt-0.5 h-4 w-4" />
                          <span>النزول: <b>{s.dropoffStop.name}</b> <span className="num text-muted-foreground">({s.stopsCount} مواقف)</span></span>
                          {walkFrom && (<><MapPin className="mt-0.5 h-4 w-4 text-teal" /><span className="text-muted-foreground">إلى الوجهة: مسافة مباشرة تقريبية <b className="num">{walkFrom}</b></span></>)}
                        </div>
                        <div>
                          <p className="mb-1.5 text-xs font-semibold text-muted-foreground">سرافيس متاحة مبدئيًا (غير محجوزة لك)</p>
                          {s.availableTrips.length === 0 ? (
                            <p className="rounded-xl bg-limestone p-2.5 text-xs">لا يوجد سرفيس متاح الآن على هذا الاتجاه.</p>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {s.availableTrips.map((t) => (
                                <span key={t.tripId} className="rounded-xl border border-basalt/10 bg-chalk px-2.5 py-1.5 text-xs" data-testid={`trip-option-${t.tripId}`}>
                                  <b className="num">{t.plate}</b> · {t.stopsAway === 0 ? "عند الموقف" : `يبعد ${t.stopsAway} مواقف`} · <b className="num">{t.seatsFree}</b> مقاعد · متاحة مبدئيًا
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </div>

              {chosen && (
                <Panel testId="panel-confirm">
                  <p className="text-xs font-semibold text-muted-foreground">نقطة الالتقاء</p>
                  <p className="font-display text-xl font-bold" data-testid="text-meeting-point">{chosen.pickupStop.name}</p>
                  <p className="text-xs text-muted-foreground">{chosen.directionName} · إلى {chosen.dropoffStop.name}</p>
                  <label className="mt-3 flex items-start gap-2 text-sm">
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1 h-4 w-4 accent-[#f2620f]" data-testid="checkbox-confirm-meeting" />
                    أؤكد أنني سأنتظر عند هذه النقطة. الطلب لا يعني حجز سرفيس محدد حتى يقبله سائق.
                  </label>
                  <button
                    onClick={send}
                    disabled={!confirmed || create.isPending}
                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-mandarin py-3 font-display font-bold text-basalt transition active:scale-[0.97] disabled:opacity-40"
                    data-testid="button-request"
                  >
                    {create.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
                    {create.isError ? "أعد المحاولة" : "اطلب سرفيس"}
                  </button>
                </Panel>
              )}
              <p className="text-xs text-muted-foreground" data-testid="text-suggest-note">{result.note}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="space-y-2 md:sticky md:top-32 md:self-start">
        <LineMap
          stops={route.stops}
          directions={dirs}
          trips={trips}
          focusDirectionId={chosen?.directionId ?? (mode === "manual" ? directionId : null)}
          pickupId={chosen?.pickupStop.id ?? (mode === "manual" ? pickupId : null)}
          dropoffId={chosen?.dropoffStop.id ?? (mode === "manual" ? dropoffId : null)}
          selectedId={destStop?.id}
          origin={mode !== "manual" ? origin : null}
          destination={dest?.kind === "outside" ? OUTSIDE_POINT : null}
        />
        <p className="text-xs text-muted-foreground">{trips.length} سرفيس على الخط الآن · المواقع محاكاة</p>
      </div>
    </div>
  );
}

const FLOW = ["pending", "accepted", "boarded", "completed"] as const;

function Tracking({ active, route, trips }: { active: ActiveRequest; route: RouteDetail; trips: TripSummary[] }) {
  const r = active.request!;
  const board = useBoardRideRequest();
  const cancel = useCancelRideRequest();
  const { fail, ok, refresh } = useActionHelpers();
  const st = STATUS_STYLE[r.status];
  const step = FLOW.indexOf(r.status as (typeof FLOW)[number]);
  const myTrip = trips.find((t) => t.id === r.tripId);

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_1.05fr]">
      <div className="space-y-4">
        {r.status === "accepted" && <button
          onClick={() => board.mutate({ id: r.id }, { onSuccess: () => { ok("حُفظ تأكيدك للصعود"); refresh(); }, onError: fail })}
          disabled={board.isPending} className="w-full rounded-2xl bg-basalt p-4 font-bold text-chalk disabled:opacity-50"
          data-testid="button-passenger-board">إي، ركبت</button>}
        <motion.div layout className={cn("relative overflow-hidden rounded-3xl p-5 transition-colors duration-500", st.panel)} data-testid="panel-active-request">
          <div className="ablaq absolute inset-x-0 top-0 h-1.5 opacity-60" />
          <p className="num text-xs opacity-70">طلب #{r.id} · {r.directionName}</p>
          <AnimatePresence mode="wait">
            <motion.h1
              key={r.status}
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}
              className="mt-2 flex items-center gap-3 font-display text-3xl font-bold"
              data-testid="text-active-status"
            >
              {r.status === "pending" && (
                <span className="relative flex h-3.5 w-3.5"><span className="ping-soft absolute inset-0 rounded-full bg-basalt" /><span className="relative h-3.5 w-3.5 rounded-full bg-basalt" /></span>
              )}
              {STATUS_LABEL[r.status]}
            </motion.h1>
          </AnimatePresence>
          <p className="mt-1 text-sm opacity-85">
            {r.status === "pending" && `السائقون في هذا الاتجاه يرون طلبك. ينتهي الطلب ${fmtTime(r.expiresAt)}.`}
            {r.status === "accepted" && `نقطة الالتقاء الثابتة: ${r.pickupStop.name} — السرفيس في طريقه إليك.`}
            {r.status === "boarded" && `أنت على متن السرفيس. انزل عند ${r.dropoffStop.name}.`}
          </p>
          <div className="mt-4 flex gap-1.5">
            {FLOW.map((f, i) => (
              <span key={f} className="h-1.5 flex-1 overflow-hidden rounded-full bg-current/20">
                <motion.span
                  className="block h-full origin-right rounded-full bg-current"
                  initial={false}
                  animate={{ scaleX: i <= step ? 1 : 0 }}
                  transition={{ duration: 0.6, delay: i * 0.08 }}
                />
              </span>
            ))}
          </div>
        </motion.div>

        <AnimatePresence>
          {r.driverName && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
              <Panel testId="panel-driver">
                <div className="flex items-center gap-3">
                  <div className="grid h-12 w-12 place-items-center rounded-2xl bg-teal font-display text-lg font-bold text-chalk">{r.driverName.slice(0, 1)}</div>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold" data-testid="text-driver-name">{r.driverName}</p>
                    <p className="text-sm text-muted-foreground" data-testid="text-vehicle-description">{r.vehicleLabel}</p>
                    <p className="num inline-block rounded-md border-2 border-basalt bg-chalk px-2 text-sm font-semibold" data-testid="text-vehicle-plate">{r.vehiclePlate}</p>
                  </div>
                </div>
                {r.status === "accepted" && (
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <div className="rounded-2xl bg-limestone p-3">
                      <p className="text-[11px] text-muted-foreground">السرفيس الآن عند</p>
                      <p className="font-bold" data-testid="text-trip-current-stop">{r.tripCurrentStopName ?? "—"}</p>
                    </div>
                    <div className="rounded-2xl bg-mandarin-soft p-3">
                      <p className="text-[11px] text-muted-foreground">يبعد عنك</p>
                      <p className="font-display text-xl font-bold" data-testid="text-stops-away">
                        {r.stopsAway === 0 ? "وصل موقفك" : r.stopsAway == null ? "—" : `${r.stopsAway} مواقف`}
                      </p>
                    </div>
                  </div>
                )}
              </Panel>
            </motion.div>
          )}
        </AnimatePresence>

        <Panel>
          <p className="mb-2 text-xs font-semibold text-muted-foreground" data-testid="text-fixed-meeting">نقطة الالتقاء ثابتة: {r.pickupStop.name} · {r.directionName}</p>
          <StopsRoute from={r.pickupStop.name} to={r.dropoffStop.name} />
          {(r.status === "pending" || r.status === "accepted") && (
            <button
              onClick={() => cancel.mutate({ id: r.id }, { onSuccess: () => { ok("أُلغي الطلب"); refresh(); }, onError: fail })}
              disabled={cancel.isPending}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-brick/40 py-2.5 font-bold text-brick transition active:scale-[0.98] disabled:opacity-50"
              data-testid="button-cancel-request"
            >
              {cancel.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
              إلغاء الطلب
            </button>
          )}
        </Panel>
      </div>

      <div className="space-y-4">
        <LineMap
          stops={route.stops}
          directions={route.directions}
          trips={trips}
          pickupId={r.pickupStop.id}
          dropoffId={r.dropoffStop.id}
          highlightTripId={myTrip?.id}
        />
        <Panel>
          <SectionTitle>تسلسل الطلب</SectionTitle>
          <Timeline events={active.events} />
        </Panel>
      </div>
    </div>
  );
}

function PassengerBody() {
  const route = useGetRoute({ query: { queryKey: getGetRouteQueryKey() } });
  const active = useGetActiveRequest({ query: { queryKey: getGetActiveRequestQueryKey(), refetchInterval: POLL, refetchOnWindowFocus: true, refetchOnReconnect: true } });
  const trips = useListLiveTrips({ query: { queryKey: getListLiveTripsQueryKey(), refetchInterval: POLL, refetchOnWindowFocus: true, refetchOnReconnect: true } });

  if (route.isLoading || active.isLoading) {
    return <div className="grid gap-4 md:grid-cols-2"><SkeletonBlock className="h-96" /><SkeletonBlock className="h-64" /></div>;
  }
  if (route.isError || active.isError || !route.data || !active.data) {
    return <ErrorState onRetry={() => { route.refetch(); active.refetch(); }} />;
  }
  const t = trips.data ?? [];
  return active.data.hasActive && active.data.request
    ? <Tracking active={active.data} route={route.data} trips={t} />
    : <Planner route={route.data} trips={t} />;
}

export default function PassengerPage() {
  return <Guard role="passenger">{() => <PassengerBody />}</Guard>;
}
