import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import type { RequestStatus, UserRole } from "@workspace/api-client-react";

export const POLL = () => typeof document !== "undefined" && document.hidden ? 15_000 : 3000;

export const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "بانتظار القبول",
  accepted: "مقبول",
  boarded: "أكد الراكب الصعود",
  completed: "مكتمل",
  cancelled: "ملغى",
  expired: "منتهي المهلة",
};

export const STATUS_STYLE: Record<RequestStatus, { chip: string; dot: string; panel: string }> = {
  pending: { chip: "bg-mandarin-soft text-[#8a3405] border-mandarin/40", dot: "bg-mandarin", panel: "bg-mandarin text-basalt" },
  accepted: { chip: "bg-teal-soft text-teal border-teal/30", dot: "bg-teal", panel: "bg-teal text-chalk" },
  boarded: { chip: "bg-basalt text-limestone border-basalt", dot: "bg-basalt", panel: "bg-basalt text-limestone" },
  completed: { chip: "bg-olive-soft text-olive border-olive/30", dot: "bg-olive", panel: "bg-olive text-chalk" },
  cancelled: { chip: "bg-brick-soft text-brick border-brick/30 line-through decoration-1", dot: "bg-brick", panel: "bg-brick text-chalk" },
  expired: { chip: "bg-stone-soft text-stone border-stone/30", dot: "bg-stone", panel: "bg-stone text-chalk" },
};

export const ROLE_LABEL: Record<string, string> = {
  passenger: "راكب",
  driver: "سائق",
  admin: "إدارة",
  system: "النظام",
};

export function roleHome(role: UserRole | string | undefined) {
  if (role === "driver") return "/driver";
  if (role === "admin") return "/admin";
  return "/passenger";
}

export function errorMessage(err: unknown): string {
  const e = err as { data?: { message?: string }; status?: number; message?: string } | null;
  if (e?.data && typeof e.data === "object" && typeof e.data.message === "string") return e.data.message;
  if (typeof navigator !== "undefined" && !navigator.onLine) return "لا يوجد اتصال بالإنترنت. حاول مجدداً عند عودة الشبكة.";
  return "تعذّر الاتصال بالخادم. حاول مرة أخرى.";
}

export function useActionHelpers() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const refresh = useCallback(() => qc.invalidateQueries(), [qc]);
  const fail = useCallback(
    (err: unknown) => {
      toast({ title: "لم تتم العملية", description: errorMessage(err), variant: "destructive" });
      qc.invalidateQueries();
    },
    [qc, toast],
  );
  const ok = useCallback((title: string, description?: string) => toast({ title, description }), [toast]);
  return { refresh, fail, ok };
}

export function fmtTime(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("ar-SY", { hour: "2-digit", minute: "2-digit" });
}
export function fmtDateTime(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ar-SY", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
export function fmtMeters(m: number) {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} كم`;
  return `${Math.round(m / 10) * 10} م`;
}
