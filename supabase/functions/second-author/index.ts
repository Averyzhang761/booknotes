const OPENROUTER_CHAT_COMPLETIONS = "https://openrouter.ai/api/v1/chat/completions";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return response(null, 204);
  }

  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    return response({ error: "OPENROUTER_API_KEY is not configured" }, 500);
  }

  const ownerEmail = normalizeEmail(Deno.env.get("OWNER_EMAIL"));
  const jwtEmail = normalizeEmail(getJwtEmail(request));
  if (ownerEmail && jwtEmail !== ownerEmail) {
    return response({ error: `Forbidden: signed in as ${jwtEmail || "unknown"}. Check OWNER_EMAIL secret.` }, 403);
  }

  try {
    const body = await request.json();
    const payload = toPromptPayload(body);
    const model = Deno.env.get("SECOND_AUTHOR_MODEL") || "google/gemini-2.5-flash";
    const result = await fetch(OPENROUTER_CHAT_COMPLETIONS, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://averyzhang761.github.io/booknotes/",
        "X-OpenRouter-Title": "Booknotes",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: [
              "你是一个读书场景里的“第二作者”生成器。",
              "先判断用户粘贴原文真正讨论的张力，再沿着作者视角提出尖锐但不装腔的苏格拉底式问题。",
              "不要总结原文，不要解释系统，不要说你缺少什么数据。",
              "你不能冒充作者本人，只能说“沿着作者视角”。",
              "问题必须贴着原文措辞和当前书，不要套用固定主题，不要硬套意义感、空虚、控制感等标签。",
              "如果原文在讨论客观、偏见、事实、情绪、判断，就围绕这些词追问，不要转到无关的意义、愿景或空虚。",
              "输出 JSON，格式为 {\"response\":\"...\",\"basis\":[\"...\",\"...\"]}。",
              "response 用中文，1-2 段，总长不超过 180 字。",
              "basis 最多 3 条，只写实际使用的依据，例如原文关键词、当前书/作者、微信读书划线、本地上下文。",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify(payload),
          },
        ],
        temperature: 0.7,
        max_tokens: 420,
        response_format: { type: "json_object" },
      }),
    });

    const data = await result.json();
    if (!result.ok) {
      return response({ error: data?.error?.message || "OpenRouter request failed" }, result.status);
    }

    const parsed = parseModelJson(extractChatContent(data));
    if (!parsed?.response) {
      return response({ error: "Model returned an invalid response" }, 502);
    }

    return response({
      response: String(parsed.response).trim(),
      basis: Array.isArray(parsed.basis) ? parsed.basis.slice(0, 3).map(String) : [],
    });
  } catch (_error) {
    return response({ error: "Invalid second author request" }, 400);
  }
});

function toPromptPayload(body: Record<string, unknown>) {
  return {
    quote: truncate(String(body.quote || ""), 1200),
    book: body.book || null,
    author: body.author || null,
    wereadNotes: Array.isArray(body.wereadNotes)
      ? body.wereadNotes.slice(0, 6).map((item) => truncate(String(item), 360))
      : [],
    localContext: Array.isArray(body.localContext)
      ? body.localContext.slice(0, 5).map((item) => truncate(String(item), 420))
      : [],
  };
}

function extractChatContent(data: Record<string, unknown>) {
  const choices = Array.isArray(data.choices) ? data.choices as Array<Record<string, unknown>> : [];
  const firstChoice = choices[0];
  const message = firstChoice?.message as Record<string, unknown> | undefined;
  return typeof message?.content === "string" ? message.content : "";
}

function parseModelJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

function getJwtEmail(request: Request) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  const payload = token?.split(".")[1];
  if (!payload) return null;

  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    return JSON.parse(decoded).email || null;
  } catch {
    return null;
  }
}

function normalizeEmail(email: string | null | undefined) {
  return email?.trim().toLowerCase() || null;
}

function truncate(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function response(body: unknown, status = 200) {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
    },
  });
}
