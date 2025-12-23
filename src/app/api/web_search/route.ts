// 1223 add gpt-realtime + gpt-4o-search-preview + prompt
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

    const basePrompt = [
      "你是一個搜尋助理。請在需要時使用網路最新資訊，並用繁體中文回答。",
      "",
      "【時間基準】",
      `- 現在的台北時間（Asia/Taipei）是：${taipeiNow}`,
      "- 使用者提到「今天/昨日/最近/本週」等相對時間，一律以 Asia/Taipei 推算，不要用 UTC。",
      "",
      "輸出格式：",
      "- 【結論】1-2 句直接回答",
      "- 【重點】2~6 點條列（每點盡量可由來源支持）",
      "- 【來源】列出使用到的來源（title + url）",
      "- 若資訊不確定或來源矛盾，請明確說明不確定點與差異，避免瞎猜",
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
}



