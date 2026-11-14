/**
 * MiCartera R31k0 — Yahoo Finance fundamentals bridge
 *
 * Deploy as a Cloudflare Worker. It performs the Yahoo cookie + crumb
 * handshake server-side, then requests quoteSummary in the same session.
 * It deliberately accepts only a ticker symbol, never an arbitrary URL.
 */

const ALLOWED_ORIGINS = new Set([
  "https://rauh1702.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
]);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(data, status, origin) {
  const headers = new Headers(corsHeaders(origin));
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  if (typeof headers.getAll === "function") {
    return headers.getAll("Set-Cookie");
  }
  const single = headers.get("Set-Cookie");
  return single ? [single] : [];
}

function cookieHeaderFrom(response) {
  const pairs = getSetCookies(response.headers)
    .map(value => value.split(";")[0].trim())
    .filter(value => /^[^=]+=/.test(value));
  return [...new Set(pairs)].join("; ");
}

function mergeCookies(existing, response) {
  const map = new Map();
  for (const part of (existing || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const part of cookieHeaderFrom(response).split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
  }
  return [...map.entries()].map(([k, v]) => k + "=" + v).join("; ");
}

async function fetchYahooSession() {
  const common = {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/json,*/*",
      "Accept-Language": "en-US,en;q=0.9"
    },
    redirect: "manual"
  };

  // Yahoo commonly responds 404 here while still issuing its session cookie.
  const seed = await fetch("https://fc.yahoo.com/", common);
  let cookies = cookieHeaderFrom(seed);
  if (!cookies) {
    throw new Error("Yahoo no ha entregado la cookie de sesión (paso 1). HTTP " + seed.status);
  }

  const crumbResponse = await fetch(
    "https://query1.finance.yahoo.com/v1/test/getcrumb",
    {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/plain,*/*",
        "Cookie": cookies
      },
      redirect: "manual",
      cf: { cacheTtl: 0, cacheEverything: false }
    }
  );
  cookies = mergeCookies(cookies, crumbResponse);
  const crumb = (await crumbResponse.text()).trim();

  if (!crumbResponse.ok || !crumb || crumb.length > 200 || /unauthorized|invalid|<html/i.test(crumb)) {
    throw new Error("Yahoo no ha emitido un crumb válido. HTTP " + crumbResponse.status);
  }
  return { cookies, crumb };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return json({ error: "Origen no permitido." }, 403, origin);
    }

    if (request.method !== "GET") {
      return json({ error: "Método no permitido." }, 405, origin);
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "MiCartera Yahoo fundamentals bridge" }, 200, origin);
    }

    if (url.pathname !== "/fundamentals") {
      return json({ error: "Ruta no encontrada. Usa /fundamentals?symbol=AAPL" }, 404, origin);
    }

    const symbol = (url.searchParams.get("symbol") || "").trim();
    if (!/^[A-Za-z0-9.^=_-]{1,32}$/.test(symbol)) {
      return json({ error: "Símbolo vacío o no válido." }, 400, origin);
    }

    try {
      const { cookies, crumb } = await fetchYahooSession();
      const yahooUrl = new URL(
        "https://query1.finance.yahoo.com/v10/finance/quoteSummary/" +
        encodeURIComponent(symbol)
      );
      yahooUrl.searchParams.set(
        "modules",
        "price,summaryDetail,defaultKeyStatistics,financialData"
      );
      yahooUrl.searchParams.set("formatted", "true");
      yahooUrl.searchParams.set("crumb", crumb);

      const upstream = await fetch(yahooUrl.toString(), {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json,text/plain,*/*",
          "Cookie": cookies,
          "Referer": "https://finance.yahoo.com/"
        },
        redirect: "manual",
        cf: { cacheTtl: 0, cacheEverything: false }
      });

      const body = await upstream.text();
      if (!upstream.ok) {
        return json({
          error: "Yahoo Finance respondió HTTP " + upstream.status + ".",
          stage: "quoteSummary"
        }, 502, origin);
      }

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json({ error: "Yahoo devolvió una respuesta que no es JSON.", stage: "quoteSummary" }, 502, origin);
      }

      const apiError = parsed?.quoteSummary?.error;
      if (apiError) {
        return json({
          error: apiError.description || apiError.code || "Yahoo rechazó la consulta.",
          stage: "quoteSummary"
        }, 502, origin);
      }

      return json(parsed, 200, origin);
    } catch (error) {
      return json({
        error: String(error?.message || error),
        stage: "session"
      }, 502, origin);
    }
  }
};
