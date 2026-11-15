import { useState } from "react";
import { ChevronLeft, ChevronRight, History as HistoryIcon } from "lucide-react";
import { getListPassengerHistoryQueryKey, useListPassengerHistory } from "@workspace/api-client-react";
import { Guard } from "@/components/shell";
import { EmptyState, ErrorState, RequestRow, SectionTitle, SkeletonBlock, DemoTag } from "@/components/kit";

const PAGE_SIZE = 10;

function HistoryBody() {
  const [page, setPage] = useState(1);
  const params = { page, pageSize: PAGE_SIZE };
  const q = useListPassengerHistory(params, { query: { queryKey: getListPassengerHistoryQueryKey(params), placeholderData: (prev) => prev } });
  const d = q.data;
  const totalPages = Math.max(1, d?.totalPages ?? 1);

  return (
    <div className="space-y-3">
      <SectionTitle aside={<DemoTag />}>رحلاتي السابقة</SectionTitle>
      {q.isLoading && [0, 1, 2, 3].map((i) => <SkeletonBlock key={i} className="h-24" />)}
      {q.isError && <ErrorState onRetry={() => q.refetch()} />}
      {d && d.total === 0 && (
        <EmptyState icon={<HistoryIcon className="h-5 w-5" />} title="لا رحلات بعد" hint="أول طلب ترسله سيظهر هنا مع كل تفاصيله." />
      )}
      <div className={q.isFetching && !q.isLoading ? "space-y-3 opacity-60 transition-opacity" : "space-y-3"} aria-busy={q.isFetching}>
        {d?.items.map((r, i) => <RequestRow key={r.id} r={r} index={i} href={`/requests/${r.id}`} />)}
      </div>
      {d && d.total > 0 && (
        <nav aria-label="التنقل بين صفحات السجل" className="flex items-center justify-between gap-2 rounded-2xl border border-basalt/10 bg-chalk p-2" data-testid="nav-history-pagination">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || q.isFetching}
            aria-label="الصفحة السابقة"
            className="inline-flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-bold transition hover:bg-limestone disabled:opacity-40"
            data-testid="button-history-prev"
          >
            <ChevronRight className="h-4 w-4" /> السابقة
          </button>
          <p className="text-sm" aria-live="polite" data-testid="text-history-page">
            صفحة <b className="num">{d.page}</b> من <b className="num">{totalPages}</b>
            <span className="text-muted-foreground"> · <span className="num">{d.total}</span> طلبًا</span>
          </p>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || q.isFetching}
            aria-label="الصفحة التالية"
            className="inline-flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-bold transition hover:bg-limestone disabled:opacity-40"
            data-testid="button-history-next"
          >
            التالية <ChevronLeft className="h-4 w-4" />
          </button>
        </nav>
      )}
    </div>
  );
}

export default function HistoryPage() {
  return <Guard role="passenger">{() => <HistoryBody />}</Guard>;
}
