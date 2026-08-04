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
              "你是读书时贴在用户旁边的“第二作者”。你的任务不是解释书，而是让用户多写一句真正有用的笔记。",
              "回复要像一个聪明、直接、有分寸的人在旁边追问，不要像论文、书评、哲学命题或课堂提问。",
              "先抓住原文里最具体的词，再把问题转向用户当下的一个真实判断、选择、冲突或逃避。",
              "只问一个主问题，可以带一个短追问。问题要能让用户马上回答“我最近哪件事是这样”。",
              "不要复述原文，不要说“您”，不要写“是否存在内在张力”，不要用“既然...那么...”这种学术句式。",
              "不要装成作者本人；最多说“沿着这本书的意思”。",
              "如果原文在讨论客观、偏见、事实、情绪、判断，就逼问用户最近哪个判断被偏见保护着，不要转到无关的意义、愿景或空虚。",
              "示例：原文说不要被“应该”遮住真实情况时，好回复是“那你最近哪个判断，其实不是从事实出发，而是从‘事情就该这样’出发？如果让一个反对你的人补充证据，你最怕他指出什么？”",
              "示例：原文说冷静和情绪化时，好回复是“你最近哪个判断，被你包装成了‘我很冷静’？如果把情绪也当成证据，而不是噪音，它会提醒你哪件事？”",
              "坏回复示例：讨论原则定义和客观之间是否存在内在张力。",
              "坏回复示例：连续问如何判断、如何确信、如何界定。",
              "输出 JSON，格式为 {\"response\":\"...\",\"basis\":[\"...\",\"...\"]}。",
              "response 用中文，1 段，45-90 字，口语但不油腻。",
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

    const modelResponse = String(parsed.response).trim();
    const finalResponse = isUsefulResponse(modelResponse) ? modelResponse : buildDirectQuestion(payload.quote);
    return response({
      response: finalResponse,
      basis: Array.isArray(parsed.basis) && isUsefulResponse(modelResponse)
        ? parsed.basis.slice(0, 3).map(String)
        : buildFallbackBasis(payload.quote, payload.book, payload.author),
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

function isUsefulResponse(text: string) {
  if (!text) return false;
  if (text.length > 140) return false;
  const badPatterns = [
    /沿着作者视角/,
    /既然/,
    /那么/,
    /是否/,
    /如何判断/,
    /如何确信/,
    /如何界定/,
    /内在的?张力/,
    /另一种形式/,
    /我们如何/,
    /您/,
  ];
  if (badPatterns.some((pattern) => pattern.test(text))) return false;
  const questionCount = (text.match(/[？?]/g) || []).length;
  return questionCount > 0 && questionCount <= 2;
}

function buildDirectQuestion(quote: string) {
  if (/应该|偏见|客观|真实|冷静|情绪化|事实|看法/.test(quote)) {
    return "那你最近哪个判断，其实不是从事实出发，而是从“事情就该这样”出发？如果让一个反对你的人补充证据，你最怕他指出什么？";
  }
  const term = extractTerms(quote)[0] || "这句话";
  return `先别急着同意「${term}」。它让你想到最近哪件具体的事？如果只写一个例子，你会写谁、哪天、哪个判断？`;
}

function buildFallbackBasis(quote: string, book: unknown, author: unknown) {
  return [
    `原文：${extractTerms(quote).slice(0, 3).join(" / ") || "当前段落"}`,
    book ? `当前书：${book}` : "",
    author ? `作者：${author}` : "",
  ].filter(Boolean);
}

function extractTerms(text: string) {
  const conceptTerms = ["应该", "偏见", "客观", "真实", "冷静", "情绪化", "事实", "看法", "原则", "判断", "结果"];
  const conceptHits = conceptTerms.filter((term) => text.includes(term));
  const fallbackTerms = text.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
  return [...new Set([...conceptHits, ...fallbackTerms])].slice(0, 6);
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
