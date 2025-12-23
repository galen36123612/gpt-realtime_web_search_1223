// 1223 add gpt-realtime + gpt + web_search
export const runtime = "nodejs";

type WebSearchReq = {
  query: string;
  recency_days?: number;
  domains?: string[];
};

function extractOutputText(resp: any): string {
  // 1) 若 API 回傳有 output_text，直接用
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) return resp.output_text;

  // 2) 否則從 output 裡拼出文字
  let text = "";
  const output = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of output) {
    if (item?.type !== "message") continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      // 常見：{ type: "output_text", text: "..." } 或 { type: "text", text: "..." }
      if ((part?.type === "output_text" || part?.type === "text") && typeof part?.text === "string") {
        text += part.text;
      }
    }
  }
  return text.trim();
}

function extractUrlCitations(resp: any): Array<{ title?: string; url?: string }> {
  const citations: Array<{ title?: string; url?: string }> = [];
  const output = Array.isArray(resp?.output) ? resp.output : [];

  for (const item of output) {
    if (item?.type !== "message") continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const annotations = Array.isArray(part?.annotations) ? part.annotations : [];
      for (const ann of annotations) {
        if (ann?.type === "url_citation") {
          citations.push({ title: ann.title, url: ann.url });
        }
      }
    }
  }
  return citations;
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return Response.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
    }

    const body = (await req.json()) as WebSearchReq;

    const query = String(body?.query || "").trim();
    const recency_days = Number.isFinite(body?.recency_days) ? Number(body.recency_days) : 30;
    const domains = Array.isArray(body?.domains) ? body.domains.filter(Boolean).map(String) : [];

    if (!query) {
      return Response.json({ error: "Missing required field: query" }, { status: 400 });
    }

    // ✅ 把 recency_days / domains 真正用到（避免 ESLint unused）
    const domainHint = domains.length ? `\n- 優先只使用這些網域：${domains.join(", ")}` : "";
    const recencyHint = recency_days > 0 ? `\n- 優先參考最近 ${recency_days} 天內的資訊（若可取得）` : "";

    // 你可以用 env 覆蓋模型（避免你環境沒有 gpt-5 之類）
    const model = process.env.WEB_SEARCH_MODEL || "gpt-4o-mini";

    const input = `你是一個搜尋助理。請先做網路搜尋，再以繁體中文整理結果。

需求：
- 先列出 3-6 個重點（條列）
- 再列出來源（每筆包含：title + url）
- 若來源之間資訊互相矛盾，請指出並以較可靠來源為主

查詢：${query}${recencyHint}${domainHint}`;

    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search" }],
        input,
      }),
    });

    const respJson = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      return Response.json(
        {
          error: "OpenAI responses API error",
          status: upstream.status,
          statusText: upstream.statusText,
          details: respJson,
        },
        { status: 500 }
      );
    }

    const answer = extractOutputText(respJson);
    const citations = extractUrlCitations(respJson);

    return Response.json({
      answer,
      citations: citations.slice(0, 10),
      meta: {
        query,
        recency_days,
        domains,
        model,
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500 });
  }
}


