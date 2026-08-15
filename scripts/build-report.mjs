#!/usr/bin/env node
/*
 * Daily snapshot builder.  It intentionally uses structured endpoints only:
 * exchange APIs for Taiwan, and a configurable chart endpoint for US markets.
 * A failed source becomes a visible verification failure; stale figures are
 * never silently copied into a new report.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'public/data/latest.json');
const TAIPEI = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
const TWSE = 'https://openapi.twse.com.tw/v1';
const TWSE_RWD = 'https://www.twse.com.tw/rwd/zh';
const TPEX = 'https://www.tpex.org.tw/openapi/v1';
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';
const REVENUE_URLS = [
  `${TWSE}/opendata/t187ap05_L`,
  `${TPEX}/mopsfin_t187ap05_O`,
];
const TAIFEX_FUTURES_URL = 'https://openapi.taifex.com.tw/v1/DailyMarketReportFut';

const PORTFOLIO = [
  ['0050', '元大台灣50', 'twse'], ['2408', '南亞科', 'twse'], ['3481', '群創', 'twse'],
  ['6770', '力積電', 'twse'], ['8996', '高力', 'twse'], ['4979', '華星光', 'tpex'],
];
const GROUPS = [
  ['A-1', '光通訊/CPO 上游光晶片', [['3081', '聯亞', 'tpex'], ['3234', '光環', 'tpex'], ['4991', '環宇-KY', 'tpex']]],
  ['A-2', '光通訊/CPO 中游被動元件、光引擎', [['3363', '上詮', 'tpex'], ['3163', '波若威', 'tpex'], ['6442', '光聖', 'twse'], ['4979', '華星光', 'tpex']]],
  ['B', 'AI 散熱', [['3324', '雙鴻', 'tpex'], ['3653', '健策', 'twse'], ['2486', '一詮', 'twse'], ['3017', '奇鋐', 'twse'], ['8996', '高力', 'twse']]],
  ['C', 'AI 電力/電源架構', [['2308', '台達電', 'twse']]], ['D', 'AI 網通/交換器', [['2345', '智邦', 'twse']]],
  ['E', '記憶體', [['2337', '旺宏', 'twse'], ['2344', '華邦電', 'twse'], ['8299', '群聯', 'tpex']]],
  ['F', '伺服器晶片', [['5274', '信驊', 'tpex']]], ['G', '光學鏡頭/精密光學', [['3008', '大立光', 'twse']]],
  ['H', 'IC 設計/邊緣AI', [['3034', '聯詠', 'twse']]], ['I', '矽智財 IP / RISC-V', [['6533', '晶心科', 'twse']]],
  ['J', '封測/先進封裝', [['3711', '日月光投控', 'twse']]], ['K', 'AI 伺服器組裝/ODM', [['2382', '廣達', 'twse']]],
];
const US = [
  ['^DJI', '道瓊'], ['^GSPC', 'S&P 500'], ['^IXIC', '那斯達克'], ['^SOX', '費半 SOX'],
  ['TSM', '台積電 ADR'], ['NVDA', '輝達'], ['MU', '美光'], ['AMD', '超微'], ['INTC', '英特爾'], ['AVGO', '博通'], ['UMC', '聯電 ADR'],
  ['DX-Y.NYB', '美元指數'], ['^TNX', '10年期美債殖利率'], ['CL=F', 'WTI 原油'],
];

const source = (url, label) => ({ url, label });
const todayTaipei = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const number = value => Number(String(value ?? '').replaceAll(',', '').replaceAll(' ', ''));
const clean = value => String(value ?? '').trim();

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'TaiwanPremarketBrief/1.0' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function settled(task) { try { return await task(); } catch (error) { return { error: clean(error.message) }; } }

function lookup(row, names) {
  for (const name of names) if (row[name] !== undefined) return row[name];
  return undefined;
}
function normalizeTwse(row) {
  const close = number(lookup(row, ['收盤價', 'ClosingPrice']));
  const change = number(lookup(row, ['漲跌價差', 'Change']));
  return { code: clean(lookup(row, ['證券代號', 'Code'])), name: clean(lookup(row, ['證券名稱', 'Name'])), close, change, pct: close ? +(change / (close - change) * 100).toFixed(2) : null, volume: number(lookup(row, ['成交股數', 'TradeVolume'])), source: source(`${TWSE}/exchangeReport/STOCK_DAY_ALL`, 'TWSE OpenAPI') };
}
function normalizeTpex(row) {
  const close = number(lookup(row, ['收盤', 'Close']));
  const change = number(lookup(row, ['漲跌', 'Change']));
  return { code: clean(lookup(row, ['代號', 'SecuritiesCompanyCode', 'Code'])), name: clean(lookup(row, ['名稱', 'CompanyName', 'Name'])), close, change, pct: close ? +(change / (close - change) * 100).toFixed(2) : null, volume: number(lookup(row, ['成交股數', 'TradingShares', 'Volume'])), source: source(`${TPEX}/tpex_mainboard_daily_close_quotes`, 'TPEx OpenAPI') };
}
async function fetchTaiwanQuotes() {
  const [twseResult, tpexResult] = await Promise.all([
    settled(() => getJson(`${TWSE}/exchangeReport/STOCK_DAY_ALL`)),
    settled(() => getJson(`${TPEX}/tpex_mainboard_daily_close_quotes`)),
  ]);
  const twse = Array.isArray(twseResult) ? twseResult.map(normalizeTwse) : [];
  const tpex = Array.isArray(tpexResult) ? tpexResult.map(normalizeTpex) : [];
  return { twse, tpex, errors: [twseResult.error, tpexResult.error].filter(Boolean) };
}
async function fetchUsQuote(symbol, name) {
  const url = `${YAHOO}/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const payload = await getJson(url);
  const result = payload.chart?.result?.[0];
  const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter(Number.isFinite);
  const close = closes.at(-1), previous = closes.at(-2);
  if (!Number.isFinite(close) || !Number.isFinite(previous)) throw new Error('insufficient chart data');
  return { symbol, name, close: +close.toFixed(2), change: +(close - previous).toFixed(2), pct: +((close - previous) / previous * 100).toFixed(2), source: source(url, 'Yahoo chart endpoint（非官方）') };
}
async function fetchMarket() {
  const results = await Promise.all(US.map(([symbol, name]) => settled(() => fetchUsQuote(symbol, name))));
  return { quotes: results.filter(x => !x.error), errors: results.filter(x => x.error).map(x => x.error) };
}
function normalizeIndex(row, url) {
  const sign = clean(row['漲跌']) === '-' ? -1 : 1;
  return {
    name: clean(row['指數']), close: number(row['收盤指數']),
    change: sign * Math.abs(number(row['漲跌點數'])), pct: sign * Math.abs(number(row['漲跌百分比'])),
    source: source(url, 'TWSE 大盤分類指數'),
  };
}
function buildMarketSummary(indexRows, institutional) {
  const indexUrl = `${TWSE}/exchangeReport/MI_INDEX`;
  const indices = (Array.isArray(indexRows) ? indexRows : []).map(row => normalizeIndex(row, indexUrl));
  const find = name => indices.find(item => item.name === name);
  const sectors = indices.filter(item => /類指數$/.test(item.name) && !item.name.includes('報酬') && Number.isFinite(item.pct));
  const institutionSource = source(`${TWSE_RWD}/fund/BFI82U?response=json`, 'TWSE 三大法人');
  const institutions = (institutional?.data ?? []).map(row => ({
    name: clean(row[0]), buy: number(row[1]), sell: number(row[2]), net: number(row[3]), source: institutionSource,
  }));
  return {
    taiex: find('發行量加權股價指數'),
    indices: ['臺灣50指數', '臺灣中型100指數', '未含電子指數'].map(find).filter(Boolean),
    sectors: sectors.sort((a, b) => b.pct - a.pct),
    institutions,
    source: source(indexUrl, 'TWSE 大盤分類指數'),
  };
}
function normalizeTaiFutures(rows) {
  const sourceInfo = source(TAIFEX_FUTURES_URL, 'TAIFEX 台指期行情');
  const currentMonth = (Array.isArray(rows) ? rows : []).filter(row => row.Contract === 'TX' && /^\d{6}$/.test(clean(row['ContractMonth(Week)'])) && Number.isFinite(number(row.Last)));
  const pick = session => currentMonth.find(row => clean(row.TradingSession) === session);
  const normalize = row => row ? { name: `台指期${clean(row.TradingSession)}`, close: number(row.Last), change: number(row.Change), pct: number(clean(row['%']).replace('%', '')), volume: number(row.Volume), source: sourceInfo } : null;
  return { day: normalize(pick('一般')), night: normalize(pick('盤後')) };
}
function selectQuote([code, name, venue], lookupMap) {
  const found = lookupMap.get(code);
  return found ?? { code, name, venue, unavailable: true, source: source(venue === 'twse' ? `${TWSE}/exchangeReport/STOCK_DAY_ALL` : `${TPEX}/tpex_mainboard_daily_close_quotes`, venue === 'twse' ? 'TWSE OpenAPI' : 'TPEx OpenAPI') };
}
function normalizeRevenue(listedRows, otcRows) {
  const withSource = (rows, url) => (Array.isArray(rows) ? rows : []).map(row => [clean(row['公司代號']), {
    month: clean(row['資料年月']), revenue: number(row['營業收入-當月營收']),
    mom: number(row['營業收入-上月比較增減(%)']), yoy: number(row['營業收入-去年同月增減(%)']),
    source: source(url, '交易所月營收'),
  }]);
  return new Map([...withSource(listedRows, REVENUE_URLS[0]), ...withSource(otcRows, REVENUE_URLS[1])]);
}
function addRevenue(quote, revenueMap) { return { ...quote, revenue: revenueMap.get(quote.code) ?? null }; }
function reportDate() {
  const parts = TAIPEI.formatToParts(new Date()).reduce((acc, x) => ({ ...acc, [x.type]: x.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday };
}
async function main() {
  const generatedAt = new Date().toISOString();
  const [tw, us, notices, punish, holidays, indexRows, institutional, listedRevenueRows, otcRevenueRows, futuresRows] = await Promise.all([
    fetchTaiwanQuotes(), fetchMarket(),
    settled(() => getJson(`${TWSE}/announcement/notice`)),
    settled(() => getJson(`${TWSE}/announcement/punish`)),
    settled(() => getJson(`${TWSE}/holidaySchedule/holidaySchedule?response=json`)),
    settled(() => getJson(`${TWSE}/exchangeReport/MI_INDEX`)),
    settled(() => getJson(`${TWSE_RWD}/fund/BFI82U?response=json`)),
    settled(() => getJson(REVENUE_URLS[0])),
    settled(() => getJson(REVENUE_URLS[1])),
    settled(() => getJson(TAIFEX_FUTURES_URL)),
  ]);
  const allQuotes = new Map([...tw.twse, ...tw.tpex].map(item => [item.code, item]));
  const holidayRows = Array.isArray(holidays) ? holidays : holidays.data ?? [];
  const date = todayTaipei();
  // 12:00 Asia/Taipei is 04:00 UTC, so UTC weekday is unambiguous and does
  // not inherit the runner's local timezone.
  const weekday = new Date(`${date}T12:00:00+08:00`).getUTCDay();
  const isHoliday = weekday === 0 || weekday === 6 || holidayRows.some(row => clean(lookup(row, ['日期', 'date'])).includes(date) && /無交易|休市/.test(JSON.stringify(row)));
  const sourceErrors = [...new Set([...tw.errors, ...us.errors, notices.error, punish.error, holidays.error, indexRows.error, institutional.error, listedRevenueRows.error, otcRevenueRows.error, futuresRows.error].filter(Boolean))];
  const heldCodes = new Set(PORTFOLIO.map(x => x[0]));
  const revenueMap = normalizeRevenue(listedRevenueRows, otcRevenueRows);
  const observation = GROUPS.map(([id, title, stocks]) => ({ id, title, stocks: stocks.map(stock => ({ ...addRevenue(selectQuote(stock, allQuotes), revenueMap), held: heldCodes.has(stock[0]) })) }));
  const latest = {
    schemaVersion: 1,
    generatedAt,
    reportDate: { ...reportDate(), isHoliday, source: source(`${TWSE}/holidaySchedule/holidaySchedule?response=json`, 'TWSE 交易日曆') },
    verification: { sourceErrors, note: '未取得或無授權資料一律標示為無法查證；不以推估、舊資料或媒體文字取代。' },
    usMarket: us.quotes,
    market: { ...buildMarketSummary(indexRows, institutional), futures: normalizeTaiFutures(futuresRows) },
    taiwan: { portfolio: PORTFOLIO.map(stock => addRevenue(selectQuote(stock, allQuotes), revenueMap)), observation },
    events: { notices: Array.isArray(notices) ? notices : notices.data ?? [], punishments: Array.isArray(punish) ? punish : punish.data ?? [], sources: { notices: source(`${TWSE}/announcement/notice`, 'TWSE 注意股票'), punishments: source(`${TWSE}/announcement/punish`, 'TWSE 處置股票') } },
    unavailable: ['法說市場共識、DRAM 現貨/合約價與亞股早盤：尚未設定具授權且可驗證的 API，故不在本版本呈現數字。', '產業漲跌原因須使用可授權的新聞／公告來源；目前只呈現交易所分類指數的客觀強弱。'],
  };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`Wrote ${OUTPUT} (${date}; ${sourceErrors.length} source warning(s))`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
