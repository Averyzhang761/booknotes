const WEREAD_GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.4";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return response(null, 204);
  }

  const apiKey = Deno.env.get("WEREAD_API_KEY");
  if (!apiKey) {
    return response({ error: "WEREAD_API_KEY is not configured" }, 500);
  }

  const ownerEmail = normalizeEmail(Deno.env.get("OWNER_EMAIL"));
  const jwtEmail = normalizeEmail(getJwtEmail(request));
  if (ownerEmail && jwtEmail !== ownerEmail) {
    return response({ error: `Forbidden: signed in as ${jwtEmail || "unknown"}. Check OWNER_EMAIL secret.` }, 403);
  }

  try {
    const body = await request.json();
    const wereadBody = toWereadBody(body);
    const result = await fetch(WEREAD_GATEWAY, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(wereadBody),
    });

    const data = await result.json();
    if (data.upgrade_info) {
      return response({ error: data.upgrade_info.message, upgrade_info: data.upgrade_info }, 409);
    }
    return response(data, result.ok ? 200 : result.status);
  } catch (_error) {
    return response({ error: "Invalid WeRead gateway request" }, 400);
  }
});

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

function toWereadBody(body: Record<string, unknown>) {
  switch (body.action) {
    case "shelf":
      return { api_name: "/shelf/sync", skill_version: SKILL_VERSION };
    case "notebooks":
      return { api_name: "/user/notebooks", count: body.count || 100, skill_version: SKILL_VERSION };
    case "search":
      return {
        api_name: "/store/search",
        keyword: body.keyword,
        scope: 10,
        count: body.count || 8,
        skill_version: SKILL_VERSION,
      };
    case "bookmarks":
      return { api_name: "/book/bookmarklist", bookId: body.bookId, skill_version: SKILL_VERSION };
    case "reviews":
      return {
        api_name: "/review/list/mine",
        bookid: body.bookId,
        count: body.count || 100,
        synckey: body.synckey || 0,
        skill_version: SKILL_VERSION,
      };
    default:
      throw new Error("Unsupported action");
  }
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
