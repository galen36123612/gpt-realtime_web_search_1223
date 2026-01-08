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

//1223 V2 TWSE + gpt-4o-search-preview -> preview final

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


function inferTwseStockNo(query: string): string | null {
  const q = query;

  
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
      Accept: "application/json,text/plain,*",
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
}*/

// 1229 realtime access stock price

// src/app/api/web_search/route.ts
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
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;

  const y = map.year!;
  const m = map.month!;
  const d = map.day!;
  const hh = map.hour!;
  const mm = map.minute!;
  const ss = map.second!;
  return {
    iso: `${y}-${m}-${d}T${hh}:${mm}:${ss}`,
    ymd: `${y}-${m}-${d}`,
    year: Number(y),
    hour: Number(hh),
    minute: Number(mm),
  };
}

function addDaysToYMD(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}


function parseDateFromQuery(query: string, defaultYear: number): { ymd: string; explicit: boolean } | null {
  const q = query;

  let m = q.match(/(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*(?:日)?/);
  if (m) {
    return { ymd: `${Number(m[1])}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`, explicit: true };
  }

  m = q.match(/(?:^|\D)(\d{1,2})\s*\/\s*(\d{1,2})(?:\D|$)/);
  if (m) {
    return { ymd: `${defaultYear}-${pad2(Number(m[1]))}-${pad2(Number(m[2]))}`, explicit: true };
  }

  return null;
}


function looksLikePriceQuery(query: string): boolean {
  const q = query.toLowerCase();
  const kws = [
    "股價",
    "價格",
    "報價",
    "現價",
    "即時",
    "最新",
    "多少錢",
    "多少",
    "盤中",
    "成交價",
    "成交",
    "price",
    "quote",
  ];
  return kws.some((k) => q.includes(k));
}


function isCloseIntent(query: string): boolean {
  const q = query.toLowerCase();
  return ["收盤", "收盤價", "close", "昨日收盤", "前一日收盤"].some((k) => q.includes(k));
}


function isRealtimeIntent(query: string): boolean {
  const q = query.toLowerCase();
  const yes = ["即時", "現在", "現價", "最新", "盤中", "多少錢", "報價", "realtime", "real-time", "live"].some((k) =>
    q.includes(k)
  );
  // 有寫收盤就不要當即時
  return yes && !isCloseIntent(query);
}

function toNumberMaybe(x: any): number | null {
  const s = String(x ?? "").replace(/,/g, "").trim();
  if (!s || s === "--" || s === "-" || s.toLowerCase() === "na") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}


function inferTaiwanCodeFromQuery(query: string): string | null {
  const q = query.trim();

  // 2330.TW / 2330.TWO / 00687B.TW
  let m = q.match(/(^|[^\w])(\d{4,6}[A-Za-z]?)(?:\.(?:TW|TWO))([^\w]|$)/);
  if (m) return m[2].toUpperCase();

  // 單純出現 4~6 + 可選字母（避免年份誤判）
  m = q.match(/(^|[^\d])(\d{4,6}[A-Za-z]?)(?!\d)/);
  if (m) {
    const code = m[2].toUpperCase();
    // 排除年份 2024~2026 這種
    if (/^20(2[4-6])$/.test(code)) return null;
    return code;
  }

  return null;
}


function inferFromNameMap(query: string): { code: string; name: string } | null {
  const nameMap: Array<[RegExp, { code: string; name: string }]> = [
    [/台積電|tsmc/i, { code: "2330", name: "台積電" }],
    [/鴻海/i, { code: "2317", name: "鴻海" }],
    [/台塑/i, { code: "1301", name: "台塑" }],
    [/聯發科/i, { code: "2454", name: "聯發科" }],
    [/中華電/i, { code: "2412", name: "中華電" }],
    [/國泰金/i, { code: "2882", name: "國泰金" }],
    [/富邦金/i, { code: "2881", name: "富邦金" }],
  ];
  for (const [re, v] of nameMap) if (re.test(query)) return v;
  return null;
}


async function yahooSearchTaiwanSymbol(userQuery: string): Promise<{ symbol: string; shortname?: string } | null> {
  const url =
    "https://query2.finance.yahoo.com/v1/finance/search?q=" +
    encodeURIComponent(userQuery) +
    "&quotesCount=10&newsCount=0&enableFuzzyQuery=true";

  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json,text/plain,*",
    },
  });

  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  const quotes: any[] = Array.isArray(json?.quotes) ? json.quotes : [];

  // 優先台灣標的（.TW / .TWO），再看 quoteType
  const picked =
    quotes.find((q) => typeof q?.symbol === "string" && (q.symbol.endsWith(".TW") || q.symbol.endsWith(".TWO"))) ||
    null;

  if (!picked?.symbol) return null;
  return { symbol: String(picked.symbol), shortname: picked.shortname || picked.longname };
}


async function fetchTwseMisRealtime(code: string) {
  // 同時試 tse_ 與 otc_（MIS 會回傳哪個有資料）
  const exCh = `tse_${code}.tw|otc_${code}.tw`;
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${encodeURIComponent(exCh)}`;

  // MIS 有時會需要帶 Referer / UA
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://mis.twse.com.tw/stock/fibest.jsp",
      Accept: "application/json,text/plain,*",
    },
  });

  if (!res.ok) throw new Error(`MIS failed: ${res.status} ${res.statusText}`);
  const json: any = await res.json().catch(() => null);

  const arr: any[] = Array.isArray(json?.msgArray) ? json.msgArray : [];
  if (!arr.length) return null;

  // 選一個有價格的（z 是最新成交，y 是昨收）
  const pick =
    arr.find((it) => toNumberMaybe(it?.z) != null) ||
    arr.find((it) => toNumberMaybe(it?.y) != null) ||
    arr[0];

  const last = toNumberMaybe(pick?.z);
  const prevClose = toNumberMaybe(pick?.y);
  const open = toNumberMaybe(pick?.o);
  const high = toNumberMaybe(pick?.h);
  const low = toNumberMaybe(pick?.l);

  const name = (pick?.n || pick?.nf || pick?.name || "").toString().trim() || undefined;
  const time = (pick?.t || "").toString().trim(); // "13:30:00"
  const date = (pick?.d || "").toString().trim(); // "20251229"

  return {
    last,
    prevClose,
    open,
    high,
    low,
    name,
    rawTime: time,
    rawDate: date,
    sourceUrl: url,
  };
}


async function fetchYahooQuote(symbol: string) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json,text/plain,*",
    },
  });
  if (!res.ok) throw new Error(`Yahoo quote failed: ${res.status} ${res.statusText}`);

  const json: any = await res.json().catch(() => null);
  const r = json?.quoteResponse?.result?.[0];
  if (!r) return null;

  const price = typeof r?.regularMarketPrice === "number" ? r.regularMarketPrice : null;
  const prevClose = typeof r?.regularMarketPreviousClose === "number" ? r.regularMarketPreviousClose : null;
  const open = typeof r?.regularMarketOpen === "number" ? r.regularMarketOpen : null;
  const high = typeof r?.regularMarketDayHigh === "number" ? r.regularMarketDayHigh : null;
  const low = typeof r?.regularMarketDayLow === "number" ? r.regularMarketDayLow : null;
  const name = (r?.shortName || r?.longName || "").toString().trim() || undefined;

  // epoch seconds
  const t = typeof r?.regularMarketTime === "number" ? r.regularMarketTime : null;

  return { price, prevClose, open, high, low, name, marketTimeEpochSec: t, sourceUrl: url };
}


async function fetchTwseStockDayMonth(stockNo: string, yyyy: number, mm: number) {
  const dateParam = `${yyyy}${pad2(mm)}01`;
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateParam}&stockNo=${encodeURIComponent(
    stockNo
  )}`;

  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json,text/plain,*",
    },
  });

  if (!res.ok) throw new Error(`TWSE STOCK_DAY failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  return { url, json };
}

function parseTwseRowDateToISO(s: string): string | null {
  const m = String(s).trim().match(/^(\d{2,4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  let y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900) y += 1911; // 民國轉西元
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

async function getTwseCloseForDateOrPrev(stockNo: string, targetYmd: string) {
  const [y, m] = targetYmd.split("-").map(Number);

  const tryMonths: Array<{ yy: number; mm: number }> = [{ yy: y, mm: m }];
  const prev = new Date(Date.UTC(y, m - 2, 1));
  tryMonths.push({ yy: prev.getUTCFullYear(), mm: prev.getUTCMonth() + 1 });

  let best: { ymd: string; row: string[]; sourceUrl: string; fields?: string[]; closeIdx: number } | null = null;

  for (const mon of tryMonths) {
    const { url, json } = await fetchTwseStockDayMonth(stockNo, mon.yy, mon.mm);
    const rows: string[][] = Array.isArray(json?.data) ? json.data : [];
    const fields: string[] | undefined = Array.isArray(json?.fields) ? json.fields : undefined;

    let closeIdx = 6;
    if (fields?.length) {
      const i = fields.findIndex((f) => String(f).includes("收盤"));
      if (i >= 0) closeIdx = i;
    }

    for (const row of rows) {
      const rowYmd = parseTwseRowDateToISO(row?.[0]);
      if (!rowYmd) continue;

      if (rowYmd <= targetYmd) {
        if (!best || rowYmd > best.ymd) {
          best = { ymd: rowYmd, row, sourceUrl: url, fields, closeIdx };
        }
      }
    }
  }

  if (!best) return null;

  const row = best.row;
  const open = toNumberMaybe(row?.[3]);
  const high = toNumberMaybe(row?.[4]);
  const low = toNumberMaybe(row?.[5]);
  const close = toNumberMaybe(row?.[best.closeIdx]);
  const volume = toNumberMaybe(row?.[1]);

  return { ymd: best.ymd, open, high, low, close, volume, sourceUrl: best.sourceUrl };
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


function extractMarkdownLinks(text: string): UrlCitation[] {
  const out: UrlCitation[] = [];
  const re = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ title: m[1], url: m[2] });
  }
  // 去重
  const seen = new Set<string>();
  return out.filter((c) => {
    const key = `${c.title || ""}__${c.url || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatTaipeiTimeFromEpoch(epochSec: number | null): string | null {
  if (!epochSec) return null;
  const dt = new Date(epochSec * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(dt);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`;
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
    // ✅ 1) 台股/ETF：即時 & 收盤（不走 web_search）
    // =========================================================
    const maybeCode = inferTaiwanCodeFromQuery(query) || inferFromNameMap(query)?.code || null;
    const dateInQuery = parseDateFromQuery(query, taipei.year);
    const priceLike = looksLikePriceQuery(query) || isRealtimeIntent(query) || isCloseIntent(query);

    // 若使用者只打「台塑多少錢」這種：maybeCode 可能抓不到 → 用 Yahoo Search 補 symbol
    let symbolFromSearch: { symbol: string; shortname?: string } | null = null;
    let finalCode = maybeCode;
    let finalSymbol: string | null = null;

    if (priceLike) {
      if (finalCode) {
        // 不知道是上市或上櫃，先假設 .TW，MIS 會同時試 tse/otc；Yahoo quote 我們用 .TW 先試
        finalSymbol = `${finalCode}.TW`;
      } else {
        symbolFromSearch = await yahooSearchTaiwanSymbol(query);
        if (symbolFromSearch?.symbol) {
          finalSymbol = symbolFromSearch.symbol;
          finalCode = symbolFromSearch.symbol.split(".")[0].toUpperCase();
        }
      }
    }

    const hasTaiwanInstrument = !!(priceLike && finalCode && finalSymbol);

    if (hasTaiwanInstrument) {
      // 1a) 若有明確日期或明確收盤：走 STOCK_DAY（官方日資料）
      if (dateInQuery?.explicit || isCloseIntent(query)) {
        let targetYmd = dateInQuery?.ymd ?? taipei.ymd;

        // 如果是問「今天收盤」但現在還沒收盤後資料時間（台股約 13:30 收盤，留 5 分鐘緩衝）
        const afterCloseLikely = taipei.hour > 13 || (taipei.hour === 13 && taipei.minute >= 35);
        if (!dateInQuery?.explicit && isCloseIntent(query) && !afterCloseLikely) {
          targetYmd = addDaysToYMD(taipei.ymd, -1);
        }

        try {
          const twse = await getTwseCloseForDateOrPrev(finalCode!, targetYmd);

          if (twse?.close != null) {
            const sameDay = twse.ymd === targetYmd;
            const answer =
              `台北時間基準：${taipeiNow}\n` +
              `代號：${finalCode}（${finalSymbol}）\n` +
              (sameDay
                ? `✅ ${twse.ymd} 收盤價：${twse.close} TWD`
                : `⚠️ 找不到 ${targetYmd} 當日資料（可能休市/尚未更新/非交易日），最近可取得交易日：${twse.ymd}\n收盤價：${twse.close} TWD`) +
              (twse.open != null || twse.high != null || twse.low != null
                ? `\n（開/高/低：${twse.open ?? "—"} / ${twse.high ?? "—"} / ${twse.low ?? "—"}）`
                : "") +
              (twse.volume != null ? `\n成交股數：${twse.volume}` : "");

            const citations: UrlCitation[] = [
              { title: `TWSE STOCK_DAY ${finalCode}（日資料/收盤）`, url: twse.sourceUrl },
            ];

            return Response.json({
              answer,
              citations,
              meta: {
                query,
                mode: "tw_close_stock_day",
                taipeiNow,
                stockNo: finalCode,
                symbol: finalSymbol,
                targetYmd,
                resolvedYmd: twse.ymd,
              },
            });
          }
        } catch {
          // STOCK_DAY 失敗 → fallback：用 Yahoo previousClose 當「最近可得」（會明講）
          try {
            const yq = await fetchYahooQuote(finalSymbol!);
            if (yq?.prevClose != null) {
              const t = formatTaipeiTimeFromEpoch(yq.marketTimeEpochSec);
              const answer =
                `台北時間基準：${taipeiNow}\n` +
                `代號：${finalCode}（${finalSymbol}）\n` +
                `⚠️ 目前無法取得 TWSE 日資料（收盤/歷史），改用 Yahoo Quote 的「前一交易日收盤」作為最近可得資訊。\n` +
                `前一交易日收盤（previousClose）：${yq.prevClose}（可能有延遲）` +
                (t ? `\n資料時間（台北）：${t}` : "");

              const citations: UrlCitation[] = [{ title: `Yahoo Quote ${finalSymbol}`, url: yq.sourceUrl }];
              return Response.json({
                answer,
                citations,
                meta: { query, mode: "close_fallback_yahoo_prevclose", taipeiNow, stockNo: finalCode, symbol: finalSymbol },
              });
            }
          } catch {
            // ignore
          }
        }

        // 若全部都失敗，最後才回 web_search
      } else {
        // 1b) 即時：先 MIS，再 Yahoo quote
        // 若使用者沒講即時/收盤，但看起來是問價格（例如「台塑多少錢」），我們當即時處理
        let mis: Awaited<ReturnType<typeof fetchTwseMisRealtime>> | null = null;
        try {
          mis = await fetchTwseMisRealtime(finalCode!);
        } catch {
          mis = null;
        }

        if (mis && (mis.last != null || mis.prevClose != null)) {
          const lastStr = mis.last != null ? `${mis.last}` : "—";
          const prevStr = mis.prevClose != null ? `${mis.prevClose}` : "—";
          const nameStr = mis.name ? `（${mis.name}）` : "";
          const answer =
            `台北時間基準：${taipeiNow}\n` +
            `代號：${finalCode}（${finalSymbol}）${nameStr}\n` +
            `✅ 即時/最新成交：${lastStr} TWD\n` +
            `昨收：${prevStr} TWD` +
            (mis.open != null || mis.high != null || mis.low != null
              ? `\n（開/高/低：${mis.open ?? "—"} / ${mis.high ?? "—"} / ${mis.low ?? "—"}）`
              : "") +
            (mis.rawDate && mis.rawTime
              ? `\n資料時間（交易所回傳）：${mis.rawDate} ${mis.rawTime}（可能為交易所格式）`
              : "");

          const citations: UrlCitation[] = [{ title: `TWSE MIS 即時報價 ${finalCode}`, url: mis.sourceUrl }];

          return Response.json({
            answer,
            citations,
            meta: { query, mode: "realtime_mis", taipeiNow, stockNo: finalCode, symbol: finalSymbol },
          });
        }

        // MIS 沒拿到 → Yahoo quote fallback
        try {
          const yq = await fetchYahooQuote(finalSymbol!);
          if (yq && (yq.price != null || yq.prevClose != null)) {
            const t = formatTaipeiTimeFromEpoch(yq.marketTimeEpochSec);
            const answer =
              `台北時間基準：${taipeiNow}\n` +
              `代號：${finalCode}（${finalSymbol}）${yq.name ? `（${yq.name}）` : ""}\n` +
              `✅ 最新價格（Yahoo）：${yq.price ?? "—"}\n` +
              `昨收：${yq.prevClose ?? "—"}` +
              (yq.open != null || yq.high != null || yq.low != null
                ? `\n（開/高/低：${yq.open ?? "—"} / ${yq.high ?? "—"} / ${yq.low ?? "—"}）`
                : "") +
              (t ? `\n資料時間（台北）：${t}` : "") +
              `\n（註：Yahoo 報價可能有延遲；若需完全即時請以券商/交易所為準）`;

            const citations: UrlCitation[] = [{ title: `Yahoo Quote ${finalSymbol}`, url: yq.sourceUrl }];
            return Response.json({
              answer,
              citations,
              meta: { query, mode: "realtime_yahoo_fallback", taipeiNow, stockNo: finalCode, symbol: finalSymbol },
            });
          }
        } catch {
          // ignore
        }

        // 即時也失敗 → 最後用 STOCK_DAY 給最近收盤（避免回「查不到」）
        try {
          const twse = await getTwseCloseForDateOrPrev(finalCode!, taipei.ymd);
          if (twse?.close != null) {
            const answer =
              `台北時間基準：${taipeiNow}\n` +
              `代號：${finalCode}（${finalSymbol}）\n` +
              `⚠️ 目前無法取得即時報價，改提供最近可取得交易日收盤：\n` +
              `✅ ${twse.ymd} 收盤價：${twse.close} TWD`;

            const citations: UrlCitation[] = [{ title: `TWSE STOCK_DAY ${finalCode}（日資料/收盤）`, url: twse.sourceUrl }];
            return Response.json({
              answer,
              citations,
              meta: { query, mode: "realtime_failed_close_fallback", taipeiNow, stockNo: finalCode, symbol: finalSymbol },
            });
          }
        } catch {
          // ignore
        }
      }
    }

    // =========================================================
    // ✅ 2) 非股價類問題：才走 web_search / 搜尋模型
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
      "- 對於會變動或容易出錯的資訊（價格、日期、規則、名單、政策、數字統計）：至少用 2 個獨立來源交叉確認；若只有單一來源，請標註「可能有延遲/僅單一來源」。",
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
      let citations = extractUrlCitationsFromChat(respJson);
      if (!citations.length) citations = extractMarkdownLinks(answer).slice(0, 10);

      return Response.json({
        answer,
        citations: citations.slice(0, 10),
        meta: { query, recency_days, domains, model, mode: "chat_completions", taipeiNow },
      });
    }

    // Responses + web_search tool（支援 domain filtering）
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
    let citations = extractUrlCitationsFromResponses(respJson);
    if (!citations.length) citations = extractMarkdownLinks(answer).slice(0, 10);

    return Response.json({
      answer,
      citations: citations.slice(0, 10),
      meta: { query, recency_days, domains, model, mode: "responses", taipeiNow },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500 });
  }
}*/

// 0105 websearch + 基本面 + 技術面


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
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;

  const y = map.year!;
  const m = map.month!;
  const d = map.day!;
  const hh = map.hour!;
  const mm = map.minute!;
  const ss = map.second!;
  return {
    iso: `${y}-${m}-${d}T${hh}:${mm}:${ss}`,
    ymd: `${y}-${m}-${d}`,
    year: Number(y),
    hour: Number(hh),
    minute: Number(mm),
  };
}

// 台北當日 00:00（+08:00）的 epoch ms（wantgoo tradeDate 需要這個）
function getTaipeiMidnightEpochMs(ymd: string): number {
  // ymd: YYYY-MM-DD
  return Date.parse(`${ymd}T00:00:00+08:00`);
}

function addDaysToYMD(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}


function parseDateFromQuery(query: string, defaultYear: number): { ymd: string; explicit: boolean } | null {
  const q = query;

  let m = q.match(/(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*(?:日)?/);
  if (m) {
    return { ymd: `${Number(m[1])}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`, explicit: true };
  }

  m = q.match(/(?:^|\D)(\d{1,2})\s*\/\s*(\d{1,2})(?:\D|$)/);
  if (m) {
    return { ymd: `${defaultYear}-${pad2(Number(m[1]))}-${pad2(Number(m[2]))}`, explicit: true };
  }

  return null;
}


function looksLikePriceQuery(query: string): boolean {
  const q = query.toLowerCase();
  const kws = [
    "股價",
    "價格",
    "報價",
    "現價",
    "即時",
    "最新",
    "多少錢",
    "多少",
    "盤中",
    "成交價",
    "成交",
    "price",
    "quote",
  ];
  return kws.some((k) => q.includes(k));
}


function isCloseIntent(query: string): boolean {
  const q = query.toLowerCase();
  return ["收盤", "收盤價", "close", "昨日收盤", "前一日收盤", "歷史", "歷史股價"].some((k) => q.includes(k));
}


function isRealtimeIntent(query: string): boolean {
  const q = query.toLowerCase();
  const yes = ["即時", "現在", "現價", "最新", "盤中", "多少錢", "多少", "報價", "realtime", "real-time", "live"].some(
    (k) => q.includes(k)
  );
  return yes && !isCloseIntent(query);
}


function isTechnicalAnalysisQuery(query: string): boolean {
  const q = query.toLowerCase();
  const kws = [
    "技術分析",
    "均線",
    "ma",
    "macd",
    "kd",
    "kdj",
    "rsi",
    "布林",
    "boll",
    "支撐",
    "壓力",
    "趨勢",
    "型態",
    "technical",
    "indicator",
  ];
  return kws.some((k) => q.includes(k));
}

function toNumberMaybe(x: any): number | null {
  const s = String(x ?? "").replace(/,/g, "").trim();
  if (!s || s === "--" || s === "-" || s.toLowerCase() === "na") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}


function inferTaiwanCodeFromQuery(query: string): string | null {
  const q = query.trim();

  let m = q.match(/(^|[^\w])(\d{4,6}[A-Za-z]?)(?:\.(?:TW|TWO))([^\w]|$)/);
  if (m) return m[2].toUpperCase();

  m = q.match(/(^|[^\d])(\d{4,6}[A-Za-z]?)(?!\d)/);
  if (m) {
    const code = m[2].toUpperCase();
    if (/^20(2[4-6])$/.test(code)) return null;
    return code;
  }

  return null;
}


function inferFromNameMap(query: string): { code: string; name: string } | null {
  const nameMap: Array<[RegExp, { code: string; name: string }]> = [
    [/台積電|tsmc/i, { code: "2330", name: "台積電" }],
    [/鴻海/i, { code: "2317", name: "鴻海" }],
    [/台塑/i, { code: "1301", name: "台塑" }],
    [/台泥/i, { code: "1101", name: "台泥" }],
    [/聯發科/i, { code: "2454", name: "聯發科" }],
    [/中華電/i, { code: "2412", name: "中華電" }],
    [/國泰金/i, { code: "2882", name: "國泰金" }],
    [/富邦金/i, { code: "2881", name: "富邦金" }],
  ];
  for (const [re, v] of nameMap) if (re.test(query)) return v;
  return null;
}


async function yahooSearchTaiwanSymbol(userQuery: string): Promise<{ symbol: string; shortname?: string } | null> {
  const url =
    "https://query2.finance.yahoo.com/v1/finance/search?q=" +
    encodeURIComponent(userQuery) +
    "&quotesCount=10&newsCount=0&enableFuzzyQuery=true";

  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json,text/plain,*",
    },
  });

  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  const quotes: any[] = Array.isArray(json?.quotes) ? json.quotes : [];

  const picked =
    quotes.find((q) => typeof q?.symbol === "string" && (q.symbol.endsWith(".TW") || q.symbol.endsWith(".TWO"))) || null;

  if (!picked?.symbol) return null;
  return { symbol: String(picked.symbol), shortname: picked.shortname || picked.longname };
}



function deepPickNumberByKey(root: any, keyMatchers: RegExp[]): number | null {
  const seen = new Set<any>();
  const q: any[] = [root];

  while (q.length) {
    const cur = q.shift();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    if (Array.isArray(cur)) {
      for (const v of cur) q.push(v);
      continue;
    }

    for (const [k, v] of Object.entries(cur)) {
      if (keyMatchers.some((re) => re.test(k))) {
        const n = typeof v === "number" ? v : toNumberMaybe(v);
        if (n != null && n > 0 && n < 1_000_000) return n;
      }
      if (v && typeof v === "object") q.push(v);
      if (Array.isArray(v)) q.push(v);
    }
  }
  return null;
}

function pickWantgooLatestPrice(json: any): { price: number; time?: string } | null {
  const arr: any[] | null =
    (Array.isArray(json) ? json : null) ||
    (Array.isArray(json?.data) ? json.data : null) ||
    (Array.isArray(json?.result) ? json.result : null);

  const candidate = arr && arr.length ? arr[arr.length - 1] : json;

  const price =
    deepPickNumberByKey(candidate, [/dealprice/i, /tradeprice/i, /lastprice/i, /nowprice/i, /^price$/i, /成交價/i]) ??
    null;

  if (price == null) return null;

  // 嘗試抓時間欄位（不保證存在）
  const timeStr =
    (candidate && (candidate.time || candidate.tradeTime || candidate.tradetime || candidate.t || candidate.datetime)) ??
    undefined;

  return { price, time: timeStr ? String(timeStr) : undefined };
}

async function fetchWantgooRealtimePrice(code: string, taipeiYmd: string) {
  const tradeDate = getTaipeiMidnightEpochMs(taipeiYmd); // 例如 2026-01-06 -> 2026-01-05T16:00Z ms
  const v = Date.now();

  const url = `https://www.wantgoo.com/investrue/${encodeURIComponent(
    code
  )}/realtimeprice-tradedate?tradeDate=${tradeDate}&v=${v}`;

  // ⚠️ wantgoo 可能有 Cloudflare / x-client-signature；我們先「不帶 cookie」嘗試
  // 若你環境會 403，再把簽名/必要 header 做成 env 進來（見下方說明）
  const extraSig = process.env.WANTGOO_CLIENT_SIGNATURE?.trim();
  const headers: Record<string, string> = {
    Accept: "*",
    "User-Agent": "Mozilla/5.0",
    Referer: `https://www.wantgoo.com/stock/${code}`,
    "X-Requested-With": "XMLHttpRequest",
  };
  if (extraSig) headers["x-client-signature"] = extraSig;

  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers,
  });

  if (!res.ok) {
    throw new Error(`wantgoo api failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json().catch(() => null);
  const picked = pickWantgooLatestPrice(json);

  return { url, picked };
}


function parsePriceList(s: any): number[] {
  const raw = String(s ?? "").trim();
  if (!raw || raw === "--") return [];
  // MIS 常見格式："123.0_122.5_122.0_121.5_121.0"
  return raw
    .split("_")
    .map((x) => toNumberMaybe(x))
    .filter((x): x is number => x != null);
}

async function fetchTwseMisRealtime(code: string) {
  const exCh = `tse_${code}.tw|otc_${code}.tw`;
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${encodeURIComponent(exCh)}`;

  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://mis.twse.com.tw/stock/fibest.jsp",
      Accept: "application/json,text/plain,*",
    },
  });

  if (!res.ok) throw new Error(`MIS failed: ${res.status} ${res.statusText}`);
  const json: any = await res.json().catch(() => null);

  const arr: any[] = Array.isArray(json?.msgArray) ? json.msgArray : [];
  if (!arr.length) return null;

  const pick = arr.find((it) => toNumberMaybe(it?.y) != null) || arr[0];

  const last = toNumberMaybe(pick?.z); // 最新成交（可能為 null）
  const prevClose = toNumberMaybe(pick?.y);
  const open = toNumberMaybe(pick?.o);
  const high = toNumberMaybe(pick?.h);
  const low = toNumberMaybe(pick?.l);

  const bid = parsePriceList(pick?.b);
  const ask = parsePriceList(pick?.a);
  const bestBid = bid.length ? bid[0] : null;
  const bestAsk = ask.length ? ask[0] : null;

  const name = (pick?.n || pick?.nf || pick?.name || "").toString().trim() || undefined;
  const time = (pick?.t || "").toString().trim();
  const date = (pick?.d || "").toString().trim();

  return {
    last,
    prevClose,
    open,
    high,
    low,
    bestBid,
    bestAsk,
    name,
    rawTime: time,
    rawDate: date,
    sourceUrl: url,
  };
}


async function fetchYahooQuote(symbol: string) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json,text/plain,*",
    },
  });
  if (!res.ok) throw new Error(`Yahoo quote failed: ${res.status} ${res.statusText}`);

  const json: any = await res.json().catch(() => null);
  const r = json?.quoteResponse?.result?.[0];
  if (!r) return null;

  const price = typeof r?.regularMarketPrice === "number" ? r.regularMarketPrice : null;
  const prevClose = typeof r?.regularMarketPreviousClose === "number" ? r.regularMarketPreviousClose : null;
  const open = typeof r?.regularMarketOpen === "number" ? r.regularMarketOpen : null;
  const high = typeof r?.regularMarketDayHigh === "number" ? r.regularMarketDayHigh : null;
  const low = typeof r?.regularMarketDayLow === "number" ? r.regularMarketDayLow : null;
  const name = (r?.shortName || r?.longName || "").toString().trim() || undefined;

  const t = typeof r?.regularMarketTime === "number" ? r.regularMarketTime : null;
  return { price, prevClose, open, high, low, name, marketTimeEpochSec: t, sourceUrl: url };
}

function formatTaipeiTimeFromEpoch(epochSec: number | null): string | null {
  if (!epochSec) return null;
  const dt = new Date(epochSec * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(dt);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`;
}


async function fetchTwseStockDayMonth(stockNo: string, yyyy: number, mm: number) {
  const dateParam = `${yyyy}${pad2(mm)}01`;
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateParam}&stockNo=${encodeURIComponent(
    stockNo
  )}`;

  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json,text/plain,*",
    },
  });

  if (!res.ok) throw new Error(`TWSE STOCK_DAY failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  return { url, json };
}

function parseTwseRowDateToISO(s: string): string | null {
  const m = String(s).trim().match(/^(\d{2,4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  let y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900) y += 1911;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

async function getTwseCloseForDateOrPrev(stockNo: string, targetYmd: string) {
  const [y, m] = targetYmd.split("-").map(Number);

  const tryMonths: Array<{ yy: number; mm: number }> = [{ yy: y, mm: m }];
  const prev = new Date(Date.UTC(y, m - 2, 1));
  tryMonths.push({ yy: prev.getUTCFullYear(), mm: prev.getUTCMonth() + 1 });

  let best: { ymd: string; row: string[]; sourceUrl: string; fields?: string[]; closeIdx: number } | null = null;

  for (const mon of tryMonths) {
    const { url, json } = await fetchTwseStockDayMonth(stockNo, mon.yy, mon.mm);
    const rows: string[][] = Array.isArray(json?.data) ? json.data : [];
    const fields: string[] | undefined = Array.isArray(json?.fields) ? json.fields : undefined;

    let closeIdx = 6;
    if (fields?.length) {
      const i = fields.findIndex((f) => String(f).includes("收盤"));
      if (i >= 0) closeIdx = i;
    }

    for (const row of rows) {
      const rowYmd = parseTwseRowDateToISO(row?.[0]);
      if (!rowYmd) continue;

      if (rowYmd <= targetYmd) {
        if (!best || rowYmd > best.ymd) {
          best = { ymd: rowYmd, row, sourceUrl: url, fields, closeIdx };
        }
      }
    }
  }

  if (!best) return null;

  const row = best.row;
  const open = toNumberMaybe(row?.[3]);
  const high = toNumberMaybe(row?.[4]);
  const low = toNumberMaybe(row?.[5]);
  const close = toNumberMaybe(row?.[best.closeIdx]);
  const volume = toNumberMaybe(row?.[1]);

  return { ymd: best.ymd, open, high, low, close, volume, sourceUrl: best.sourceUrl };
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


function extractMarkdownLinks(text: string): UrlCitation[] {
  const out: UrlCitation[] = [];
  const re = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ title: m[1], url: m[2] });
  }
  const seen = new Set<string>();
  return out.filter((c) => {
    const key = `${c.title || ""}__${c.url || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    // ✅ 1) 台股/ETF：即時 & 收盤（不走 web_search）
    // =========================================================
    const dateInQuery = parseDateFromQuery(query, taipei.year);
    const priceLike = looksLikePriceQuery(query) || isRealtimeIntent(query) || isCloseIntent(query);

    const fromMap = inferFromNameMap(query);
    let finalCode = inferTaiwanCodeFromQuery(query) || fromMap?.code || null;

    // 若只有名稱（例如「鴻海多少錢」），用 Yahoo search 補 symbol/code
    let finalSymbol: string | null = null;
    if (priceLike) {
      if (finalCode) {
        finalSymbol = `${finalCode}.TW`; // 先假設 TW；若 Yahoo search 找到會覆蓋
      } else {
        const s = await yahooSearchTaiwanSymbol(query);
        if (s?.symbol) {
          finalSymbol = s.symbol;
          finalCode = s.symbol.split(".")[0].toUpperCase();
        }
      }
    }

    const hasTaiwanInstrument = !!(priceLike && finalCode && finalSymbol);

    if (hasTaiwanInstrument) {
      // 1a) 指定日期或明確收盤：走 TWSE STOCK_DAY
      if (dateInQuery?.explicit || isCloseIntent(query)) {
        let targetYmd = dateInQuery?.ymd ?? taipei.ymd;

        // 問「今天收盤」但現在還沒到收盤後資料時間（台股約 13:30 收盤，留 5 分鐘緩衝）
        const afterCloseLikely = taipei.hour > 13 || (taipei.hour === 13 && taipei.minute >= 35);
        if (!dateInQuery?.explicit && isCloseIntent(query) && !afterCloseLikely) {
          targetYmd = addDaysToYMD(taipei.ymd, -1);
        }

        try {
          const twse = await getTwseCloseForDateOrPrev(finalCode!, targetYmd);

          if (twse?.close != null) {
            const sameDay = twse.ymd === targetYmd;
            const answer =
              `台北時間基準：${taipeiNow}\n` +
              `代號：${finalCode}（${finalSymbol}）${fromMap?.name ? `（${fromMap.name}）` : ""}\n` +
              (sameDay
                ? `✅ ${twse.ymd} 收盤價：${twse.close} TWD`
                : `⚠️ 找不到 ${targetYmd} 當日資料（可能休市/尚未更新/非交易日），最近可取得交易日：${twse.ymd}\n收盤價：${twse.close} TWD`) +
              (twse.open != null || twse.high != null || twse.low != null
                ? `\n（開/高/低：${twse.open ?? "—"} / ${twse.high ?? "—"} / ${twse.low ?? "—"}）`
                : "") +
              (twse.volume != null ? `\n成交股數：${twse.volume}` : "");

            const citations: UrlCitation[] = [{ title: `TWSE STOCK_DAY ${finalCode}（日資料/收盤）`, url: twse.sourceUrl }];

            return Response.json({
              answer,
              citations,
              meta: {
                query,
                mode: "tw_close_stock_day",
                taipeiNow,
                stockNo: finalCode,
                symbol: finalSymbol,
                targetYmd,
                resolvedYmd: twse.ymd,
              },
            });
          }
        } catch {
          // STOCK_DAY 失敗 → Yahoo prevClose fallback（會明講）
          try {
            const yq = await fetchYahooQuote(finalSymbol!);
            if (yq?.prevClose != null) {
              const t = formatTaipeiTimeFromEpoch(yq.marketTimeEpochSec);
              const answer =
                `台北時間基準：${taipeiNow}\n` +
                `代號：${finalCode}（${finalSymbol}）${yq.name ? `（${yq.name}）` : ""}\n` +
                `⚠️ 目前無法取得 TWSE 日資料（收盤/歷史），改用 Yahoo Quote 的「前一交易日收盤」作為最近可得資訊。\n` +
                `前一交易日收盤（previousClose）：${yq.prevClose}（可能有延遲）` +
                (t ? `\n資料時間（台北）：${t}` : "");

              const citations: UrlCitation[] = [{ title: `Yahoo Quote ${finalSymbol}`, url: yq.sourceUrl }];
              return Response.json({
                answer,
                citations,
                meta: { query, mode: "close_fallback_yahoo_prevclose", taipeiNow, stockNo: finalCode, symbol: finalSymbol },
              });
            }
          } catch {
            // ignore
          }
        }
        // 若都失敗，最後才進 web_search（下面會處理）
      } else {
        // 1b) 即時：wantgoo XHR → MIS → Yahoo
        const realtimePrefer = isRealtimeIntent(query) || (looksLikePriceQuery(query) && !isCloseIntent(query) && !dateInQuery?.explicit);

        if (realtimePrefer) {
          // wantgoo 先嘗試（你要的行為）
          try {
            const wg = await fetchWantgooRealtimePrice(finalCode!, taipei.ymd);
            if (wg.picked?.price != null) {
              const answer =
                `台北時間基準：${taipeiNow}\n` +
                `代號：${finalCode}（${finalSymbol}）${fromMap?.name ? `（${fromMap.name}）` : ""}\n` +
                `✅ 最新價格（wantgoo）：${wg.picked.price} TWD` +
                (wg.picked.time ? `\n資料時間（wantgoo）：${wg.picked.time}` : "") +
                `\n（註：第三方報價可能延遲；若需完全即時請以券商/交易所為準）`;

              return Response.json({
                answer,
                citations: [{ title: `wantgoo realtime ${finalCode}`, url: wg.url }],
                meta: { query, mode: "realtime_wantgoo_xhr_first", taipeiNow, stockNo: finalCode, symbol: finalSymbol },
              });
            }
          } catch {
            // wantgoo 被擋 / 解析不到 → 繼續 MIS
          }
        }

        // TWSE MIS（官方）
        let mis: Awaited<ReturnType<typeof fetchTwseMisRealtime>> | null = null;
        try {
          mis = await fetchTwseMisRealtime(finalCode!);
        } catch {
          mis = null;
        }

        if (mis && (mis.last != null || mis.bestBid != null || mis.bestAsk != null || mis.prevClose != null)) {
          // 如果沒有成交價，用 best bid/ask 或昨收當「可回覆資訊」，避免回查不到
          const hasTrade = mis.last != null;
          const bestLine =
            mis.bestBid != null || mis.bestAsk != null
              ? `\n最佳買/賣：${mis.bestBid ?? "—"} / ${mis.bestAsk ?? "—"}`
              : "";

          const answer =
            `台北時間基準：${taipeiNow}\n` +
            `代號：${finalCode}（${finalSymbol}）${mis.name ? `（${mis.name}）` : ""}\n` +
            (hasTrade ? `✅ 最新成交（TWSE MIS）：${mis.last} TWD` : `⚠️ 目前尚未有「成交價」回傳（可能尚未撮合），改提供買賣報價/參考價`) +
            bestLine +
            (mis.prevClose != null ? `\n昨收/參考價：${mis.prevClose} TWD` : "") +
            (mis.open != null || mis.high != null || mis.low != null
              ? `\n（開/高/低：${mis.open ?? "—"} / ${mis.high ?? "—"} / ${mis.low ?? "—"}）`
              : "") +
            (mis.rawDate && mis.rawTime ? `\n資料時間（交易所回傳）：${mis.rawDate} ${mis.rawTime}` : "");

          const citations: UrlCitation[] = [{ title: `TWSE MIS 即時報價 ${finalCode}`, url: mis.sourceUrl }];

          return Response.json({
            answer,
            citations,
            meta: { query, mode: "realtime_mis_fallback", taipeiNow, stockNo: finalCode, symbol: finalSymbol },
          });
        }

        // Yahoo quote fallback
        try {
          const yq = await fetchYahooQuote(finalSymbol!);
          if (yq && (yq.price != null || yq.prevClose != null)) {
            const t = formatTaipeiTimeFromEpoch(yq.marketTimeEpochSec);
            const answer =
              `台北時間基準：${taipeiNow}\n` +
              `代號：${finalCode}（${finalSymbol}）${yq.name ? `（${yq.name}）` : ""}\n` +
              `✅ 最新價格（Yahoo）：${yq.price ?? "—"}\n` +
              `昨收：${yq.prevClose ?? "—"}` +
              (yq.open != null || yq.high != null || yq.low != null
                ? `\n（開/高/低：${yq.open ?? "—"} / ${yq.high ?? "—"} / ${yq.low ?? "—"}）`
                : "") +
              (t ? `\n資料時間（台北）：${t}` : "") +
              `\n（註：Yahoo 報價可能有延遲；若需完全即時請以券商/交易所為準）`;

            const citations: UrlCitation[] = [{ title: `Yahoo Quote ${finalSymbol}`, url: yq.sourceUrl }];
            return Response.json({
              answer,
              citations,
              meta: { query, mode: "realtime_yahoo_fallback", taipeiNow, stockNo: finalCode, symbol: finalSymbol },
            });
          }
        } catch {
          // ignore
        }

        // 最後：給最近收盤
        try {
          const twse = await getTwseCloseForDateOrPrev(finalCode!, taipei.ymd);
          if (twse?.close != null) {
            const answer =
              `台北時間基準：${taipeiNow}\n` +
              `代號：${finalCode}（${finalSymbol}）\n` +
              `⚠️ 目前無法取得即時報價，改提供最近可取得交易日收盤：\n` +
              `✅ ${twse.ymd} 收盤價：${twse.close} TWD`;

            const citations: UrlCitation[] = [{ title: `TWSE STOCK_DAY ${finalCode}（日資料/收盤）`, url: twse.sourceUrl }];
            return Response.json({
              answer,
              citations,
              meta: { query, mode: "realtime_failed_close_fallback", taipeiNow, stockNo: finalCode, symbol: finalSymbol },
            });
          }
        } catch {
          // ignore
        }
      }
    }

    // =========================================================
    // ✅ 2) 非股價類問題：才走 web_search / 搜尋模型
    // =========================================================
    const model = process.env.WEB_SEARCH_MODEL || "gpt-4o-mini";
    const isSearchPreviewModel = /-search-(preview|api)\b/i.test(model);

    const mergedDomains = (() => {
      const extra: string[] = [];
      if (isTechnicalAnalysisQuery(query)) extra.push("ifa.ai");
      return normalizeDomains([...(domains || []), ...extra]);
    })();

    const basePrompt = [
      "你是一個網路研究助理。請先使用網路搜尋，再用繁體中文回答。",
      "",
      "【時間基準】",
      `- 現在的台北時間（Asia/Taipei）是：${taipeiNow}`,
      "- 使用者提到「今天/昨日/最近/本週」等相對時間，一律以 Asia/Taipei 推算，不要用 UTC。",
      "",
      "【可靠性規則（務必遵守）】",
      "- 先把問題改寫成 2~4 個更可搜的查詢（必要時包含中/英文關鍵字），再整合答案。",
      "- 對於會變動或容易出錯的資訊（價格、日期、規則、名單、政策、數字統計）：至少用 2 個獨立來源交叉確認；若只有單一來源，請標註「可能有延遲/僅單一來源」。",
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
      mergedDomains.length ? `- 若可行，優先參考這些網域：${mergedDomains.join(", ")}` : "",
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
      let citations = extractUrlCitationsFromChat(respJson);
      if (!citations.length) citations = extractMarkdownLinks(answer).slice(0, 10);

      return Response.json({
        answer,
        citations: citations.slice(0, 10),
        meta: { query, recency_days, domains: mergedDomains, model, mode: "chat_completions", taipeiNow },
      });
    }

    const tools: any[] = [
      {
        type: "web_search",
        ...(mergedDomains.length ? { filters: { allowed_domains: mergedDomains } } : {}),
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
    let citations = extractUrlCitationsFromResponses(respJson);
    if (!citations.length) citations = extractMarkdownLinks(answer).slice(0, 10);

    return Response.json({
      answer,
      citations: citations.slice(0, 10),
      meta: { query, recency_days, domains: mergedDomains, model, mode: "responses", taipeiNow },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500 });
  }
}*/

// 0108 realtime price, 漲跌幅, 交易量

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
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;

  const y = map.year!;
  const m = map.month!;
  const d = map.day!;
  const hh = map.hour!;
  const mm = map.minute!;
  const ss = map.second!;
  return {
    iso: `${y}-${m}-${d}T${hh}:${mm}:${ss}`,
    ymd: `${y}-${m}-${d}`,
    year: Number(y),
    hour: Number(hh),
    minute: Number(mm),
  };
}

// 台北當日 00:00（+08:00）的 epoch ms（wantgoo tradeDate 需要這個）
function getTaipeiMidnightEpochMs(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00+08:00`);
}

function addDaysToYMD(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 支援：YYYY-MM-DD / YYYY/MM/DD / YYYY年MM月DD日 / MM/DD(用當年) */
function parseDateFromQuery(query: string, defaultYear: number): { ymd: string; explicit: boolean } | null {
  const q = query;

  let m = q.match(/(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*(?:日)?/);
  if (m) {
    return { ymd: `${Number(m[1])}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`, explicit: true };
  }

  m = q.match(/(?:^|\D)(\d{1,2})\s*\/\s*(\d{1,2})(?:\D|$)/);
  if (m) {
    return { ymd: `${defaultYear}-${pad2(Number(m[1]))}-${pad2(Number(m[2]))}`, explicit: true };
  }

  return null;
}

/** 是否在問「股價/報價」 */
function looksLikePriceQuery(query: string): boolean {
  const q = query.toLowerCase();
  const kws = ["股價", "價格", "報價", "現價", "即時", "最新", "多少錢", "多少", "盤中", "成交價", "成交", "price", "quote"];
  return kws.some((k) => q.includes(k));
}

/** 是否在問「成交量/交易量」 */
function looksLikeVolumeQuery(query: string): boolean {
  const q = query.toLowerCase();
  const kws = ["成交量", "交易量", "量", "volume", "vol", "成交股數", "成交張數"];
  return kws.some((k) => q.includes(k));
}

/** 是否明確在問收盤/歷史 */
function isCloseIntent(query: string): boolean {
  const q = query.toLowerCase();
  return ["收盤", "收盤價", "close", "昨日收盤", "前一日收盤", "歷史", "歷史股價"].some((k) => q.includes(k));
}

/** 是否明確在問即時 */
function isRealtimeIntent(query: string): boolean {
  const q = query.toLowerCase();
  const yes = ["即時", "現在", "現價", "最新", "盤中", "多少錢", "多少", "報價", "realtime", "real-time", "live"].some((k) =>
    q.includes(k)
  );
  return yes && !isCloseIntent(query);
}

/** 技術分析意圖（先保留） */
function isTechnicalAnalysisQuery(query: string): boolean {
  const q = query.toLowerCase();
  const kws = ["技術分析", "均線", "ma", "macd", "kd", "kdj", "rsi", "布林", "boll", "支撐", "壓力", "趨勢", "型態", "technical", "indicator"];
  return kws.some((k) => q.includes(k));
}

function toNumberMaybe(x: any): number | null {
  const s = String(x ?? "").replace(/,/g, "").trim();
  if (!s || s === "--" || s === "-" || s.toLowerCase() === "na") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function formatSigned(n: number, digits = 2) {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return sign + abs.toFixed(digits);
}

function calcChange(last: number | null, prevClose: number | null) {
  if (last == null || prevClose == null || prevClose === 0) return null;
  const chg = last - prevClose;
  const pct = (chg / prevClose) * 100;
  return { chg, pct };
}

/**
 * ✅ 成交量格式化：一律用「張」顯示
 * - unit="lots": 來源是「張」（MIS）
 * - unit="shares": 來源是「股」（TWSE STOCK_DAY / Yahoo）
 */
function formatTaiwanVolume(volume: number | null, unit: "lots" | "shares" = "shares") {
  if (volume == null) return null;

  if (unit === "lots") {
    return `${Math.round(volume).toLocaleString("en-US")} 張`;
  }

  const lots = volume / 1000;
  const lotsText =
    Number.isInteger(lots) ? lots.toLocaleString("en-US") : lots.toFixed(3).replace(/\.?0+$/, "");
  return `${lotsText} 張`;
}

/**
 * ✅ 沒成交價時，用買賣報價推估漲跌幅（避免 chgLine 變空）
 * - 有 last：用 last
 * - 有 bid+ask：用中間價
 * - 只有 bid 或 ask：用該價
 */
function pickIndicativePriceForChange(input: {
  last: number | null;
  bestBid: number | null;
  bestAsk: number | null;
}): { price: number; label: string } | null {
  if (input.last != null) return { price: input.last, label: "最新成交" };

  if (input.bestBid != null && input.bestAsk != null) {
    return { price: (input.bestBid + input.bestAsk) / 2, label: "買賣中間價（尚未成交）" };
  }
  if (input.bestBid != null) return { price: input.bestBid, label: "最佳買價（尚未成交）" };
  if (input.bestAsk != null) return { price: input.bestAsk, label: "最佳賣價（尚未成交）" };

  return null;
}

/**
 * 從 query 抓台股代碼：支援 4~6 位數 + 可選字母（例如 00687B）
 * 也支援 2330.TW / 2330.TWO（只取主碼）
 */
function inferTaiwanCodeFromQuery(query: string): string | null {
  const q = query.trim();

  let m = q.match(/(^|[^\w])(\d{4,6}[A-Za-z]?)(?:\.(?:TW|TWO))([^\w]|$)/);
  if (m) return m[2].toUpperCase();

  m = q.match(/(^|[^\d])(\d{4,6}[A-Za-z]?)(?!\d)/);
  if (m) {
    const code = m[2].toUpperCase();
    if (/^20(2[4-6])$/.test(code)) return null;
    return code;
  }

  return null;
}

/** 少量常見名稱映射（可自行擴充）；找不到就走 Yahoo Search */
function inferFromNameMap(query: string): { code: string; name: string } | null {
  const nameMap: Array<[RegExp, { code: string; name: string }]> = [
    [/台積電|tsmc/i, { code: "2330", name: "台積電" }],
    [/鴻海/i, { code: "2317", name: "鴻海" }],
    [/台塑/i, { code: "1301", name: "台塑" }],
    [/台泥/i, { code: "1101", name: "台泥" }],
    [/聯發科/i, { code: "2454", name: "聯發科" }],
    [/中華電/i, { code: "2412", name: "中華電" }],
    [/國泰金/i, { code: "2882", name: "國泰金" }],
    [/富邦金/i, { code: "2881", name: "富邦金" }],
  ];
  for (const [re, v] of nameMap) if (re.test(query)) return v;
  return null;
}

/** 用 Yahoo Search 把「名稱」轉成 symbol（1301.TW / 6488.TWO / 00687B.TW ...） */
async function yahooSearchTaiwanSymbol(userQuery: string): Promise<{ symbol: string; shortname?: string } | null> {
  const url =
    "https://query2.finance.yahoo.com/v1/finance/search?q=" +
    encodeURIComponent(userQuery) +
    "&quotesCount=10&newsCount=0&enableFuzzyQuery=true";

  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json,text/plain,*/*",
    },
  });

  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  const quotes: any[] = Array.isArray(json?.quotes) ? json.quotes : [];

  const picked =
    quotes.find((q) => typeof q?.symbol === "string" && (q.symbol.endsWith(".TW") || q.symbol.endsWith(".TWO"))) || null;

  if (!picked?.symbol) return null;
  return { symbol: String(picked.symbol), shortname: picked.shortname || picked.longname };
}

/** ===== wantgoo：XHR API 抓「最新成交」 ===== */

function deepPickNumberByKey(root: any, keyMatchers: RegExp[]): number | null {
  const seen = new Set<any>();
  const q: any[] = [root];

  while (q.length) {
    const cur = q.shift();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    if (Array.isArray(cur)) {
      for (const v of cur) q.push(v);
      continue;
    }

    for (const [k, v] of Object.entries(cur)) {
      if (keyMatchers.some((re) => re.test(k))) {
        const n = typeof v === "number" ? v : toNumberMaybe(v);
        if (n != null && n > 0 && n < 1_000_000) return n;
      }
      if (v && typeof v === "object") q.push(v);
      if (Array.isArray(v)) q.push(v);
    }
  }
  return null;
}

function pickWantgooLatestPrice(json: any): { price: number; time?: string } | null {
  const arr: any[] | null =
    (Array.isArray(json) ? json : null) ||
    (Array.isArray(json?.data) ? json.data : null) ||
    (Array.isArray(json?.result) ? json.result : null);

  const candidate = arr && arr.length ? arr[arr.length - 1] : json;

  const price =
    deepPickNumberByKey(candidate, [/dealprice/i, /tradeprice/i, /lastprice/i, /nowprice/i, /^price$/i, /成交價/i]) ?? null;

  if (price == null) return null;

  const timeStr =
    (candidate && (candidate.time || candidate.tradeTime || candidate.tradetime || candidate.t || candidate.datetime)) ?? undefined;

  return { price, time: timeStr ? String(timeStr) : undefined };
}

async function fetchWantgooRealtimePrice(code: string, taipeiYmd: string) {
  const tradeDate = getTaipeiMidnightEpochMs(taipeiYmd);
  const v = Date.now();

  const url = `https://www.wantgoo.com/investrue/${encodeURIComponent(code)}/realtimeprice-tradedate?tradeDate=${tradeDate}&v=${v}`;

  const extraSig = process.env.WANTGOO_CLIENT_SIGNATURE?.trim();
  const headers: Record<string, string> = {
    Accept: "*/*",
    "User-Agent": "Mozilla/5.0",
    Referer: `https://www.wantgoo.com/stock/${code}`,
    "X-Requested-With": "XMLHttpRequest",
  };
  if (extraSig) headers["x-client-signature"] = extraSig;

  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers,
  });

  if (!res.ok) {
    throw new Error(`wantgoo api failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json().catch(() => null);
  const picked = pickWantgooLatestPrice(json);

  return { url, picked };
}

/** ===== TWSE MIS 即時（官方盤中報價） ===== */

function parsePriceList(s: any): number[] {
  const raw = String(s ?? "").trim();
  if (!raw || raw === "--") return [];
  return raw
    .split("_")
    .map((x) => toNumberMaybe(x))
    .filter((x): x is number => x != null);
}

/** 取 set-cookie（undici/Node 有時會是多個） */
function getSetCookies(res: Response): string[] {
  const h: any = res.headers as any;
  const out: string[] = [];

  if (typeof h.getSetCookie === "function") {
    try {
      const v = h.getSetCookie();
      if (Array.isArray(v)) out.push(...v);
    } catch {
      // ignore
    }
  }

  const single = res.headers.get("set-cookie");
  if (single) out.push(single);

  return out.filter(Boolean);
}

/** set-cookie -> Cookie header (name=value; name2=value2) */
function toCookieHeader(setCookies: string[]): string | undefined {
  const kv = setCookies
    .map((sc) => String(sc).split(";")[0]?.trim())
    .filter(Boolean);

  if (!kv.length) return undefined;
  return Array.from(new Set(kv)).join("; ");
}

/**
 * ✅ MIS 常需要先打 fibest.jsp 建立 session cookie
 * 否則 getStockInfo.jsp 可能回空 msgArray
 */
async function fetchTwseMisRealtime(code: string) {
  const initUrl = `https://mis.twse.com.tw/stock/fibest.jsp?stockNo=${encodeURIComponent(code)}`;

  const initRes = await fetch(initUrl, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      Referer: "https://mis.twse.com.tw/stock/fibest.jsp",
    },
  });

  const cookieHeader = toCookieHeader(getSetCookies(initRes));

  const exCh = `tse_${code}.tw|otc_${code}.tw`;
  const url =
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${encodeURIComponent(exCh)}` +
    `&_=${Date.now()}`;

  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: initUrl,
      Accept: "application/json,text/plain,*/*",
      "X-Requested-With": "XMLHttpRequest",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  });

  if (!res.ok) throw new Error(`MIS failed: ${res.status} ${res.statusText}`);
  const json: any = await res.json().catch(() => null);

  const arr: any[] = Array.isArray(json?.msgArray) ? json.msgArray : [];
  if (!arr.length) return null;

  const pick = arr.find((it) => toNumberMaybe(it?.y) != null) || arr[0];

  const last = toNumberMaybe(pick?.z); // 最新成交
  const prevClose = toNumberMaybe(pick?.y); // 昨收
  const open = toNumberMaybe(pick?.o);
  const high = toNumberMaybe(pick?.h);
  const low = toNumberMaybe(pick?.l);

  const bid = parsePriceList(pick?.b);
  const ask = parsePriceList(pick?.a);
  const bestBid = bid.length ? bid[0] : null;
  const bestAsk = ask.length ? ask[0] : null;

  // ✅ 你的實測：MIS v/tv 是「張」
  const volumeLots = toNumberMaybe(pick?.v) ?? toNumberMaybe(pick?.tv) ?? null;

  const name = (pick?.n || pick?.nf || pick?.name || "").toString().trim() || undefined;
  const time = (pick?.t || "").toString().trim();
  const date = (pick?.d || "").toString().trim();

  return {
    last,
    prevClose,
    open,
    high,
    low,
    bestBid,
    bestAsk,
    volumeLots,
    name,
    rawTime: time,
    rawDate: date,
    sourceUrl: url,
  };
}

/** ===== Yahoo Quote JSON（非爬 HTML） ===== */
async function fetchYahooQuote(symbol: string) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json,text/plain,*/*",
    },
  });
  if (!res.ok) throw new Error(`Yahoo quote failed: ${res.status} ${res.statusText}`);

  const json: any = await res.json().catch(() => null);
  const r = json?.quoteResponse?.result?.[0];
  if (!r) return null;

  const price = typeof r?.regularMarketPrice === "number" ? r.regularMarketPrice : null;
  const prevClose = typeof r?.regularMarketPreviousClose === "number" ? r.regularMarketPreviousClose : null;
  const open = typeof r?.regularMarketOpen === "number" ? r.regularMarketOpen : null;
  const high = typeof r?.regularMarketDayHigh === "number" ? r.regularMarketDayHigh : null;
  const low = typeof r?.regularMarketDayLow === "number" ? r.regularMarketDayLow : null;
  const volume = typeof r?.regularMarketVolume === "number" ? r.regularMarketVolume : null;
  const name = (r?.shortName || r?.longName || "").toString().trim() || undefined;

  const t = typeof r?.regularMarketTime === "number" ? r.regularMarketTime : null;
  return { price, prevClose, open, high, low, volume, name, marketTimeEpochSec: t, sourceUrl: url };
}

function formatTaipeiTimeFromEpoch(epochSec: number | null): string | null {
  if (!epochSec) return null;
  const dt = new Date(epochSec * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(dt);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`;
}

/** ===== TWSE 日資料：STOCK_DAY（查某月） ===== */
async function fetchTwseStockDayMonth(stockNo: string, yyyy: number, mm: number) {
  const dateParam = `${yyyy}${pad2(mm)}01`;
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateParam}&stockNo=${encodeURIComponent(stockNo)}`;

  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json,text/plain,*/*",
    },
  });

  if (!res.ok) throw new Error(`TWSE STOCK_DAY failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  return { url, json };
}

function parseTwseRowDateToISO(s: string): string | null {
  const m = String(s).trim().match(/^(\d{2,4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  let y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900) y += 1911;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

async function getTwseCloseForDateOrPrev(stockNo: string, targetYmd: string) {
  const [y, m] = targetYmd.split("-").map(Number);

  const tryMonths: Array<{ yy: number; mm: number }> = [{ yy: y, mm: m }];
  const prev = new Date(Date.UTC(y, m - 2, 1));
  tryMonths.push({ yy: prev.getUTCFullYear(), mm: prev.getUTCMonth() + 1 });

  let best: { ymd: string; row: string[]; sourceUrl: string; fields?: string[]; closeIdx: number } | null = null;

  for (const mon of tryMonths) {
    const { url, json } = await fetchTwseStockDayMonth(stockNo, mon.yy, mon.mm);
    const rows: string[][] = Array.isArray(json?.data) ? json.data : [];
    const fields: string[] | undefined = Array.isArray(json?.fields) ? json.fields : undefined;

    let closeIdx = 6;
    if (fields?.length) {
      const i = fields.findIndex((f) => String(f).includes("收盤"));
      if (i >= 0) closeIdx = i;
    }

    for (const row of rows) {
      const rowYmd = parseTwseRowDateToISO(row?.[0]);
      if (!rowYmd) continue;

      if (rowYmd <= targetYmd) {
        if (!best || rowYmd > best.ymd) {
          best = { ymd: rowYmd, row, sourceUrl: url, fields, closeIdx };
        }
      }
    }
  }

  if (!best) return null;

  const row = best.row;
  const open = toNumberMaybe(row?.[3]);
  const high = toNumberMaybe(row?.[4]);
  const low = toNumberMaybe(row?.[5]);
  const close = toNumberMaybe(row?.[best.closeIdx]);
  const volume = toNumberMaybe(row?.[1]); // 成交股數（股）

  return { ymd: best.ymd, open, high, low, close, volume, sourceUrl: best.sourceUrl };
}

/** ===== web_search：文字抽取（Responses / ChatCompletions） ===== */

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

/** chat/completions 常常拿不到 annotations → 從文字裡把 [title](url) 抽出來補 citations */
function extractMarkdownLinks(text: string): UrlCitation[] {
  const out: UrlCitation[] = [];
  const re = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ title: m[1], url: m[2] });
  }
  const seen = new Set<string>();
  return out.filter((c) => {
    const key = `${c.title || ""}__${c.url || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    // ✅ 1) 台股/ETF：即時 & 收盤 & 成交量（不走 web_search）
    // =========================================================
    const dateInQuery = parseDateFromQuery(query, taipei.year);

    const volumeLike = looksLikeVolumeQuery(query);
    const priceLike = looksLikePriceQuery(query) || isRealtimeIntent(query) || isCloseIntent(query);
    const needsTaiwanMarketData = priceLike || volumeLike;

    const fromMap = inferFromNameMap(query);
    let finalCode = inferTaiwanCodeFromQuery(query) || fromMap?.code || null;

    let finalSymbol: string | null = null;

    if (needsTaiwanMarketData) {
      if (finalCode) {
        finalSymbol = `${finalCode}.TW`;
      } else {
        const s = await yahooSearchTaiwanSymbol(query);
        if (s?.symbol) {
          finalSymbol = s.symbol;
          finalCode = s.symbol.split(".")[0].toUpperCase();
        }
      }
    }

    const hasTaiwanInstrument = !!(needsTaiwanMarketData && finalCode && finalSymbol);

    if (hasTaiwanInstrument) {
      // 1a) 指定日期或明確收盤：走 TWSE STOCK_DAY（日資料，含成交量）
      if (dateInQuery?.explicit || isCloseIntent(query)) {
        let targetYmd = dateInQuery?.ymd ?? taipei.ymd;

        const afterCloseLikely = taipei.hour > 13 || (taipei.hour === 13 && taipei.minute >= 35);
        if (!dateInQuery?.explicit && isCloseIntent(query) && !afterCloseLikely) {
          targetYmd = addDaysToYMD(taipei.ymd, -1);
        }

        try {
          const twse = await getTwseCloseForDateOrPrev(finalCode!, targetYmd);

          if (twse?.close != null) {
            // ✅ 用前一交易日收盤算漲跌/漲跌幅（不顯示算式）
            let prevClose2: number | null = null;
            try {
              const prevTwse = await getTwseCloseForDateOrPrev(finalCode!, addDaysToYMD(twse.ymd, -1));
              prevClose2 = prevTwse?.close ?? null;
            } catch {
              prevClose2 = null;
            }

            const chg = calcChange(twse.close, prevClose2);
            const chgLine = chg ? `\n漲跌：${formatSigned(chg.chg, 2)}（${formatSigned(chg.pct, 2)}%）` : "";
            const volLine = twse.volume != null ? `\n成交量：${formatTaiwanVolume(twse.volume, "shares")}` : "";

            const sameDay = twse.ymd === targetYmd;
            const answer =
              `台北時間基準：${taipeiNow}\n` +
              `代號：${finalCode}（${finalSymbol}）${fromMap?.name ? `（${fromMap.name}）` : ""}\n` +
              (sameDay
                ? `✅ ${twse.ymd} 收盤價：${twse.close} TWD`
                : `⚠️ 找不到 ${targetYmd} 當日資料（可能休市/尚未更新/非交易日），最近可取得交易日：${twse.ymd}\n收盤價：${twse.close} TWD`) +
              (prevClose2 != null ? `\n前一交易日收盤：${prevClose2} TWD` : "") +
              chgLine +
              volLine +
              (twse.open != null || twse.high != null || twse.low != null
                ? `\n（開/高/低：${twse.open ?? "—"} / ${twse.high ?? "—"} / ${twse.low ?? "—"}）`
                : "");

            const citations: UrlCitation[] = [{ title: `TWSE STOCK_DAY ${finalCode}（日資料/收盤/成交量）`, url: twse.sourceUrl }];

            return Response.json({
              answer,
              citations,
              meta: {
                query,
                mode: "tw_close_stock_day",
                taipeiNow,
                stockNo: finalCode,
                symbol: finalSymbol,
                targetYmd,
                resolvedYmd: twse.ymd,
              },
            });
          }
        } catch {
          // STOCK_DAY 失敗 → Yahoo fallback
          try {
            const yq = await fetchYahooQuote(finalSymbol!);
            if (yq?.prevClose != null || yq?.price != null || yq?.volume != null) {
              const t = formatTaipeiTimeFromEpoch(yq.marketTimeEpochSec);
              const chg = calcChange(yq.price, yq.prevClose);
              const chgLine = chg ? `\n漲跌：${formatSigned(chg.chg, 2)}（${formatSigned(chg.pct, 2)}%）` : "";
              const volLine = yq.volume != null ? `\n成交量：${formatTaiwanVolume(yq.volume, "shares")}` : "";

              const answer =
                `台北時間基準：${taipeiNow}\n` +
                `代號：${finalCode}（${finalSymbol}）${yq.name ? `（${yq.name}）` : ""}\n` +
                `⚠️ 目前無法取得 TWSE 日資料（收盤/歷史），改用 Yahoo Quote 的資料作為備援（可能有延遲）。\n` +
                `價格：${yq.price ?? "—"}\n` +
                `前一交易日收盤：${yq.prevClose ?? "—"}` +
                chgLine +
                volLine +
                (t ? `\n資料時間（台北）：${t}` : "");

              const citations: UrlCitation[] = [{ title: `Yahoo Quote ${finalSymbol}`, url: yq.sourceUrl }];
              return Response.json({
                answer,
                citations,
                meta: { query, mode: "close_fallback_yahoo", taipeiNow, stockNo: finalCode, symbol: finalSymbol },
              });
            }
          } catch {
            // ignore
          }
        }
      } else {
        // 1b) 即時（或要當天成交量）：wantgoo（價）→ MIS（價/量/昨收）→ Yahoo（備援）
        const realtimePrefer =
          isRealtimeIntent(query) ||
          (looksLikePriceQuery(query) && !isCloseIntent(query) && !dateInQuery?.explicit) ||
          volumeLike;

        if (realtimePrefer) {
          // wantgoo 先嘗試抓價（可被擋，失敗就往下走 MIS）
          try {
            const wg = await fetchWantgooRealtimePrice(finalCode!, taipei.ymd);

            if (wg.picked?.price != null) {
              // ✅ 用 MIS 補昨收與成交量（算漲跌%）
              let mis2: Awaited<ReturnType<typeof fetchTwseMisRealtime>> | null = null;
              try {
                mis2 = await fetchTwseMisRealtime(finalCode!);
              } catch {
                mis2 = null;
              }

              let prevClose: number | null = mis2?.prevClose ?? null;

              // 成交量：MIS 是 lots；Yahoo 是 shares（備援）
              let volumeValue: number | null = mis2?.volumeLots ?? null;
              let volumeUnit: "lots" | "shares" = "lots";
              const misUrl: string | undefined = mis2?.sourceUrl;

              if (prevClose == null || volumeValue == null) {
                try {
                  const yq = await fetchYahooQuote(finalSymbol!);
                  if (prevClose == null) prevClose = yq?.prevClose ?? null;
                  if (volumeValue == null) {
                    volumeValue = yq?.volume ?? null;
                    volumeUnit = "shares";
                  }
                } catch {
                  // ignore
                }
              }

              const chg = calcChange(wg.picked.price, prevClose);
              const chgLine = chg ? `\n漲跌：${formatSigned(chg.chg, 2)}（${formatSigned(chg.pct, 2)}%）` : "";
              const volLine =
                volumeValue != null ? `\n成交量（累積）：${formatTaiwanVolume(volumeValue, volumeUnit)}` : "";

              const headerLine =
                volumeLike && !priceLike
                  ? `✅ 成交量（累積）：${formatTaiwanVolume(volumeValue, volumeUnit) ?? "—"}`
                  : `✅ 最新價格：${wg.picked.price} TWD`;

              const answer =
                `台北時間基準：${taipeiNow}\n` +
                `代號：${finalCode}（${finalSymbol}）${fromMap?.name ? `（${fromMap.name}）` : ""}\n` +
                headerLine +
                (!volumeLike || priceLike ? (prevClose != null ? `\n前一交易日收盤：${prevClose} TWD` : "") + chgLine : "") +
                volLine +
                (wg.picked.time ? `\n資料時間（wantgoo）：${wg.picked.time}` : "") +
                `\n（註：報價/成交量可能延遲；若需完全即時請以券商/交易所為準）`;

              const citations: UrlCitation[] = [{ title: `wantgoo realtime ${finalCode}`, url: wg.url }];
              if (misUrl) citations.push({ title: `TWSE MIS 即時報價 ${finalCode}`, url: misUrl });

              return Response.json({
                answer,
                citations,
                meta: { query, mode: "realtime_wantgoo_plus_mis", taipeiNow, stockNo: finalCode, symbol: finalSymbol },
              });
            }
          } catch {
            // wantgoo 失敗 → 繼續 MIS
          }
        }

        // ✅ TWSE MIS（官方）——現在會先 warmup cookie
        let mis: Awaited<ReturnType<typeof fetchTwseMisRealtime>> | null = null;
        try {
          mis = await fetchTwseMisRealtime(finalCode!);
        } catch {
          mis = null;
        }

        if (
          mis &&
          (mis.last != null ||
            mis.bestBid != null ||
            mis.bestAsk != null ||
            mis.prevClose != null ||
            mis.volumeLots != null)
        ) {
          const ref = pickIndicativePriceForChange({
            last: mis.last,
            bestBid: mis.bestBid,
            bestAsk: mis.bestAsk,
          });

          const bestLine =
            mis.bestBid != null || mis.bestAsk != null ? `\n最佳買/賣：${mis.bestBid ?? "—"} / ${mis.bestAsk ?? "—"}` : "";

          const chg = calcChange(ref?.price ?? null, mis.prevClose);
          const chgLine = chg ? `\n漲跌：${formatSigned(chg.chg, 2)}（${formatSigned(chg.pct, 2)}%）` : "";
          const volLine = mis.volumeLots != null ? `\n成交量（累積）：${formatTaiwanVolume(mis.volumeLots, "lots")}` : "";

          const mainLine =
            volumeLike && !priceLike
              ? `✅ 成交量（累積）：${formatTaiwanVolume(mis.volumeLots, "lots") ?? "—"}`
              : ref
              ? `✅ ${ref.label}（TWSE MIS）：${ref.price} TWD`
              : `⚠️ 目前無成交/無報價，暫無法推估漲跌`;

          const answer =
            `台北時間基準：${taipeiNow}\n` +
            `代號：${finalCode}（${finalSymbol}）${mis.name ? `（${mis.name}）` : ""}\n` +
            mainLine +
            bestLine +
            (mis.prevClose != null && (!volumeLike || priceLike) ? `\n前一交易日收盤：${mis.prevClose} TWD` : "") +
            (chgLine && (!volumeLike || priceLike) ? chgLine : "") +
            volLine +
            (mis.open != null || mis.high != null || mis.low != null
              ? `\n（開/高/低：${mis.open ?? "—"} / ${mis.high ?? "—"} / ${mis.low ?? "—"}）`
              : "") +
            (mis.rawDate && mis.rawTime ? `\n資料時間（交易所回傳）：${mis.rawDate} ${mis.rawTime}` : "");

          const citations: UrlCitation[] = [{ title: `TWSE MIS 即時報價 ${finalCode}`, url: mis.sourceUrl }];

          return Response.json({
            answer,
            citations,
            meta: { query, mode: "realtime_mis_primary", taipeiNow, stockNo: finalCode, symbol: finalSymbol },
          });
        }

        // Yahoo fallback（含成交量/漲跌%）
        try {
          const yq = await fetchYahooQuote(finalSymbol!);
          if (yq && (yq.price != null || yq.prevClose != null || yq.volume != null)) {
            const t = formatTaipeiTimeFromEpoch(yq.marketTimeEpochSec);
            const chg = calcChange(yq.price, yq.prevClose);
            const chgLine = chg ? `\n漲跌：${formatSigned(chg.chg, 2)}（${formatSigned(chg.pct, 2)}%）` : "";
            const volLine = yq.volume != null ? `\n成交量：${formatTaiwanVolume(yq.volume, "shares")}` : "";

            const mainLine =
              volumeLike && !priceLike ? `✅ 成交量：${formatTaiwanVolume(yq.volume, "shares") ?? "—"}` : `✅ 最新價格（Yahoo）：${yq.price ?? "—"}`;

            const answer =
              `台北時間基準：${taipeiNow}\n` +
              `代號：${finalCode}（${finalSymbol}）${yq.name ? `（${yq.name}）` : ""}\n` +
              mainLine +
              (!volumeLike || priceLike ? `\n前一交易日收盤：${yq.prevClose ?? "—"}` + chgLine : "") +
              volLine +
              (yq.open != null || yq.high != null || yq.low != null
                ? `\n（開/高/低：${yq.open ?? "—"} / ${yq.high ?? "—"} / ${yq.low ?? "—"}）`
                : "") +
              (t ? `\n資料時間（台北）：${t}` : "") +
              `\n（註：Yahoo 報價可能有延遲；若需完全即時請以券商/交易所為準）`;

            const citations: UrlCitation[] = [{ title: `Yahoo Quote ${finalSymbol}`, url: yq.sourceUrl }];
            return Response.json({
              answer,
              citations,
              meta: { query, mode: "realtime_yahoo_fallback", taipeiNow, stockNo: finalCode, symbol: finalSymbol },
            });
          }
        } catch {
          // ignore
        }

        // 最後：給最近收盤（含成交量）
        try {
          const twse = await getTwseCloseForDateOrPrev(finalCode!, taipei.ymd);
          if (twse?.close != null) {
            const volLine = twse.volume != null ? `\n成交量：${formatTaiwanVolume(twse.volume, "shares")}` : "";
            const answer =
              `台北時間基準：${taipeiNow}\n` +
              `代號：${finalCode}（${finalSymbol}）\n` +
              `⚠️ 目前無法取得即時報價，改提供最近可取得交易日收盤：\n` +
              `✅ ${twse.ymd} 收盤價：${twse.close} TWD` +
              volLine;

            const citations: UrlCitation[] = [{ title: `TWSE STOCK_DAY ${finalCode}（日資料/收盤/成交量）`, url: twse.sourceUrl }];
            return Response.json({
              answer,
              citations,
              meta: { query, mode: "realtime_failed_close_fallback", taipeiNow, stockNo: finalCode, symbol: finalSymbol },
            });
          }
        } catch {
          // ignore
        }
      }
    }

    // =========================================================
    // ✅ 2) 非股價/成交量類問題：才走 web_search / 搜尋模型
    // =========================================================
    const model = process.env.WEB_SEARCH_MODEL || "gpt-4o-mini";
    const isSearchPreviewModel = /-search-(preview|api)\b/i.test(model);

    const mergedDomains = (() => {
      const extra: string[] = [];
      if (isTechnicalAnalysisQuery(query)) extra.push("ifa.ai");
      return normalizeDomains([...(domains || []), ...extra]);
    })();

    const basePrompt = [
      "你是一個網路研究助理。請先使用網路搜尋，再用繁體中文回答。",
      "",
      "【時間基準】",
      `- 現在的台北時間（Asia/Taipei）是：${taipeiNow}`,
      "- 使用者提到「今天/昨日/最近/本週」等相對時間，一律以 Asia/Taipei 推算，不要用 UTC。",
      "",
      "【可靠性規則（務必遵守）】",
      "- 先把問題改寫成 2~4 個更可搜的查詢（必要時包含中/英文關鍵字），再整合答案。",
      "- 對於會變動或容易出錯的資訊（價格、日期、規則、名單、政策、數字統計）：至少用 2 個獨立來源交叉確認；若只有單一來源，請標註「可能有延遲/僅單一來源」。",
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
      mergedDomains.length ? `- 若可行，優先參考這些網域：${mergedDomains.join(", ")}` : "",
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
      let citations = extractUrlCitationsFromChat(respJson);
      if (!citations.length) citations = extractMarkdownLinks(answer).slice(0, 10);

      return Response.json({
        answer,
        citations: citations.slice(0, 10),
        meta: { query, recency_days, domains: mergedDomains, model, mode: "chat_completions", taipeiNow },
      });
    }

    const tools: any[] = [
      {
        type: "web_search",
        ...(mergedDomains.length ? { filters: { allowed_domains: mergedDomains } } : {}),
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
    let citations = extractUrlCitationsFromResponses(respJson);
    if (!citations.length) citations = extractMarkdownLinks(answer).slice(0, 10);

    return Response.json({
      answer,
      citations: citations.slice(0, 10),
      meta: { query, recency_days, domains: mergedDomains, model, mode: "responses", taipeiNow },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500 });
  }
}












