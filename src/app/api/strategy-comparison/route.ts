import { NextResponse } from "next/server";
import { z } from "zod";
import { state } from "@/lib/store";
import { marketComparisonView, startMarketComparison, stopMarketComparison } from "@/lib/market-comparison";

export const dynamic="force-dynamic";
export const runtime="nodejs";
export async function GET(){
  try {return NextResponse.json({success:true,data:marketComparisonView()});}
  catch {return NextResponse.json({success:false,error:"비교 원장을 읽을 수 없습니다. 기존 기록을 확인하세요."},{status:500});}
}
export async function POST(request:Request){
  const origin=request.headers.get("origin"),host=request.headers.get("host")??new URL(request.url).host;
  try {if((origin&&new URL(origin).host!==host)||request.headers.get("sec-fetch-site")==="cross-site") return NextResponse.json({success:false,error:"다른 사이트에서 보낸 요청은 허용하지 않습니다."},{status:403});}
  catch {return NextResponse.json({success:false,error:"요청 출처 확인 실패"},{status:403});}
  try {
    const {action}=z.object({action:z.enum(["start","stop"])}).strict().parse(await request.json());
    if(action==="stop") stopMarketComparison();
    else startMarketComparison([...state.watchlist,...state.usWatchlist]);
    return GET();
  } catch {return NextResponse.json({success:false,error:"비교 기록 요청 실패. 설정과 저장 상태를 확인하세요."},{status:400});}
}
