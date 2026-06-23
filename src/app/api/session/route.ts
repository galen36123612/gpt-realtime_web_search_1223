/*import { NextResponse } from "next/server";

export async function GET() {
  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-realtime-preview-2025-06-03",
          // model: "gpt-4o-mini-realtime-preview-2024-12-17",
        }),
      }
    );
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Error in /session:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}*/

// 0811 log Testing

/*import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

export async function GET() {
  try {
    // 建立/讀取匿名 userId（cookie）
    const jar = await cookies(); // ✅ Next 15 要 await
    let userId = jar.get("anonId")?.value;
    if (!userId) {
      userId = randomUUID();
      jar.set({
        name: "anonId",
        value: userId,
        httpOnly: false, // 若不需前端讀取可改 true
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
    }

    // 本次交談 sessionId（暫不落庫）
    const sessionId = randomUUID();

    // 向 OpenAI 取 Realtime ephemeral key（沿用你的邏輯）
    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview-2025-06-03",
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("OpenAI session error:", errText);
      return NextResponse.json({ error: "Failed to create realtime session" }, { status: 500 });
    }

    const data = await response.json();
    return NextResponse.json({ ...data, userId, sessionId });
  } catch (error) {
    console.error("Error in /session:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}*/

// 0811 V1

/*import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomUUID } from "crypto";

export const runtime = "nodejs"; // 用 Node.js runtime

export async function GET() {
  try {
    // 1) 讀/建匿名 userId
    const cookieStore = await cookies(); // ← 這裡用 await，避免型別是 Promise
    let userId = cookieStore.get("anonId")?.value;
    const needSetCookie = !userId;
    if (!userId) userId = randomUUID();

    // 2) 產生這次連線的 sessionId
    const sessionId = randomUUID();

    // 3) 向 OpenAI 建立 Realtime ephemeral session
    const resp = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview-2024-12-17",
        // 或換你之前那個 2025-06-03 預覽型號都行
      }),
    });

    const data = await resp.json();

    // 4) 回傳 ephemeral key + 我們自己的 userId / sessionId
    const res = NextResponse.json({
      ...data,
      userId,
      sessionId,
    });

    // 5) 只有在沒有 anonId 時才設 cookie（用 NextResponse 設）
    if (needSetCookie) {
      res.cookies.set({
        name: "anonId",
        value: userId,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365, // 1 年
      });
    }

    return res;
  } catch (error: any) {
    console.error("Error in /api/session:", error);
    return NextResponse.json(
      { error: "Internal Server Error", detail: String(error?.message || error) },
      { status: 500 }
    );
  }
}*/

//0623 testing

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomUUID, createHash } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hashSafetyIdentifier(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function GET() {
  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.error("Missing OPENAI_API_KEY");
      return NextResponse.json(
        {
          error: "Missing OPENAI_API_KEY",
          detail: "請確認 .env.local 裡面有設定 OPENAI_API_KEY，並重新啟動 npm run dev。",
        },
        { status: 500 }
      );
    }

    // 1) 讀 / 建匿名 userId
    const cookieStore = await cookies();
    let userId = cookieStore.get("anonId")?.value;

    const needSetCookie = !userId;

    if (!userId) {
      userId = randomUUID();
    }

    // 2) 產生這次連線的 sessionId
    const sessionId = randomUUID();

    // 3) 建立 Realtime client secret
    // 這版配合前端：
    // const EPHEMERAL_KEY = data?.client_secret?.value || data?.value;
    // fetch("https://api.openai.com/v1/realtime/calls", ...)
    const resp = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",

        // 建議後端設定，避免把原始 userId 傳給 OpenAI
        "OpenAI-Safety-Identifier": hashSafetyIdentifier(userId),
      },
      body: JSON.stringify({
        expires_after: {
          anchor: "created_at",
          seconds: 600,
        },
        session: {
          type: "realtime",
          model: "gpt-realtime-mini",

          // 預設輸出語音。之後 App.tsx 的 session.update 仍可覆蓋這些設定。
          output_modalities: ["audio"],

          audio: {
            input: {
              noise_reduction: {
                type: "near_field",
              },
              transcription: {
                model: "gpt-4o-mini-transcribe",
                language: "zh",
              },
              turn_detection: null,
            },
            output: {
              voice: "cedar",
            },
          },
        },
      }),
    });

    const rawText = await resp.text();

    let data: any = null;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { raw: rawText };
    }

    // 4) 重要：OpenAI 如果失敗，不要假裝成功
    if (!resp.ok) {
      console.error("OpenAI realtime client secret failed:", {
        status: resp.status,
        statusText: resp.statusText,
        data,
      });

      return NextResponse.json(
        {
          error: "OpenAI realtime client secret failed",
          status: resp.status,
          statusText: resp.statusText,
          detail: data,
        },
        { status: resp.status }
      );
    }

    const ephemeralKey = data?.value || data?.client_secret?.value;

    if (!ephemeralKey) {
      console.error("OpenAI response missing ephemeral key:", data);

      return NextResponse.json(
        {
          error: "OpenAI response missing ephemeral key",
          detail: data,
        },
        { status: 502 }
      );
    }

    // 5) 同時保留 value 和 client_secret.value，讓新舊前端都吃得到
    const res = NextResponse.json(
      {
        ...data,

        // 新版 client_secrets 主要是 data.value
        value: ephemeralKey,

        // 兼容你原本 App.tsx 的 data.client_secret.value 寫法
        client_secret: data?.client_secret || {
          value: ephemeralKey,
          expires_at: data?.expires_at,
        },

        userId,
        sessionId,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );

    // 6) 只有在沒有 anonId 時才設 cookie
    if (needSetCookie) {
      res.cookies.set({
        name: "anonId",
        value: userId,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
    }

    return res;
  } catch (error: any) {
    console.error("Error in /api/session:", error);

    return NextResponse.json(
      {
        error: "Internal Server Error",
        detail: String(error?.message || error),
      },
      { status: 500 }
    );
  }
}






