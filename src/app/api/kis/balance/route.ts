import { NextResponse } from "next/server";
import { KisVtsClient, toBalanceSnapshot, toOverseasBalanceSnapshot } from "@/lib/kis-vts-client";
import { getPublicKisConfig } from "@/lib/safety";
import { setBalanceSnapshot, setOverseasBalanceSnapshot, state, saveState } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    success: true,
    data: {
      balance: state.balanceSnapshot,
      overseasBalance: state.overseasBalanceSnapshot,
      positions: state.positions,
      overseasPositions: state.overseasPositions,
    },
  });
}

export async function POST() {
  if (!getPublicKisConfig().configured) {
    return NextResponse.json({ success: false, error: "KIS_NOT_CONFIGURED" }, { status: 400 });
  }

  try {
    const client = new KisVtsClient();
    const balance = await client.getBalance();
    state.positions = balance.positions;
    saveState();
    setBalanceSnapshot(toBalanceSnapshot(balance));

    let overseasSynced = false;
    try {
      const overseasBalance = await client.getOverseasBalance();
      state.overseasPositions = overseasBalance.positions;
      saveState();
      setOverseasBalanceSnapshot(toOverseasBalanceSnapshot(overseasBalance));
      overseasSynced = true;
    } catch {
      // Domestic sync succeeded; overseas may be unavailable on some accounts.
    }

    return NextResponse.json({
      success: true,
      server: "vts",
      data: {
        balance: state.balanceSnapshot,
        overseasBalance: state.overseasBalanceSnapshot,
        positions: state.positions,
        overseasPositions: state.overseasPositions,
      },
      message: overseasSynced
        ? "VTS 국내·해외 잔고 동기화 완료."
        : "VTS 국내 잔고 동기화 완료. 해외 잔고는 실패했습니다.",
    });
  } catch {
    return NextResponse.json(
      { success: false, error: "VTS_BALANCE_FAILED", lastError: state.lastError },
      { status: 502 },
    );
  }
}
