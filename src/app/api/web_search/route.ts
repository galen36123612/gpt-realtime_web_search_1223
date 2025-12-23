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

    const input = `請先做網路搜尋，再用繁體中文給出「可核對」的答案。

規則（精簡版）：
- 只根據搜尋結果作答；關鍵事實需可對應來源；不確定就明講。
- 優先用 2 個獨立可靠來源交叉驗證；若無法驗證或來源矛盾，列出差異並說明採信理由（官方/第一方優先）。
- 若資料不可得（下架/付費/動態頁/不存在），說明原因，並給「最接近且可驗證」的替代資訊，清楚標註替代條件。

輸出：
1) 重點(3-6點，每點附[來源#])
2) 關鍵細節(必要時用表格/條列，每列附[來源#])
3) 來源清單(# title + url)

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


