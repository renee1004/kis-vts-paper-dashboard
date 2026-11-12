type FxRow = {
  kind: "OPEN" | "CLOSED";
  stockCode: string;
  stockName: string;
  quantity: number;
  stockPnlUsd: number;
  stockPnlKrw: number | null;
  fxPnlKrw: number | null;
  totalKrw: number | null;
  buyFxLabel: string;
  exitFxLabel: string;
  fxNote: string | null;
};

type FxView = {
  labels: { stock: string; fx: string; total: string; limitsNote: string };
  open: FxRow[];
  closed: FxRow[];
  totals: { stockPnlUsd: number; stockPnlKrw: number | null; fxPnlKrw: number | null; totalKrw: number | null; complete: boolean };
  currentFx: { label: string; capturedAt: string | null; source: string };
  limitsUseSafetyRate: number;
};

const money = (n: number | null, suffix = "원") =>
  n == null ? "—" : `${Math.round(n).toLocaleString("ko-KR")}${suffix}`;
const usd = (n: number | null) =>
  n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tone = (n: number | null) =>
  n == null ? "text-slate-500" : n < 0 ? "text-blue-700" : n > 0 ? "text-rose-700" : "text-slate-700";

function Lines({ row, labels }: { row: { stockPnlUsd: number; stockPnlKrw: number | null; fxPnlKrw: number | null; totalKrw: number | null; fxNote: string | null }; labels: FxView["labels"] }) {
  return (
    <div className="grid gap-1 text-xs sm:grid-cols-3">
      <p className={tone(row.stockPnlKrw ?? row.stockPnlUsd)}>
        {row.stockPnlKrw == null && row.fxNote ? `${row.fxNote} · ` : ""}
        {labels.stock} {usd(row.stockPnlUsd)}
        {row.stockPnlKrw != null ? ` / ${money(row.stockPnlKrw)}` : ""}
      </p>
      <p className={tone(row.fxPnlKrw)}>{row.fxPnlKrw == null ? (row.fxNote ?? "—") : `${labels.fx} ${money(row.fxPnlKrw)}`}</p>
      <p className={tone(row.totalKrw)}>{row.totalKrw == null ? (row.fxNote ?? "—") : `${labels.total} ${money(row.totalKrw)}`}</p>
    </div>
  );
}

export function UsFxPnlBlock({ data, title }: { data?: FxView | null; title: string }) {
  if (!data) return null;
  const rows = [...data.open, ...data.closed];
  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-slate-500">
          현재 USD/KRW {data.currentFx.label}
          {data.currentFx.capturedAt
            ? ` · ${new Date(data.currentFx.capturedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`
            : ""}
          {data.currentFx.source !== "NONE" ? ` · ${data.currentFx.source}` : ""}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500">미국 체결 기록이 없습니다.</p>
      ) : (
        <div className="space-y-2">
          {data.open.map((row) => (
            <div key={`open:${row.stockCode}`} className="space-y-1 border-b border-slate-100 pb-2 last:border-0">
              <p className="text-sm">{row.stockName} 보유 {row.quantity}주 · 매수환율 {row.buyFxLabel} · 평가환율 {row.exitFxLabel}</p>
              <Lines row={row} labels={data.labels} />
            </div>
          ))}
          {data.closed.map((row, i) => (
            <div key={`closed:${row.stockCode}:${i}`} className="space-y-1 border-b border-slate-100 pb-2 last:border-0">
              <p className="text-sm">{row.stockName} 청산 {row.quantity}주 · 매수 {row.buyFxLabel} → 매도 {row.exitFxLabel}</p>
              <Lines row={row} labels={data.labels} />
            </div>
          ))}
          <div className="pt-1">
            <p className="mb-1 text-xs font-semibold text-slate-600">합계</p>
            <Lines
              row={{
                stockPnlUsd: data.totals.stockPnlUsd,
                stockPnlKrw: data.totals.stockPnlKrw,
                fxPnlKrw: data.totals.fxPnlKrw,
                totalKrw: data.totals.totalKrw,
                fxNote: data.totals.complete ? null : "환율 미기록·미확인 건 제외",
              }}
              labels={data.labels}
            />
          </div>
        </div>
      )}
      <p className="text-xs text-slate-500">{data.labels.limitsNote}</p>
    </div>
  );
}
