import { useMemo } from "react";
import type { Direction, Stop, TripSummary } from "@workspace/api-client-react";

type Props = {
  stops: Stop[];
  directions?: Direction[];
  trips?: TripSummary[];
  pickupId?: number | null;
  dropoffId?: number | null;
  currentStopId?: number | null;
  selectedId?: number | null;
  origin?: { lat: number; lng: number } | null;
  destination?: { lat: number; lng: number } | null;
  onStopClick?: (stop: Stop) => void;
  highlightTripId?: number | null;
  focusDirectionId?: number | null;
  testId?: string;
};

const W = 400;
const H = 260;
const PAD = 34;
const COLORS = ["#f2620f", "#0f6e6e"];

export function LineMap({
  stops, directions = [], trips = [], pickupId, dropoffId, currentStopId, selectedId, origin, destination,
  onStopClick, highlightTripId, focusDirectionId, testId = "map-line",
}: Props) {
  const project = useMemo(() => {
    const pts: { lat: number; lng: number }[] = [...stops, ...directions.flatMap((d) => d.geometry ?? [])];
    if (!pts.length) return (_lat: number, _lng: number) => ({ x: W / 2, y: H / 2 });
    const lats = pts.map((s) => s.lat);
    const lngs = pts.map((s) => s.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const k = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
    const dx = Math.max((maxLng - minLng) * k, 1e-6);
    const dy = Math.max(maxLat - minLat, 1e-6);
    const scale = Math.min((W - PAD * 2) / dx, (H - PAD * 2) / dy);
    const ox = (W - dx * scale) / 2;
    const oy = (H - dy * scale) / 2;
    return (lat: number, lng: number) => ({
      x: Math.min(W - 10, Math.max(10, ox + (lng - minLng) * k * scale)),
      y: Math.min(H - 10, Math.max(10, H - (oy + (lat - minLat) * scale))),
    });
  }, [stops, directions]);

  const dirIndex = (id: number) => Math.max(0, directions.findIndex((d) => d.id === id));
  // small perpendicular-ish offset so two independent directions remain visually separate
  const shift = (idx: number) => (idx === 0 ? -3 : 3);
  const o = origin ? project(origin.lat, origin.lng) : null;
  const de = destination ? project(destination.lat, destination.lng) : null;

  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-basalt/10 bg-chalk" data-testid={testId}>
      <div className="flex items-center gap-2 bg-basalt px-3 py-1.5 text-[11px] font-bold text-limestone" data-testid="text-map-disclaimer">
        <span className="h-2 w-2 shrink-0 rounded-full bg-mandarin" />
        المسار والنقاط تجريبية وغير معتمدة للملاحة
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="مخطط محلي تجريبي لاتجاهي الخط في حمص">
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" stroke="#1e1b18" strokeOpacity=".05" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#grid)" />

        {directions.map((d, idx) => {
          const geo = d.geometry?.length ? d.geometry : stops.filter((s) => s.directionId === d.id).sort((a, b) => a.seq - b.seq);
          const path = geo.map((g, i) => { const p = project(g.lat, g.lng); return `${i ? "L" : "M"}${p.x.toFixed(1)},${(p.y + shift(idx)).toFixed(1)}`; }).join(" ");
          const dim = focusDirectionId != null && focusDirectionId !== d.id;
          return (
            <g key={d.id} opacity={dim ? 0.25 : 1} data-testid={`map-direction-${d.id}`}>
              <path d={path} fill="none" stroke="#1e1b18" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
              <path d={path} fill="none" stroke={COLORS[idx % 2]} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          );
        })}

        {o && (
          <g>
            <circle cx={o.x} cy={o.y} r="7" fill="#0f6e6e" className="ping-soft" />
            <circle cx={o.x} cy={o.y} r="6" fill="#0f6e6e" stroke="#faf6ef" strokeWidth="2.5" />
            <text x={o.x} y={o.y - 12} textAnchor="middle" fontSize="9" fontWeight="700" fill="#0f6e6e" paintOrder="stroke" stroke="#faf6ef" strokeWidth="3">نقطة الانطلاق</text>
          </g>
        )}
        {de && (
          <g>
            <rect x={de.x - 6} y={de.y - 6} width="12" height="12" fill="#b13a2a" stroke="#faf6ef" strokeWidth="2" transform={`rotate(45 ${de.x} ${de.y})`} />
            <text x={de.x} y={de.y - 12} textAnchor="middle" fontSize="9" fontWeight="700" fill="#b13a2a" paintOrder="stroke" stroke="#faf6ef" strokeWidth="3">الوجهة</text>
          </g>
        )}

        {stops.map((s) => {
          const idx = dirIndex(s.directionId);
          const p = project(s.lat, s.lng);
          const y = p.y + shift(idx);
          const isPick = s.id === pickupId;
          const isDrop = s.id === dropoffId;
          const isCur = s.id === currentStopId;
          const isSel = s.id === selectedId;
          const hot = isPick || isDrop || isCur || isSel;
          const dim = focusDirectionId != null && focusDirectionId !== s.directionId && !hot;
          const r = hot ? 7.5 : 4.5;
          const fill = isPick ? "#f2620f" : isDrop ? "#0f6e6e" : isCur ? "#f2620f" : isSel ? "#0f6e6e" : "#faf6ef";
          const showLabel = hot || (focusDirectionId != null ? focusDirectionId === s.directionId : idx === 0);
          return (
            <g
              key={s.id}
              opacity={dim ? 0.3 : 1}
              onClick={onStopClick ? () => onStopClick(s) : undefined}
              style={{ cursor: onStopClick ? "pointer" : "default" }}
              data-testid={`map-stop-${s.id}`}
            >
              <circle cx={p.x} cy={y} r="13" fill="transparent" />
              {isCur && <circle cx={p.x} cy={y} r="8" fill="#f2620f" className="ping-soft" />}
              <circle cx={p.x} cy={y} r={r} fill={fill} stroke={COLORS[idx % 2]} strokeWidth="2.5" />
              {showLabel && (
                <text
                  x={p.x} y={idx === 0 ? y - 12 : y + 19} textAnchor="middle" fontSize="9"
                  fontWeight={hot ? 700 : 500}
                  fill={isPick ? "#c24c06" : isDrop ? "#0f6e6e" : "#1e1b18"}
                  paintOrder="stroke" stroke="#faf6ef" strokeWidth="3"
                >
                  {isPick ? `التقاء: ${s.name}` : isDrop ? `نزول: ${s.name}` : s.name}
                </text>
              )}
            </g>
          );
        })}

        {trips.map((t) => {
          const pos = project(t.lat, t.lng);
          const idx = dirIndex(t.directionId);
          const off = idx === 0 ? -14 : 14;
          const hl = highlightTripId === t.id;
          const color = COLORS[idx % 2];
          return (
            <g
              key={t.id}
              style={{ transform: `translate(${pos.x}px, ${pos.y + off}px)`, transition: "transform 1.1s cubic-bezier(.2,.8,.2,1)" }}
              data-testid={`map-trip-${t.id}`}
            >
              {hl && <circle r="11" fill={color} className="ping-soft" />}
              <rect x="-17" y="-8" width="34" height="16" rx="5" fill={color} stroke="#1e1b18" strokeWidth={hl ? 2.5 : 1.5} />
              <text y="3.5" textAnchor="middle" fontSize="8.5" fontWeight="700" fill={idx === 0 ? "#1e1b18" : "#faf6ef"} className="num">
                {t.seatsFree} مقعد
              </text>
            </g>
          );
        })}
      </svg>
      <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-1.5 text-[10px] font-semibold">
        {directions.slice(0, 2).map((d, i) => (
          <span key={d.id} className="flex items-center gap-1 rounded-full bg-chalk/90 px-2 py-0.5 shadow-sm">
            <span className={`h-2 w-3 rounded-sm ${i === 0 ? "bg-mandarin" : "bg-teal"}`} />
            {d.name}
          </span>
        ))}
      </div>
    </div>
  );
}
