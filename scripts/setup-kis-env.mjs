#!/usr/bin/env node
// KIS 모의투자 자격증명을 .env.local에 한 번만 저장합니다.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

const ENV_PATH = path.join(process.cwd(), ".env.local");
const EXAMPLE_PATH = path.join(process.cwd(), ".env.local.example");
const VTS_BASE_URL = "https://openapivts.koreainvestment.com:29443";

function upsert(content, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.trimEnd()}\n${line}\n`;
}

const fromEnv = {
  appKey: process.env.KIS_APP_KEY?.trim(),
  appSecret: process.env.KIS_APP_SECRET?.trim(),
  accountNo: process.env.KIS_ACCOUNT_NO?.trim(),
  productCode: process.env.KIS_ACCOUNT_PRODUCT_CODE?.trim(),
};

let rl = null;
async function value(envValue, question, fallback = "") {
  if (envValue) return envValue;
  rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim();
  return answer || fallback;
}

if (!fromEnv.appKey || !fromEnv.appSecret) {
  console.log("KIS Developers > 나의 신청내역의 모의투자계좌 행 값을 입력하세요.");
  console.log("입력값은 화면에 보이므로 주변을 확인하세요.\n");
}

const appKey = await value(fromEnv.appKey, "KIS_APP_KEY: ");
const appSecret = await value(fromEnv.appSecret, "KIS_APP_SECRET: ");
const accountNo = await value(fromEnv.accountNo, "계좌번호 8자리: ");
const productCode = await value(fromEnv.productCode, "상품코드 2자리 [01]: ", "01");
rl?.close();

const problems = [];
if (!appKey) problems.push("App Key가 비어 있습니다.");
if (!appSecret) problems.push("App Secret이 비어 있습니다.");
if (!/^\d{8}$/.test(accountNo)) problems.push("계좌번호는 숫자 8자리여야 합니다.");
if (!/^\d{2}$/.test(productCode)) problems.push("상품코드는 숫자 2자리여야 합니다.");

if (problems.length) {
  console.error(`\n${problems.join("\n")}`);
  process.exit(1);
}

let content = "";
if (fs.existsSync(ENV_PATH)) content = fs.readFileSync(ENV_PATH, "utf8");
else if (fs.existsSync(EXAMPLE_PATH)) content = fs.readFileSync(EXAMPLE_PATH, "utf8");

content = upsert(content, "KIS_BASE_URL", VTS_BASE_URL);
content = upsert(content, "KIS_APP_KEY", appKey);
content = upsert(content, "KIS_APP_SECRET", appSecret);
content = upsert(content, "KIS_ACCOUNT_NO", accountNo);
content = upsert(content, "KIS_ACCOUNT_PRODUCT_CODE", productCode);

fs.writeFileSync(ENV_PATH, content, { encoding: "utf8", mode: 0o600 });
fs.chmodSync(ENV_PATH, 0o600);

console.log(`\n.env.local에 저장했습니다. 계좌 끝 4자리 ****${accountNo.slice(-4)}`);
console.log("이제 npm run dashboard 로 실행하면 설정 입력 없이 4번 버튼만 누르면 됩니다.");
