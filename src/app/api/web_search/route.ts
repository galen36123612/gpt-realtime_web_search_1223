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
    hour: Number(hh),
    minute: Number(mm),
    second: Number(ss),
  };
}

/** 支援：YYYY-MM-DD / YYYY/MM/DD / YYYY年MM月DD日 / MM/DD(用當年) */
function parseDateFromQuery(query: string, defaultYear: number): { ymd: string; explicit: boolean } | null {
  const q = query;

  let m = q.match(/(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*(?:日)?/);
  if (m) return { ymd: `${Number(m[1])}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`, explicit: true };

  m = q.match(/(?:^|\D)(\d{1,2})\s*\/\s*(\d{1,2})(?:\D|$)/);
  if (m) return { ymd: `${defaultYear}-${pad2(Number(m[1]))}-${pad2(Number(m[2]))}`, explicit: true };

  return null;
}

function toNumberMaybe(x: any): number | null {
  const s = String(x ?? "").replace(/,/g, "").trim();
  if (!s || s === "--" || s === "-" || s.toLowerCase() === "nan") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isPriceQuery(query: string): boolean {
  const q = query.toLowerCase();
  const kws = ["股價", "收盤", "收盤價", "開盤", "最高", "最低", "成交", "成交價", "報價", "price", "close", "quote", "open", "現價"];
  return kws.some((k) => q.includes(k));
}

function isRealtimeIntent(query: string): boolean {
  return /現在|即時|盤中|現價|最新|多少錢|幾塊|報價|last|quote|price/i.test(query);
}

function mentionsToday(query: string): boolean {
  return /今天|今日|本日/i.test(query);
}

/** 從 query 盡量推測台股代號（4位數） */
function inferTwseStockNo(query: string): string | null {
  const q = query;

  // 少量常見映射（可留著加速），但 B 方案不靠它也行
  const nameMap: Array<[RegExp, string]> = [
    [/台積電|tsmc/i, "2330"],
    [/鴻海/i, "2317"],
    [/聯發科/i, "2454"],
    [/中華電/i, "2412"],
    [/國泰金/i, "2882"],
    [/富邦金/i, "2881"],
  ];
  for (const [re, code] of nameMap) if (re.test(q)) return code;

  // 2330.TW / 2330tw / (2330)
  const twMatch = q.match(/(?:^|[^\d])(\d{4})\s*(?:\.?tw|\.?two)?(?:[^\d]|$)/i);
  if (twMatch) {
    const code = twMatch[1];
    if (!["2024", "2025", "2026"].includes(code)) return code;
  }

  // 其他四位數，但排除年份/日期語境
  const re = /\d{4}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const code = m[0];
    const idx = m.index;
    const left = q.slice(Math.max(0, idx - 2), idx);
    const right = q.slice(idx, Math.min(q.length, idx + 6));
    if (/[年\/\-]/.test(right) || /年/.test(left)) continue;
    if (code >= "1900" && code <= "2099") continue;
    return code;
  }

  return null;
}

/** =============== B 方案：Yahoo Search 解析公司名 → 台股代號/市場 =============== */

type YahooSearchQuote = {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchange?: string; // e.g., "TAI", "TWO", "NYQ"
  exchDisp?: string;
  quoteType?: string; // "EQUITY"
  typeDisp?: string; // may include ETF
};

function extractSearchKeyword(query: string): string {
  // 去掉常見股價問句詞，把剩下的當作公司名/代號搜尋詞
  const removed = query
    .replace(/\d{4}(\.TW|\.TWO)?/gi, " ")
    .replace(/(現在|即時|盤中|現價|最新|多少錢|幾塊|股價|收盤價?|開盤|最高|最低|成交價?|報價|price|close|quote|open|last)/gi, " ")
    .replace(/[()（）,，。！？!?]/g, " ")
    .trim();
  return removed.length >= 2 ? removed : query.trim();
}

function parseYahooSymbolToStockNo(symbol: string): { stockNo: string; marketHint: "tse" | "otc" } | null {
  const m = symbol.match(/^(\d{4})\.(TW|TWO)$/i);
  if (!m) return null;
  const stockNo = m[1];
  const suf = m[2].toUpperCase();
  return { stockNo, marketHint: suf === "TWO" ? "otc" : "tse" };
}

async function fetchYahooSearch(keyword: string): Promise<{ url: string; quotes: YahooSearchQuote[] } | null> {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(keyword)}&quotesCount=10&newsCount=0`;

  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json,text/plain,*/*" },
  });
  if (!res.ok) return null;

  const json: any = await res.json().catch(() => null);
  const quotes: YahooSearchQuote[] = Array.isArray(json?.quotes) ? json.quotes : [];
  return { url, quotes };
}

function scoreYahooCandidate(q: YahooSearchQuote, keyword: string, originalQuery: string): number {
  const symbol = String(q.symbol || "");
  if (!symbol) return -999;

  // 台股優先
  const isTw = /\.TW$|\.TWO$/i.test(symbol);
  if (!isTw) return -50;

  let score = 0;

  // 上市稍微比上櫃優先（可調）
  if (/\.TW$/i.test(symbol)) score += 2;
  if (/\.TWO$/i.test(symbol)) score += 1;

  // 只要是 equity 就加分
  if (String(q.quoteType || "").toUpperCase() === "EQUITY") score += 2;

  // 避免 ETF/基金優先於個股（可調）
  const typeDisp = String(q.typeDisp || "").toLowerCase();
  if (typeDisp.includes("etf")) score -= 2;

  const name = `${q.shortname || ""} ${q.longname || ""} ${q.exchDisp || ""} ${q.exchange || ""}`.toLowerCase();
  const kw = keyword.toLowerCase().trim();
  const oq = originalQuery.toLowerCase();

  if (kw && name.includes(kw)) score += 6;
  if (kw && oq.includes(kw)) score += 2;

  // 若 query 本身含「化」等更精確字，讓對應名稱更容易勝出（例如 台塑化）
  if (oq.includes("台塑化") && name.includes("台塑化")) score += 6;
  if (oq.includes("台塑") && name.includes("台塑")) score += 2;

  return score;
}

async function resolveTwStockFromYahoo(query: string): Promise<
  | {
      stockNo: string;
      marketHint: "tse" | "otc";
      yahooSymbol: string;
      sourceUrl: string;
      displayName?: string;
    }
  | null
> {
  const keyword = extractSearchKeyword(query);
  const res = await fetchYahooSearch(keyword);
  if (!res) return null;

  const candidates = res.quotes
    .filter((q) => q?.symbol && /\.TW$|\.TWO$/i.test(String(q.symbol)))
    .map((q) => ({ q, score: scoreYahooCandidate(q, keyword, query) }))
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;

  const best = candidates[0].q;
  const symbol = String(best.symbol || "");
  const parsed = parseYahooSymbolToStockNo(symbol);
  if (!parsed) return null;

  return {
    stockNo: parsed.stockNo,
    marketHint: parsed.marketHint,
    yahooSymbol: symbol,
    sourceUrl: res.url,
    displayName: best.shortname || best.longname || undefined,
  };
}

/** ==================== TWSE 日資料（收盤/歷史） ==================== */

function parseTwseRowDateToISO(s: string): string | null {
  const m = String(s).trim().match(/^(\d{2,4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  let y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900) y += 1911;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

async function fetchTwseStockDayMonth(stockNo: string, yyyy: number, mm: number) {
  const dateParam = `${yyyy}${pad2(mm)}01`;
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateParam}&stockNo=${encodeURIComponent(stockNo)}`;

  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json,text/plain,*/*" },
  });

  if (!res.ok) throw new Error(`TWSE fetch failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  return { url, json };
}

async function getTwseCloseForDateOrPrev(stockNo: string, targetYmd: string) {
  const [y, m] = targetYmd.split("-").map(Number);
  const tryMonths: Array<{ yy: number; mm: number }> = [{ yy: y, mm: m }];

  const prev = new Date(Date.UTC(y, m - 2, 1));
  tryMonths.push({ yy: prev.getUTCFullYear(), mm: prev.getUTCMonth() + 1 });

  let best:
    | { ymd: string; row: string[]; sourceUrl: string; closeIdx: number; fields?: string[] }
    | null = null;

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
        if (!best || rowYmd > best.ymd) best = { ymd: rowYmd, row, sourceUrl: url, closeIdx, fields };
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

/** ==================== MIS 即時報價 ==================== */

type MisMsg = {
  c?: string;
  n?: string;
  z?: string;
  y?: string;
  o?: string;
  h?: string;
  l?: string;
  v?: string;
  t?: string; // HH:MM:SS
  d?: string; // YYYYMMDD
};

async function fetchMisCookie(): Promise<string | null> {
  try {
    const init = await fetch("https://mis.twse.com.tw/stock/fibest.jsp?lang=zh_tw", {
      method: "GET",
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html,*/*" },
    });
    const setCookie = init.headers.get("set-cookie");
    if (!setCookie) return null;
    return setCookie.split(";")[0] || null;
  } catch {
    return null;
  }
}

function formatMisDatetime(d?: string, t?: string): string | null {
  if (!d || d.length !== 8) return null;
  const yyyy = d.slice(0, 4);
  const mm = d.slice(4, 6);
  const dd = d.slice(6, 8);
  const time = (t || "").trim();
  return time ? `${yyyy}-${mm}-${dd} ${time}` : `${yyyy}-${mm}-${dd}`;
}

function misToEpochMs(d?: string, t?: string): number | null {
  if (!d || d.length !== 8) return null;
  const yyyy = d.slice(0, 4);
  const mm = d.slice(4, 6);
  const dd = d.slice(6, 8);
  const time = (t || "00:00:00").trim();
  const iso = `${yyyy}-${mm}-${dd}T${time}+08:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

async function fetchMisQuote(stockNo: string): Promise<{ market: "tse" | "otc"; msg: MisMsg; url: string } | null> {
  const cookie = await fetchMisCookie();
  const now = Date.now();

  for (const market of ["tse", "otc"] as const) {
    const ex_ch = `${market}_${stockNo}.tw`;
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(ex_ch)}&json=1&delay=0&_=${now}`;

    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json,text/plain,*/*",
        Referer: "https://mis.twse.com.tw/stock/fibest.jsp?lang=zh_tw",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });

    if (!res.ok) continue;

    const json: any = await res.json().catch(() => null);
    const arr: MisMsg[] = Array.isArray(json?.msgArray) ? json.msgArray : [];
    if (!arr.length) continue;

    const msg = arr.find((x) => String(x?.c || "") === stockNo) || arr[0];
    if (!msg) continue;

    return { market, msg, url };
  }

  return null;
}

/** ==================== Yahoo Chart（JSON，不爬 HTML） ==================== */

type YahooQuote = {
  symbol: string;
  regularMarketPrice: number | null;
  regularMarketTime: number | null; // epoch seconds
  sourceUrl: string;
};

function epochToTaipei(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

async function fetchYahooQuoteForSymbol(symbol: string): Promise<YahooQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;

  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json,text/plain,*/*" },
  });

  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) return null;

  const price = toNumberMaybe(meta?.regularMarketPrice);
  const t = toNumberMaybe(meta?.regularMarketTime);
  return { symbol, regularMarketPrice: price, regularMarketTime: t != null ? Number(t) : null, sourceUrl: url };
}

async function fetchYahooQuote(stockNo: string, hintMarket?: "tse" | "otc"): Promise<YahooQuote | null> {
  const candidates: string[] =
    hintMarket === "otc" ? [`${stockNo}.TWO`, `${stockNo}.TW`] : [`${stockNo}.TW`, `${stockNo}.TWO`];

  for (const sym of candidates) {
    const q = await fetchYahooQuoteForSymbol(sym);
    if (q?.regularMarketPrice != null) return q;
  }
  return null;
}

/** ==================== OpenAI web search（非股價類） ==================== */

function extractOutputTextFromResponses(resp: any): string {
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) return resp.output_text.trim();
  let text = "";
  const output = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of output) {
    if (item?.type !== "message") continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if ((part?.type === "output_text" || part?.type === "text") && typeof part?.text === "string") text += part.text;
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
      for (const ann of annotations) if (ann?.type === "url_citation") citations.push({ title: ann.title, url: ann.url });
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
  for (const ann of arr) if (ann?.type === "url_citation") citations.push({ title: ann.title, url: ann.url });
  return citations;
}

/** ==================== Main ==================== */

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
    // ✅ 台股股價：B方案（沒代號 → Yahoo Search 解析 → MIS即時 / TWSE收盤）
    // =========================================================
    const wantsPrice = isPriceQuery(query) || isRealtimeIntent(query);

    let stockNo = inferTwseStockNo(query);
    let marketHint: "tse" | "otc" | undefined;
    let resolverCitation: UrlCitation | null = null;
    let resolvedSymbol: string | null = null;
    let resolvedName: string | null = null;

    if (!stockNo && wantsPrice) {
      const resolved = await resolveTwStockFromYahoo(query).catch(() => null);
      if (resolved?.stockNo) {
        stockNo = resolved.stockNo;
        marketHint = resolved.marketHint;
        resolvedSymbol = resolved.yahooSymbol;
        resolvedName = resolved.displayName || null;
        resolverCitation = { title: `Yahoo Finance Search（解析台股代號）${resolved.yahooSymbol}`, url: resolved.sourceUrl };
      }
    }

    if (stockNo && wantsPrice) {
      const parsed = parseDateFromQuery(query, Number(taipei.ymd.slice(0, 4)));
      const afterCloseLikely = taipei.hour > 14 || (taipei.hour === 14 && taipei.minute >= 5);

      const wantsCloseOrHistory =
        /收盤|收盤價|close|日k|歷史|昨天|上週|上個月/i.test(query) || !!parsed?.explicit || (afterCloseLikely && mentionsToday(query) && !isRealtimeIntent(query));

      // ---------- 收盤/歷史：TWSE ----------
      if (wantsCloseOrHistory) {
        const targetYmd = parsed?.ymd ?? taipei.ymd;
        try {
          const twse = await getTwseCloseForDateOrPrev(stockNo, targetYmd);
          if (twse?.close != null) {
            const sameDay = twse.ymd === targetYmd;

            // 若今天日資料未更新：補 MIS/Yahoo 即時（可讀性更好）
            if (!sameDay && targetYmd === taipei.ymd && mentionsToday(query)) {
              const mis = await fetchMisQuote(stockNo).catch(() => null);
              const yahoo = await fetchYahooQuote(stockNo, marketHint ?? mis?.market).catch(() => null);

              const misLast = mis?.msg ? toNumberMaybe(mis.msg.z) : null;
              const misTs = mis?.msg ? formatMisDatetime(mis.msg.d, mis.msg.t) : null;
              const yPrice = yahoo?.regularMarketPrice ?? null;
              const yTs = yahoo?.regularMarketTime != null ? epochToTaipei(yahoo.regularMarketTime) : null;

              const answer =
                `台北時間基準：${taipeiNow}\n\n` +
                `查詢：${stockNo}.TW${resolvedSymbol ? `（由 ${resolvedSymbol}${resolvedName ? ` / ${resolvedName}` : ""} 解析）` : ""}\n` +
                `⚠️ TWSE（日資料）尚未提供 ${targetYmd} 的官方收盤資料（可能尚未更新/非交易日）。\n` +
                `TWSE 最新可得交易日：${twse.ymd} 官方收盤價：${twse.close} TWD\n` +
                `（開/高/低：${twse.open ?? "—"} / ${twse.high ?? "—"} / ${twse.low ?? "—"}）\n` +
                (twse.volume != null ? `成交股數：${twse.volume}\n` : "") +
                (misLast != null ? `\n補充：MIS 最新成交價：${misLast} TWD（更新：${misTs ?? "—"}）` : "") +
                (yPrice != null ? `\n補充：Yahoo 最新價格：${yPrice} TWD（更新：${yTs ?? "—"}）` : "");

              const citations: UrlCitation[] = [{ title: `TWSE STOCK_DAY ${stockNo}（收盤/歷史）`, url: twse.sourceUrl }];
              if (resolverCitation) citations.push(resolverCitation);
              if (mis?.url && misLast != null) citations.push({ title: `TWSE MIS 即時報價 ${stockNo}`, url: mis.url });
              if (yahoo?.sourceUrl && yPrice != null) citations.push({ title: `Yahoo Finance Chart ${yahoo.symbol}`, url: yahoo.sourceUrl });

              return Response.json({
                answer,
                citations: citations.slice(0, 10),
                meta: { query, mode: "twse_stock_day_not_ready_today", stockNo, targetYmd, resolvedYmd: twse.ymd, taipeiNow, resolvedSymbol, resolvedName },
              });
            }

            const answer =
              `台北時間基準：${taipeiNow}\n\n` +
              `查詢：${stockNo}.TW${resolvedSymbol ? `（由 ${resolvedSymbol}${resolvedName ? ` / ${resolvedName}` : ""} 解析）` : ""}\n` +
              (sameDay
                ? `✅ ${twse.ymd} 官方收盤價（TWSE 日資料）：${twse.close} TWD`
                : `✅ ${twse.ymd} 官方收盤價（TWSE 日資料）：${twse.close} TWD（找不到 ${targetYmd}，已取最近可得交易日）`) +
              `\n（開/高/低：${twse.open ?? "—"} / ${twse.high ?? "—"} / ${twse.low ?? "—"}）` +
              (twse.volume != null ? `\n成交股數：${twse.volume}` : "");

            const citations: UrlCitation[] = [{ title: `TWSE STOCK_DAY ${stockNo}（收盤/歷史）`, url: twse.sourceUrl }];
            if (resolverCitation) citations.push(resolverCitation);

            return Response.json({
              answer,
              citations: citations.slice(0, 10),
              meta: { query, mode: "twse_stock_day", stockNo, taipeiNow, resolvedSymbol, resolvedName },
            });
          }
        } catch {
          // fallback to realtime
        }
      }

      // ---------- 即時：MIS → stale/空值 → Yahoo chart ----------
      const mis = await fetchMisQuote(stockNo).catch(() => null);
      const misMsg = mis?.msg;
      const misLast = misMsg ? toNumberMaybe(misMsg.z) : null;
      const misEpoch = misMsg ? misToEpochMs(misMsg.d, misMsg.t) : null;

      const STALE_MS = 5 * 60 * 1000;
      const nowMs = Date.now();
      const misIsStale = misEpoch != null ? nowMs - misEpoch > STALE_MS : true;

      if (misLast == null || misIsStale) {
        const yahoo = await fetchYahooQuote(stockNo, marketHint ?? mis?.market).catch(() => null);
        if (yahoo?.regularMarketPrice != null) {
          const yTs = yahoo.regularMarketTime != null ? epochToTaipei(yahoo.regularMarketTime) : null;

          const answer =
            `台北時間基準：${taipeiNow}\n\n` +
            `查詢：${stockNo}.TW${resolvedSymbol ? `（由 ${resolvedSymbol}${resolvedName ? ` / ${resolvedName}` : ""} 解析）` : ""}\n` +
            `即時價格：${yahoo.regularMarketPrice} TWD\n` +
            (yTs ? `更新時間：${yTs}（來源：Yahoo Finance）\n` : `來源：Yahoo Finance\n`) +
            (misLast != null ? `\n（補充：MIS 回傳 ${misLast}，但時間戳較舊，已改用 Yahoo。）` : `\n（補充：MIS 暫無有效即時成交價，已改用 Yahoo。）`);

          const citations: UrlCitation[] = [{ title: `Yahoo Finance Chart ${yahoo.symbol}`, url: yahoo.sourceUrl }];
          if (resolverCitation) citations.push(resolverCitation);
          if (mis?.url) citations.push({ title: `TWSE MIS 即時報價 ${stockNo}`, url: mis.url });

          return Response.json({
            answer,
            citations: citations.slice(0, 10),
            meta: { query, mode: "realtime_yahoo_fallback", stockNo, taipeiNow, resolvedSymbol, resolvedName, yahoo_symbol: yahoo.symbol, yahoo_time: yTs },
          });
        }
      }

      if (misMsg) {
        const yclose = toNumberMaybe(misMsg.y);
        const open = toNumberMaybe(misMsg.o);
        const high = toNumberMaybe(misMsg.h);
        const low = toNumberMaybe(misMsg.l);
        const vol = toNumberMaybe(misMsg.v);
        const ts = formatMisDatetime(misMsg.d, misMsg.t);

        const answer =
          `台北時間基準：${taipeiNow}\n\n` +
          `查詢：${stockNo}.TW${resolvedSymbol ? `（由 ${resolvedSymbol}${resolvedName ? ` / ${resolvedName}` : ""} 解析）` : ""}\n` +
          `即時價格：${misLast ?? yclose ?? "—"} TWD\n` +
          (ts ? `更新時間：${ts}（來源：TWSE MIS）\n` : "") +
          `昨收：${yclose ?? "—"}｜開：${open ?? "—"}｜高：${high ?? "—"}｜低：${low ?? "—"}｜量：${vol ?? "—"}`;

        const citations: UrlCitation[] = [{ title: `TWSE MIS 即時報價 ${stockNo}`, url: mis.url }];
        if (resolverCitation) citations.push(resolverCitation);

        return Response.json({
          answer,
          citations: citations.slice(0, 10),
          meta: { query, mode: "realtime_mis", stockNo, taipeiNow, resolvedSymbol, resolvedName, mis_datetime: ts, market: mis.market },
        });
      }

      // 最後 fallback：TWSE 日資料
      try {
        const twse = await getTwseCloseForDateOrPrev(stockNo, taipei.ymd);
        if (twse?.close != null) {
          const answer =
            `台北時間基準：${taipeiNow}\n\n` +
            `查詢：${stockNo}.TW${resolvedSymbol ? `（由 ${resolvedSymbol}${resolvedName ? ` / ${resolvedName}` : ""} 解析）` : ""}\n` +
            `⚠️ 即時報價來源暫不可用，先提供 TWSE 日資料（官方收盤/歷史）。\n` +
            `最新可得交易日：${twse.ymd} 官方收盤價：${twse.close} TWD`;

          const citations: UrlCitation[] = [{ title: `TWSE STOCK_DAY ${stockNo}（收盤/歷史）`, url: twse.sourceUrl }];
          if (resolverCitation) citations.push(resolverCitation);

          return Response.json({
            answer,
            citations: citations.slice(0, 10),
            meta: { query, mode: "fallback_stock_day", stockNo, taipeiNow, resolvedSymbol, resolvedName },
          });
        }
      } catch {
        // continue to web search
      }
    }

    // =========================================================
    // ✅ 其他 query：走 OpenAI web_search
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
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: basePrompt }] }),
      });

      const respJson = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        return Response.json(
          { error: "OpenAI chat/completions error", status: upstream.status, statusText: upstream.statusText, details: respJson },
          { status: 500 }
        );
      }

      return Response.json({
        answer: extractOutputTextFromChat(respJson),
        citations: extractUrlCitationsFromChat(respJson).slice(0, 10),
        meta: { query, recency_days, domains, model, mode: "chat_completions", taipeiNow },
      });
    }

    const tools: any[] = [{ type: "web_search", ...(domains.length ? { filters: { allowed_domains: domains } } : {}) }];

    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, tools, tool_choice: "auto", input: basePrompt }),
    });

    const respJson = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return Response.json(
        { error: "OpenAI responses error", status: upstream.status, statusText: upstream.statusText, details: respJson },
        { status: 500 }
      );
    }

    return Response.json({
      answer: extractOutputTextFromResponses(respJson),
      citations: extractUrlCitationsFromResponses(respJson).slice(0, 10),
      meta: { query, recency_days, domains, model, mode: "responses", taipeiNow },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500 });
  }
}







