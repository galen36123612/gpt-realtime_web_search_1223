// 1223 add gpt-realtime + gpt-4o-search-preview + prompt
/*export const runtime = "nodejs";

type WebSearchReq = {
  query: string;
  recency_days?: number;
  domains?: string[];
};

type UrlCitation = { title?: string; url?: string };

function normalizeDomains(domains: string[]): string[] {
  const cleaned = domains
    .map((d) => String(d || "").trim())
    .filter(Boolean)
    .map((d) => d.replace(/^https?:\/\//i, "").replace(/\/+$/g, ""));
  return Array.from(new Set(cleaned)).slice(0, 100);
}

function getTaipeiNowISO(): string {
  // 產生類似 2025-12-23T15:35:29 的字串（台北時間）
  const s = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
  return s.replace(" ", "T");
}

function extractOutputTextFromResponses(resp: any): string {
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) return resp.output_text.trim();

  let text = "";
  const output = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of output) {
    if (item?.type !== "message") continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if ((part?.type === "output_text" || part?.type === "text") && typeof part?.text === "string") {
        text += part.text;
      }
    }
  }
  return text.trim();
}

function extractUrlCitationsFromResponses(resp: any): UrlCitation[] {
  const citations: UrlCitation[] = [];
  const output = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of output) {
    if (item?.type !== "message") continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const annotations = Array.isArray(part?.annotations) ? part.annotations : [];
      for (const ann of annotations) {
        if (ann?.type === "url_citation") citations.push({ title: ann.title, url: ann.url });
      }
    }
  }
  return citations;
}

function extractOutputTextFromChat(resp: any): string {
  const content = resp?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

function extractUrlCitationsFromChat(resp: any): UrlCitation[] {
  const anns = resp?.choices?.[0]?.message?.annotations;
  const arr = Array.isArray(anns) ? anns : [];
  const citations: UrlCitation[] = [];
  for (const ann of arr) {
    if (ann?.type === "url_citation") citations.push({ title: ann.title, url: ann.url });
  }
  return citations;
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return Response.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });

    const body = (await req.json()) as WebSearchReq;
    const query = String(body?.query || "").trim();
    const recency_days = Number.isFinite(body?.recency_days) ? Number(body.recency_days) : 30;
    const domains = normalizeDomains(Array.isArray(body?.domains) ? body.domains : []);

    if (!query) return Response.json({ error: "Missing required field: query" }, { status: 400 });

    const model = process.env.WEB_SEARCH_MODEL || "gpt-4o-mini";
    const isSearchPreviewModel = /-search-(preview|api)\b/i.test(model);

    // ✅ A 方法：把「台北時間」當成 prompt 錨點
    const taipeiNow = getTaipeiNowISO();
const taipeiToday = taipeiNow.slice(0, 10); // YYYY-MM-DD

const basePrompt = [
  "你是一個搜尋助理。請在需要時使用網路最新資訊，並用繁體中文回答。",
  "",
  "【時間基準】",
  `- 現在的台北時間（Asia/Taipei）是：${taipeiNow}`,
  "- 使用者提到「今天/昨日/最近/本週」等相對時間，一律以 Asia/Taipei 推算，不要用 UTC。",
  "",
  "【數值/價格類問題的硬規則（務必遵守）】",
  `- 若問題涉及「價格/股價/收盤價/匯率」：答案一定要包含「該數值所對應的日期（Asia/Taipei）」；沒有日期就視為不可用來源。`,
  `- 若使用者問「今天收盤價」：以台北時間「${taipeiToday}」為今天；若今天尚未收盤或休市，請改用「最近一個交易日」並明確寫出日期（不要假裝是今天）。`,
  "- 優先使用一手/權威報價來源（交易所/大型資料商/報價頁），避免採用新聞文章內文引用的價格當作收盤價。",
  "- 若找到的價格彼此矛盾，請列出差異並說明你採信哪個來源與原因；不確定就直接說無法確認。",
  "",
  "輸出格式：",
  "- 【結論】1-2 句直接回答（若不是今天，請在這裡就講清楚是哪一天）",
  "- 【重點】2~6 點條列",
  "- 【來源】列出使用到的來源（title + url）",
  "",
  recency_days > 0 ? `- 盡量優先使用最近 ${recency_days} 天資訊（若能找到）` : "",
  domains.length ? `- 若可行，優先參考這些網域：${domains.join(", ")}` : "",
  "",
  `問題：${query}`,
]
  .filter(Boolean)
  .join("\n");

    if (isSearchPreviewModel) {
      // ✅ Chat Completions：用 search-preview 專用模型
      const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: basePrompt }],
        }),
      });

      const respJson = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        return Response.json(
          { error: "OpenAI chat/completions error", status: upstream.status, statusText: upstream.statusText, details: respJson },
          { status: 500 }
        );
      }

      const answer = extractOutputTextFromChat(respJson);
      const citations = extractUrlCitationsFromChat(respJson);

      return Response.json({
        answer,
        citations: citations.slice(0, 10),
        meta: { query, recency_days, domains, model, mode: "chat_completions", taipeiNow },
      });
    }

    // ✅ Responses：一般模型 + web_search tool（支援 domain filtering）
    const tools: any[] = [
      {
        type: "web_search",
        ...(domains.length ? { filters: { allowed_domains: domains } } : {}),
      },
    ];

    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        tools,
        tool_choice: "auto",
        input: basePrompt,
      }),
    });

    const respJson = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return Response.json(
        { error: "OpenAI responses error", status: upstream.status, statusText: upstream.statusText, details: respJson },
        { status: 500 }
      );
    }

    const answer = extractOutputTextFromResponses(respJson);
    const citations = extractUrlCitationsFromResponses(respJson);

    return Response.json({
      answer,
      citations: citations.slice(0, 10),
      meta: { query, recency_days, domains, model, mode: "responses", taipeiNow },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500 });
  }
}*/

//1223 V2 TWSE + gpt-4o-search-preview

export const runtime = "nodejs";

type WebSearchReq = {
  query: string;
  recency_days?: number;
  domains?: string[];
};

type UrlCitation = { title?: string; url?: string };

function normalizeDomains(domains: string[]): string[] {
  const cleaned = domains
    .map((d) => String(d || "").trim())
    .filter(Boolean)
    .map((d) => d.replace(/^https?:\/\//i, "").replace(/\/+$/g, ""));
  return Array.from(new Set(cleaned)).slice(0, 100);
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function getTaipeiNowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const y = map.year!;
  const m = map.month!;
  const d = map.day!;
  const hh = map.hour!;
  const mm = map.minute!;
  const ss = map.second!;
  const iso = `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
  const ymd = `${y}-${m}-${d}`;
  return {
    iso,
    ymd,
    hour: Number(hh),
    minute: Number(mm),
    second: Number(ss),
  };
}

function addDaysToYMD(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = pad2(dt.getUTCMonth() + 1);
  const dd = pad2(dt.getUTCDate());
  return `${yy}-${mm}-${dd}`;
}

/** 嘗試從 query 解析日期；支援：YYYY-MM-DD / YYYY/MM/DD / YYYY年MM月DD日 / MM/DD(用當年) */
function parseDateFromQuery(query: string, defaultYear: number): { ymd: string; explicit: boolean } | null {
  const q = query;

  // YYYY-MM-DD or YYYY/MM/DD
  let m = q.match(/(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*(?:日)?/);
  if (m) {
    const y = Number(m[1]);
    const mo = pad2(Number(m[2]));
    const d = pad2(Number(m[3]));
    return { ymd: `${y}-${mo}-${d}`, explicit: true };
  }

  // MM/DD (assume current year)
  m = q.match(/(?:^|\D)(\d{1,2})\s*\/\s*(\d{1,2})(?:\D|$)/);
  if (m) {
    const mo = pad2(Number(m[1]));
    const d = pad2(Number(m[2]));
    return { ymd: `${defaultYear}-${mo}-${d}`, explicit: true };
  }

  return null;
}

function isPriceQuery(query: string): boolean {
  const q = query.toLowerCase();
  const kws = [
    "股價",
    "收盤",
    "收盤價",
    "開盤",
    "最高",
    "最低",
    "成交",
    "成交價",
    "報價",
    "price",
    "close",
    "quote",
  ];
  return kws.some((k) => q.includes(k));
}

/** 從 query 盡量推測台股代號（4位數） */
function inferTwseStockNo(query: string): string | null {
  const q = query;

  // 常見公司名映射（可自行擴充）
  const nameMap: Array<[RegExp, string]> = [
    [/台積電|tsmc/i, "2330"],
    [/鴻海/i, "2317"],
    [/聯發科/i, "2454"],
    [/中華電/i, "2412"],
    [/國泰金/i, "2882"],
    [/富邦金/i, "2881"],
  ];
  for (const [re, code] of nameMap) {
    if (re.test(q)) return code;
  }

  // 2330.TW / 2330tw / (2330)
  const twMatch = q.match(/(?:^|[^\d])(\\d{4})\s*(?:\.?tw)?(?:[^\d]|$)/i);
  if (twMatch) {
    const code = twMatch[1];
    // 避免把年份 2025 誤判成代號
    if (!/年/.test(q.slice(Math.max(0, twMatch.index ?? 0) - 2, (twMatch.index ?? 0) + 6))) {
      if (code !== "2024" && code !== "2025" && code !== "2026") return code;
    }
  }

  // 最後：找 4 位數，但排除看起來像「年份」的上下文
  const re = /\d{4}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const code = m[0];
    const idx = m.index;
    const left = q.slice(Math.max(0, idx - 2), idx);
    const right = q.slice(idx, Math.min(q.length, idx + 6));
    // 排除日期語境：2025年、2025-、2025/ 等
    if (/[年\/\-]/.test(right) || /年/.test(left)) continue;
    // 排除明顯年份
    if (code >= "1900" && code <= "2099") continue;
    return code;
  }

  return null;
}

function parseTwseRowDateToISO(s: string): string | null {
  // 常見：113/12/23（民國）或 2025/12/23
  const m = String(s).trim().match(/^(\d{2,4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  let y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900) y += 1911; // 民國轉西元
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

function toNumberMaybe(x: any): number | null {
  const s = String(x ?? "").replace(/,/g, "").trim();
  if (!s || s === "--") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function fetchTwseStockDayMonth(stockNo: string, yyyy: number, mm: number) {
  // TWSE STOCK_DAY: date=YYYYMM01 (查當月)
  const dateParam = `${yyyy}${pad2(mm)}01`;
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateParam}&stockNo=${encodeURIComponent(
    stockNo
  )}`;

  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      // 某些環境對沒有 UA 的請求比較敏感
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json,text/plain,*/*",
    },
  });

  if (!res.ok) {
    throw new Error(`TWSE fetch failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  return { url, json };
}

async function getTwseCloseForDateOrPrev(stockNo: string, targetYmd: string) {
  const [y, m] = targetYmd.split("-").map(Number);

  // 嘗試：本月 → 若找不到 <= target 的資料，再試上月
  const tryMonths: Array<{ yy: number; mm: number }> = [{ yy: y, mm: m }];
  const prev = new Date(Date.UTC(y, m - 2, 1)); // 上月（UTC）
  tryMonths.push({ yy: prev.getUTCFullYear(), mm: prev.getUTCMonth() + 1 });

  let best: {
    ymd: string;
    row: string[];
    sourceUrl: string;
    fields?: string[];
  } | null = null;

  for (const mon of tryMonths) {
    const { url, json } = await fetchTwseStockDayMonth(stockNo, mon.yy, mon.mm);
    const rows: string[][] = Array.isArray(json?.data) ? json.data : [];
    const fields: string[] | undefined = Array.isArray(json?.fields) ? json.fields : undefined;

    // 找 close 欄位 index（通常是 "收盤價"）
    let closeIdx = 6; // fallback
    if (fields?.length) {
      const i = fields.findIndex((f) => String(f).includes("收盤"));
      if (i >= 0) closeIdx = i;
    }

    for (const row of rows) {
      const rowYmd = parseTwseRowDateToISO(row?.[0]);
      if (!rowYmd) continue;
      // 找 <= target 的最近一筆
      if (rowYmd <= targetYmd) {
        if (!best || rowYmd > best.ymd) {
          best = { ymd: rowYmd, row, sourceUrl: url, fields };
          // 把 closeIdx 暫存到 row 的尾端不好看，之後用 fields 再找一次
          (best as any).closeIdx = closeIdx;
        }
      }
    }
  }

  if (!best) return null;

  const closeIdx = (best as any).closeIdx as number;
  const row = best.row;

  // 常見欄位順序：日期、成交股數、成交金額、開盤、最高、最低、收盤、漲跌、成交筆數
  const open = toNumberMaybe(row?.[3]);
  const high = toNumberMaybe(row?.[4]);
  const low = toNumberMaybe(row?.[5]);
  const close = toNumberMaybe(row?.[closeIdx]);
  const volume = toNumberMaybe(row?.[1]); // 成交股數（常為整數很大）

  return {
    ymd: best.ymd,
    open,
    high,
    low,
    close,
    volume,
    sourceUrl: best.sourceUrl,
  };
}

function extractOutputTextFromResponses(resp: any): string {
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) return resp.output_text.trim();

  let text = "";
  const output = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of output) {
    if (item?.type !== "message") continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if ((part?.type === "output_text" || part?.type === "text") && typeof part?.text === "string") {
        text += part.text;
      }
    }
  }
  return text.trim();
}

function extractUrlCitationsFromResponses(resp: any): UrlCitation[] {
  const citations: UrlCitation[] = [];
  const output = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of output) {
    if (item?.type !== "message") continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const annotations = Array.isArray(part?.annotations) ? part.annotations : [];
      for (const ann of annotations) {
        if (ann?.type === "url_citation") citations.push({ title: ann.title, url: ann.url });
      }
    }
  }
  return citations;
}

function extractOutputTextFromChat(resp: any): string {
  const content = resp?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

function extractUrlCitationsFromChat(resp: any): UrlCitation[] {
  const anns = resp?.choices?.[0]?.message?.annotations;
  const arr = Array.isArray(anns) ? anns : [];
  const citations: UrlCitation[] = [];
  for (const ann of arr) {
    if (ann?.type === "url_citation") citations.push({ title: ann.title, url: ann.url });
  }
  return citations;
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return Response.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });

    const body = (await req.json()) as WebSearchReq;
    const query = String(body?.query || "").trim();
    const recency_days = Number.isFinite(body?.recency_days) ? Number(body.recency_days) : 30;
    const domains = normalizeDomains(Array.isArray(body?.domains) ? body.domains : []);

    if (!query) return Response.json({ error: "Missing required field: query" }, { status: 400 });

    const taipei = getTaipeiNowParts();
    const taipeiNow = taipei.iso;

    // =========================================================
    // ✅ 1) 股價類（台股）優先走 TWSE：拿「確定數字」
    // =========================================================
    const maybeStockNo = inferTwseStockNo(query);
    const looksLikePrice = isPriceQuery(query);

    if (maybeStockNo && looksLikePrice) {
      // 目標日期：有寫日期就用；沒寫日期 + 問收盤價 → 若還沒過收盤後一段時間，就先用昨天
      const parsed = parseDateFromQuery(query, Number(taipei.ymd.slice(0, 4)));
      let targetYmd = parsed?.ymd ?? taipei.ymd;

      const isCloseIntent = /收盤|收盤價|close/i.test(query);
      const afterCloseLikely = taipei.hour > 14 || (taipei.hour === 14 && taipei.minute >= 0);
      if (!parsed?.explicit && isCloseIntent && !afterCloseLikely) {
        // 台股通常下午收盤；若時間太早，先查前一交易日（避免查不到）
        targetYmd = addDaysToYMD(taipei.ymd, -1);
      }

      try {
        const twse = await getTwseCloseForDateOrPrev(maybeStockNo, targetYmd);

        if (twse?.close != null) {
          const sameDay = twse.ymd === targetYmd;

          const answer =
            `台北時間基準：${taipeiNow}\n` +
            `台積電/台股等台灣上市股票以 TWSE（台灣證交所）日資料為準。\n\n` +
            `查詢代號：${maybeStockNo}.TW\n` +
            (sameDay
              ? `✅ ${twse.ymd} 收盤價：${twse.close} TWD`
              : `⚠️ 找不到 ${targetYmd} 當日資料（可能休市/尚未更新/非交易日），最近一個可取得的交易日是 ${twse.ymd}，收盤價：${twse.close} TWD`) +
            (twse.open != null || twse.high != null || twse.low != null
              ? `\n（開/高/低：${twse.open ?? "—"} / ${twse.high ?? "—"} / ${twse.low ?? "—"}）`
              : "") +
            (twse.volume != null ? `\n成交股數：${twse.volume}` : "");

          const citations: UrlCitation[] = [
            {
              title: `TWSE STOCK_DAY ${maybeStockNo}（含收盤價）`,
              url: twse.sourceUrl,
            },
          ];

          return Response.json({
            answer,
            citations,
            meta: {
              query,
              recency_days,
              domains,
              mode: "twse_first",
              market: "TWSE",
              stockNo: maybeStockNo,
              targetYmd,
              resolvedYmd: twse.ymd,
              taipeiNow,
            },
          });
        }
        // close 拿不到就 fallback 搜尋
      } catch {
        // TWSE 失敗就 fallback 搜尋
      }
    }

    // =========================================================
    // ✅ 2) 其他 query 才走 gpt-4o-search-preview / Responses
    // =========================================================
    const model = process.env.WEB_SEARCH_MODEL || "gpt-4o-mini";
    const isSearchPreviewModel = /-search-(preview|api)\b/i.test(model);

    const basePrompt = [
  "你是一個網路研究助理。請先使用網路搜尋，再用繁體中文回答。",
  "",
  "【時間基準】",
  `- 現在的台北時間（Asia/Taipei）是：${taipeiNow}`,
  "- 使用者提到「今天/昨日/最近/本週」等相對時間，一律以 Asia/Taipei 推算，不要用 UTC。",
  "",
  "【可靠性規則（務必遵守）】",
  "- 先把問題改寫成 2~4 個更可搜的查詢（必要時包含中/英文關鍵字），再整合答案。",
  "- 對於會變動或容易出錯的資訊（價格、日期、規則、名單、政策、數字統計）：至少用 2 個獨立來源交叉確認。",
  "- 優先採用權威/一手來源（官方網站、政府機關、公司公告、學術機構、大型媒體/資料商）。避免只依賴論壇或單一部落格。",
  "- 如果找不到足夠可靠來源，請直接說「無法可靠確認」並說明缺口；不要猜。",
  "",
  "【輸出格式】",
  "- 【結論】1~2 句直接回答",
  "- 【重點】最多 6 點條列（每點盡量可由來源支撐）",
  "- 【來源】列出 3~6 筆（title + url）",
  "- 【不確定/差異】只有在資訊不足或來源矛盾時才寫",
  "",
  recency_days > 0 ? `- 優先參考最近 ${recency_days} 天內的資訊（若可取得）` : "",
  domains.length ? `- 若可行，優先參考這些網域：${domains.join(", ")}` : "",
  "",
  `問題：${query}`,
    ]
      .filter(Boolean)
      .join("\n");

    if (isSearchPreviewModel) {
      const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: basePrompt }],
        }),
      });

      const respJson = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        return Response.json(
          { error: "OpenAI chat/completions error", status: upstream.status, statusText: upstream.statusText, details: respJson },
          { status: 500 }
        );
      }

      const answer = extractOutputTextFromChat(respJson);
      const citations = extractUrlCitationsFromChat(respJson);

      return Response.json({
        answer,
        citations: citations.slice(0, 10),
        meta: { query, recency_days, domains, model, mode: "chat_completions", taipeiNow },
      });
    }

    // Responses + web_search tool（保留 domain filtering）
    const tools: any[] = [
      {
        type: "web_search",
        ...(domains.length ? { filters: { allowed_domains: domains } } : {}),
      },
    ];

    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        tools,
        tool_choice: "auto",
        input: basePrompt,
      }),
    });

    const respJson = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return Response.json(
        { error: "OpenAI responses error", status: upstream.status, statusText: upstream.statusText, details: respJson },
        { status: 500 }
      );
    }

    const answer = extractOutputTextFromResponses(respJson);
    const citations = extractUrlCitationsFromResponses(respJson);

    return Response.json({
      answer,
      citations: citations.slice(0, 10),
      meta: { query, recency_days, domains, model, mode: "responses", taipeiNow },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500 });
  }
}




