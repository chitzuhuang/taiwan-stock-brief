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
  // Final field is the broker net cost basis from the supplied holdings screen (fees/taxes included).
  ['0050', '元大台灣50', 'twse', 1100, 104.84, 115610], ['2408', '南亞科', 'twse', 50, 405.84, 20404], ['3481', '群創', 'twse', 1000, 66.06, 66277],
  ['6770', '力積電', 'twse', 800, 73.11, 58766], ['8996', '高力', 'twse', 50, 1115.92, 56079], ['4979', '華星光', 'tpex', 100, 478.90, 48120],
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
  ['^DJI', '道瓊'], ['^GSPC', 'S&P 500'], ['^IXIC', '那斯達克'], ['^SOX', '費半 SOX'], ['^TWOII', '櫃買指數'],
  ['TSM', '台積電 ADR'], ['NVDA', '輝達'], ['MU', '美光'], ['AMD', '超微'], ['INTC', '英特爾'], ['AVGO', '博通'], ['UMC', '聯電 ADR'],
  ['TSLA', '特斯拉'], ['SKHY', 'SK 海力士 ADR'], ['SNDK', 'SanDisk'], ['MRVL', 'Marvell'], ['GOOG', 'Alphabet'], ['GLW', '康寧'], ['IBM', 'IBM'], ['VRT', 'Vertiv'], ['MOD', 'Modine'], ['LITE', 'Lumentum'],
  ['DX-Y.NYB', '美元指數'], ['^TNX', '10年期美債殖利率'], ['CL=F', 'WTI 原油'],
];
const US_GROUPS = [['指數與總經', ['^DJI','^GSPC','^IXIC','^SOX','DX-Y.NYB','^TNX','CL=F']], ['AI 算力／半導體', ['TSM','NVDA','AMD','INTC','AVGO','MRVL','IBM']], ['記憶體', ['MU','SKHY','SNDK']], ['AI 電力／散熱', ['VRT','MOD']], ['光通訊／網路', ['LITE','GLW']], ['雲端與電動車', ['GOOG','TSLA','UMC']]];
const WEIGHTED = [['2330', '台積電', 'twse'], ['2317', '鴻海', 'twse'], ['2454', '聯發科', 'twse'], ['2308', '台達電', 'twse']];

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
  return { code: clean(lookup(row, ['證券代號', 'Code'])), name: clean(lookup(row, ['證券名稱', 'Name'])), close, change, pct: close ? +(change / (close - change) * 100).toFixed(2) : null, volume: number(lookup(row, ['成交股數', 'TradeVolume'])), value: number(lookup(row, ['成交金額', 'TradeValue'])), source: source(`${TWSE}/exchangeReport/STOCK_DAY_ALL`, 'TWSE OpenAPI') };
}
function normalizeTpex(row) {
  const close = number(lookup(row, ['收盤', 'Close']));
  const change = number(lookup(row, ['漲跌', 'Change']));
  return { code: clean(lookup(row, ['代號', 'SecuritiesCompanyCode', 'Code'])), name: clean(lookup(row, ['名稱', 'CompanyName', 'Name'])), close, change, pct: close ? +(change / (close - change) * 100).toFixed(2) : null, volume: number(lookup(row, ['成交股數', 'TradingShares', 'Volume'])), value: number(lookup(row, ['成交金額', 'TradingValue', 'Value'])), source: source(`${TPEX}/tpex_mainboard_daily_close_quotes`, 'TPEx OpenAPI') };
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
async function fetchUsQuote(symbol, name, range = '1mo') {
  const url = `${YAHOO}/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const payload = await getJson(url);
  const result = payload.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0] ?? {};
  const closes = (quote.close ?? []).filter(Number.isFinite);
  const volumes = (quote.volume ?? []).filter(Number.isFinite);
  const close = closes.at(-1), previous = closes.at(-2);
  if (!Number.isFinite(close) || !Number.isFinite(previous)) throw new Error('insufficient chart data');
  const pctFrom = offset => Number.isFinite(closes.at(-offset)) ? +((close / closes.at(-offset) - 1) * 100).toFixed(2) : null;
  const priorVolume = volumes.at(-2), volume = volumes.at(-1);
  return { symbol, name, currency: result?.meta?.currency ?? '', close: +close.toFixed(2), change: +(close - previous).toFixed(2), pct: +((close - previous) / previous * 100).toFixed(2), volume, volumePct: Number.isFinite(volume) && Number.isFinite(priorVolume) && priorVolume ? +((volume / priorVolume - 1) * 100).toFixed(2) : null, weekPct: pctFrom(6), monthPct: pctFrom(closes.length), source: source(url, 'Yahoo chart endpoint（非官方）') };
}
async function fetchMarket() {
  const results = await Promise.all(US.map(([symbol, name]) => settled(() => fetchUsQuote(symbol, name))));
  return { quotes: results.filter(x => !x.error), errors: results.filter(x => x.error).map(x => x.error) };
}
async function fetchNews(query) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=3`;
  const payload = await getJson(url);
  return (payload.news ?? []).slice(0, 3).map(item => ({ title:clean(item.title), publisher:clean(item.publisher), url:item.link, source:source(item.link || url, `Yahoo Finance news API：${clean(item.publisher) || query}`) }));
}
async function summarizeNews(news, market) {
  if (!process.env.OPENAI_API_KEY) return { events: [], five: [], macro: [], error: 'OPENAI_API_KEY 未設定' };
  const headlines = news.map(x => `- ${x.title}（${x.publisher}）`).join('\n');
  const prompt = `你是台股盤前研究助手。只根據以下新聞標題和市場數字，以繁體中文輸出嚴格 JSON，不得捏造新聞內文、數字、公司或日期。events 產生最多5則，每則 {title,summary}；summary 35~55字，說明為何值得注意。five 產生5條、每條35~55字，作為今日最該注意事項。macro 產生至少3條、每條35~55字，聚焦通膨、利率、美元、油價或景氣。若標題不足以支持結論，要明說「需閱讀原文確認」。\n\n市場數字：${JSON.stringify(market)}\n\n新聞標題：\n${headlines}`;
  const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5-mini', reasoning: { effort: 'minimal' }, input: prompt, text: { format: { type: 'json_object' } } }), signal: AbortSignal.timeout(110_000) });
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
  const payload = await response.json();
  const outputText = payload.output_text || (payload.output ?? []).flatMap(item => item.content ?? []).map(part => part.text ?? '').join('');
  if (!outputText) throw new Error('OpenAI returned empty summary text');
  return JSON.parse(outputText.replace(/^```json\s*|\s*```$/g, ''));
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
function portfolioItem(stock, quotes, revenues) { const [code, name, venue, shares, cost, netCost] = stock; const q = addRevenue(selectQuote([code, name, venue], quotes), revenues); const marketValue = Number.isFinite(q.close) ? q.close * shares : null; const profit = marketValue == null ? null : marketValue - netCost; return { ...q, shares, cost, netCost, marketValue, profit, profitPct: profit == null ? null : +(profit / (shares * cost) * 100).toFixed(2) }; }
function yahooSymbol(item) { return `${item.code}.${item.venue === 'tpex' ? 'TWO' : 'TW'}`; }
async function enrichHistory(items) {
  const results = await Promise.all(items.map(item => settled(() => fetchUsQuote(yahooSymbol(item), item.name))));
  const byCode = new Map(results.filter(x => !x.error).map(x => [x.symbol.split('.')[0], x]));
  return items.map(item => { const h = byCode.get(item.code); return h ? { ...item, volumePct: h.volumePct, weekPct: h.weekPct, monthPct: h.monthPct } : item; });
}
function parseInstitutionRanks(payload, sourceInfo) {
  const fields = payload?.fields ?? [], rows = payload?.data ?? [];
  const field = text => fields.indexOf(text);
  const codeAt = field('證券代號'), nameAt = field('證券名稱'), netAt = field('外陸資買賣超股數(不含外資自營商)');
  if (codeAt < 0 || netAt < 0) return { buys: [], sells: [] };
  const etfName = /ETF|台灣50|正2|反1|高股息|主動|優息|永續|科技龍頭|非投等債|槓桿|期貨/;
  const ranked = rows.map(row => ({ code: clean(row[codeAt]), name: clean(row[nameAt]), net: number(row[netAt]), source: sourceInfo })).filter(x => /^\d{4}$/.test(x.code) && !etfName.test(x.name) && Number.isFinite(x.net));
  return { buys: ranked.filter(x => x.net > 0).sort((a,b) => b.net - a.net).slice(0,10), sells: ranked.filter(x => x.net < 0).sort((a,b) => a.net - b.net).slice(0,10) };
}
// The exchange endpoints include ETFs, warrants, bonds and other securities.
// This report's attention/disposition lists are intentionally limited to common
// shares (four-digit stock codes) so the list stays useful for stock research.
function rocDateToIso(value) {
  const text = clean(value).replaceAll('/', '').replaceAll('-', '');
  if (!/^\d{7}$/.test(text)) return '';
  return `${Number(text.slice(0, 3)) + 1911}${text.slice(3)}`;
}
function formatDispositionPeriod(value) {
  return clean(value).replace(/(\d{3})(\d{2})(\d{2})/g, '$1/$2/$3').replace('~', '～');
}
function commonStockEvents(rows, sourceInfo, { activeOnly = false } = {}) {
  const excluded = /ETF|權證|認購|認售|牛證|熊證|可轉換公司債|可交換公司債|公司債|債券|特別股|存託憑證|TDR|受益憑證|基金|期貨/;
  return (Array.isArray(rows) ? rows : rows?.data ?? []).map(row => {
    const code = clean(lookup(row, ['證券代號', '股票代號', 'Code', 'SecuritiesCompanyCode']));
    const name = clean(lookup(row, ['證券名稱', '股票名稱', 'Name', 'CompanyName']));
    return {
      code, name,
      detail: clean(lookup(row, ['注意交易資訊', 'TradingInfoForAttention', '處置條件', 'ReasonsOfDisposition', '處置內容', 'Detail', 'DispositionReasons', 'DisposalCondition'])) || '詳見交易所公告',
      period: formatDispositionPeriod(lookup(row, ['處置期間', 'DispositionPeriod'])),
      source: sourceInfo,
    };
  }).filter(row => {
    if (!/^\d{4}$/.test(row.code) || excluded.test(row.name)) return false;
    const end = rocDateToIso(row.period.split('～').at(-1));
    return !activeOnly || !end || end >= todayTaipei().replaceAll('-', '');
  });
}
function financialMap(listed, otc) {
  const normalize = (rows, codeKey, sourceInfo) => new Map((Array.isArray(rows) ? rows : []).map(r => [clean(r[codeKey]), { eps:number(r['基本每股盈餘(元)'] ?? r['基本每股盈餘']), revenue:number(r['營業收入']), operating:number(r['營業利益']), netIncome:number(r['稅後淨利']), quarter:clean(r['季別']), source:sourceInfo }]));
  return new Map([...normalize(listed, '公司代號', source(`${TWSE}/opendata/t187ap14_L`, 'TWSE Q2 財報')), ...normalize(otc, 'SecuritiesCompanyCode', source(`${TPEX}/mopsfin_t187ap14_O`, 'TPEx Q2 財報'))]);
}
function sectorPulse(sectors, priorWeek = [], priorMonth = []) {
  const w = new Map(priorWeek.map(x => [x.name, x.close])), m = new Map(priorMonth.map(x => [x.name, x.close]));
  return sectors.map(x => ({ ...x, weekPct: w.has(x.name) ? +((x.close / w.get(x.name) - 1) * 100).toFixed(2) : null, monthPct: m.has(x.name) ? +((x.close / m.get(x.name) - 1) * 100).toFixed(2) : null }));
}
function parseRwdIndices(payload, url) {
  const table = (payload?.tables ?? []).find(t => t.fields?.includes('指數'));
  if (!table) return [];
  return (table.data ?? []).map(row => normalizeIndex(Object.fromEntries(table.fields.map((field, i) => [field, row[i]])), url));
}
async function historicalIndices(daysAgo) {
  let lastError = '';
  for (let offset = 0; offset < 5; offset += 1) {
    const day = new Date(Date.now() - (daysAgo + offset) * 86_400_000).toLocaleDateString('en-CA', { timeZone:'Asia/Taipei' }).replaceAll('-', '');
    const url = `${TWSE_RWD}/afterTrading/MI_INDEX?date=${day}&type=ALLBUT0999&response=json`;
    const result = await settled(() => getJson(url));
    const rows = result.error ? [] : parseRwdIndices(result, url);
    if (rows.length) return { rows, error:'' };
    lastError = result.error || 'empty index response';
  }
  return { rows: [], error:lastError };
}
function reportDate() {
  const parts = TAIPEI.formatToParts(new Date()).reduce((acc, x) => ({ ...acc, [x.type]: x.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday };
}
async function main() {
  const generatedAt = new Date().toISOString();
  const [tw, us, notices, punish, tpexDisposals, holidays, indexRows, institutional, listedRevenueRows, otcRevenueRows, futuresRows, institutionStocks, listedFinancials, otcFinancials, priorWeek, priorMonth, globalNews, taiwanNews] = await Promise.all([
    fetchTaiwanQuotes(), fetchMarket(),
    settled(() => getJson(`${TWSE}/announcement/notice`)),
    settled(() => getJson(`${TWSE}/announcement/punish`)),
    settled(() => getJson(`${TPEX}/tpex_disposal_information`)),
    settled(() => getJson(`${TWSE}/holidaySchedule/holidaySchedule?response=json`)),
    settled(() => getJson(`${TWSE}/exchangeReport/MI_INDEX`)),
    settled(() => getJson(`${TWSE_RWD}/fund/BFI82U?response=json`)),
    settled(() => getJson(REVENUE_URLS[0])),
    settled(() => getJson(REVENUE_URLS[1])),
    settled(() => getJson(TAIFEX_FUTURES_URL)),
    settled(() => getJson(`${TWSE_RWD}/fund/T86?selectType=ALLBUT0999&response=json`)),
    settled(() => getJson(`${TWSE}/opendata/t187ap14_L`)),
    settled(() => getJson(`${TPEX}/mopsfin_t187ap14_O`)),
    historicalIndices(7), historicalIndices(31),
    settled(() => fetchNews('Federal Reserve inflation oil markets')),
    settled(() => fetchNews('Taiwan stock market semiconductor')),
  ]);
  const allQuotes = new Map([...tw.twse, ...tw.tpex].map(item => [item.code, item]));
  const holidayRows = Array.isArray(holidays) ? holidays : holidays.data ?? [];
  const date = todayTaipei();
  // 12:00 Asia/Taipei is 04:00 UTC, so UTC weekday is unambiguous and does
  // not inherit the runner's local timezone.
  const weekday = new Date(`${date}T12:00:00+08:00`).getUTCDay();
  const isHoliday = weekday === 0 || weekday === 6 || holidayRows.some(row => clean(lookup(row, ['日期', 'date'])).includes(date) && /無交易|休市/.test(JSON.stringify(row)));
  const sourceErrors = [...new Set([...tw.errors, ...us.errors, notices.error, punish.error, tpexDisposals.error, holidays.error, indexRows.error, institutional.error, listedRevenueRows.error, otcRevenueRows.error, futuresRows.error, institutionStocks.error, listedFinancials.error, otcFinancials.error, priorWeek.error, priorMonth.error, globalNews.error, taiwanNews.error].filter(Boolean))];
  const heldCodes = new Set(PORTFOLIO.map(x => x[0]));
  const revenueMap = normalizeRevenue(listedRevenueRows, otcRevenueRows);
  const rawPortfolio = PORTFOLIO.map(stock => portfolioItem(stock, allQuotes, revenueMap));
  const rawObservation = GROUPS.map(([id, title, stocks]) => ({ id, title, stocks: stocks.map(stock => ({ ...addRevenue(selectQuote(stock, allQuotes), revenueMap), held: heldCodes.has(stock[0]) })) }));
  const enriched = await enrichHistory([...rawPortfolio, ...rawObservation.flatMap(g => g.stocks), ...WEIGHTED.map(x => selectQuote(x, allQuotes))]);
  const history = new Map(enriched.map(x => [x.code, x]));
  const portfolio = rawPortfolio.map(x => ({ ...x, ...history.get(x.code) }));
  const observation = rawObservation.map(g => ({ ...g, stocks:g.stocks.map(x => ({ ...x, ...history.get(x.code) })) }));
  const financials = financialMap(listedFinancials, otcFinancials);
  const tracked = [...portfolio, ...observation.flatMap(g => g.stocks)].map(x => ({ ...x, financial: financials.get(x.code) ?? null }));
  const weighted = WEIGHTED.map(x => history.get(x[0]) ?? selectQuote(x, allQuotes));
  const allMarketQuotes = [...tw.twse, ...tw.tpex].filter(x => Number.isFinite(x.pct));
  const breadth = { up: allMarketQuotes.filter(x=>x.pct>0).length, down:allMarketQuotes.filter(x=>x.pct<0).length, flat:allMarketQuotes.filter(x=>x.pct===0).length, turnover:allMarketQuotes.reduce((sum,x)=>sum+(x.value||0),0), topTurnover:allMarketQuotes.sort((a,b)=>(b.value||0)-(a.value||0)).slice(0,20).reduce((sum,x)=>sum+(x.value||0),0) };
  const rankSource = source(`${TWSE_RWD}/fund/T86?selectType=ALLBUT0999&response=json`, 'TWSE 個股法人買賣超');
  const newsItems = [...(globalNews.error ? [] : globalNews), ...(taiwanNews.error ? [] : taiwanNews)];
  const summaryResult = await settled(() => summarizeNews(newsItems, { dow:us.quotes.find(x=>x.symbol==='^DJI'), nasdaq:us.quotes.find(x=>x.symbol==='^IXIC'), dollar:us.quotes.find(x=>x.symbol==='DX-Y.NYB'), yield:us.quotes.find(x=>x.symbol==='^TNX'), oil:us.quotes.find(x=>x.symbol==='CL=F') }));
  const latest = {
    schemaVersion: 1,
    generatedAt,
    reportDate: { ...reportDate(), isHoliday, source: source(`${TWSE}/holidaySchedule/holidaySchedule?response=json`, 'TWSE 交易日曆') },
    verification: { sourceErrors, note: '未取得或無授權資料一律標示為無法查證；不以推估、舊資料或媒體文字取代。' },
    usMarket: us.quotes,
    news: { global:globalNews.error ? [] : globalNews, taiwan:taiwanNews.error ? [] : taiwanNews },
    newsAnalysis: summaryResult.error ? { events: [], five: [], macro: [], error:summaryResult.error } : summaryResult,
    usGroups: US_GROUPS.map(([title, symbols]) => ({ title, stocks:symbols.map(s=>us.quotes.find(x=>x.symbol===s)).filter(Boolean) })),
    market: { ...buildMarketSummary(indexRows, institutional), otcIndex:us.quotes.find(x=>x.symbol==='^TWOII'), futures: normalizeTaiFutures(futuresRows), weighted, breadth, institutionRanks:parseInstitutionRanks(institutionStocks, rankSource), sectorPulse:sectorPulse(buildMarketSummary(indexRows, institutional).sectors, priorWeek.rows.filter(x=>/類指數$/.test(x.name)), priorMonth.rows.filter(x=>/類指數$/.test(x.name))) },
    taiwan: { portfolio: portfolio.map(x => ({ ...x, financial:financials.get(x.code) ?? null })), observation: observation.map(g => ({ ...g, stocks:g.stocks.map(x => ({ ...x, financial:financials.get(x.code) ?? null })) })), financials:tracked },
    events: {
      notices: commonStockEvents(notices, source(`${TWSE}/announcement/notice`, 'TWSE 注意股票')),
      punishments: [
        ...commonStockEvents(punish, source(`${TWSE}/announcement/punish`, 'TWSE 處置股票'), { activeOnly: true }),
        ...commonStockEvents(tpexDisposals, source('https://www.tpex.org.tw/zh-tw/announce/market/disposal.html', 'TPEx 上櫃處置股票'), { activeOnly: true }),
      ],
      sources: { notices: source(`${TWSE}/announcement/notice`, 'TWSE 注意股票'), punishments: source(`${TWSE}/announcement/punish`, 'TWSE 處置股票'), tpexDisposals: source('https://www.tpex.org.tw/zh-tw/announce/market/disposal.html', 'TPEx 上櫃處置股票') },
    },
    unavailable: ['法說市場共識、DRAM 現貨/合約價與亞股早盤：尚未設定具授權且可驗證的 API，故不在本版本呈現數字。', '產業漲跌原因須使用可授權的新聞／公告來源；目前只呈現交易所分類指數的客觀強弱。'],
  };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`Wrote ${OUTPUT} (${date}; ${sourceErrors.length} source warning(s))`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
