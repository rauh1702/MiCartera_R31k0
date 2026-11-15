/**
 * MiCartera R31k0 — Yahoo Finance fundamentals bridge + asset news
 *
 * Conserva el handshake original de Yahoo (cookie + crumb) para /fundamentals.
 * Añade noticias, almacenamiento KV y actualización programada mediante Cron.
 * Solo acepta símbolos bursátiles; nunca URLs arbitrarias.
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

/* Handshake original de Yahoo: se mantiene para no alterar fundamentales. */
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

/* Clasificación automática orientativa; no constituye recomendación financiera. */
function classifyNewsImpact(text) {
  const value = String(text || "").toLowerCase();
  const positive = [
    "beats estimates", "record revenue", "raises guidance", "contract win",
    "awarded contract", "approval", "partnership", "supera previsiones",
    "récord de ingresos", "eleva previsiones", "contrato", "aprobación", "alianza"
  ];
  const negative = [
    "misses estimates", "cuts guidance", "downgrade", "dilution",
    "share offering", "investigation", "lawsuit", "delay", "loss widens",
    "incumple previsiones", "recorta previsiones", "ampliación de capital",
    "investigación", "demanda", "retraso", "pérdidas"
  ];
  const positives = positive.filter(word => value.includes(word)).length;
  const negatives = negative.filter(word => value.includes(word)).length;
  return positives > negatives ? "positive" : negatives > positives ? "negative" : "neutral";
}

const NEWS_ALIASES = {
  AAPL: ["apple"],
  ONDS: ["ondas", "ondas holdings"],
  OTLK: ["outlook therapeutics"],
  "SIVE.ST": ["sivers", "sivers semiconductors"],
  "IDR.MC": ["indra", "indra sistemas"],
  ELTX: ["elicio", "elicio therapeutics"]
};

function getNewsRelevance(item, symbol) {
  const title = String(item.title || "").toLowerCase();
  const body = [item.summary, item.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const aliases = NEWS_ALIASES[symbol] || [];
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\\\$&");
  const tickerPattern = new RegExp("(^|[^A-Z0-9])" + escaped + "([^A-Z0-9]|$)", "i");

  const matches = value =>
    aliases.some(alias => value.includes(alias.toLowerCase())) ||
    tickerPattern.test(value);

  if (!matches(title) && !matches(body)) return null;

  const OTHER_COMPANY_NAMES = [
    "unusual machines",
    "red cat",
    "aerovironment",
    "kratos defense",
    "draganfly",
    "teledyne",
    "lockheed martin",
    "northrop grumman",
    "elbit systems",
    "parrot"
  ];

  const aliasInTitle = aliases.find(alias =>
    title.includes(alias.toLowerCase())
  );

  const tickerInTitle = tickerPattern.test(title);

  const position = aliasInTitle
    ? title.indexOf(aliasInTitle.toLowerCase())
    : (tickerInTitle ? title.search(tickerPattern) : -1);

  const prefix = position >= 0
    ? title.slice(0, position).trim()
    : title;

  const explicitComparison =
    /\b(vs\.?|versus|compared with)\b/i.test(title);

  const otherCompanyMention = OTHER_COMPANY_NAMES.some(name =>
    title.includes(name)
  );

  const direct = position >= 0 &&
    prefix.length < 24 &&
    !explicitComparison &&
    !otherCompanyMention;

  return direct ? "direct" : "related";
}

async function fetchYahooNews(symbol) {
  const yahooUrl = new URL("https://query1.finance.yahoo.com/v1/finance/search");
  yahooUrl.searchParams.set("q", symbol);
  yahooUrl.searchParams.set("quotesCount", "0");
  yahooUrl.searchParams.set("newsCount", "20");
  yahooUrl.searchParams.set("listsCount", "0");

  const response = await fetch(yahooUrl.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json,text/plain,*/*"
    },
    cf: { cacheTtl: 0, cacheEverything: false }
  });

  if (!response.ok) {
    throw new Error("Yahoo news respondió HTTP " + response.status);
  }

  const payload = await response.json();
  return (payload.news || [])
    .map(item => {
      const relevance = getNewsRelevance(item, symbol);
      if (!relevance) return null;

      const title = item.title || "Noticia sin titular";
      const suppliedSummary = item.summary || item.description || "";
      const summary = String(suppliedSummary).slice(0, 650);
      const link = item.link || item.canonicalUrl?.url || "";
      const timestamp = Number(item.providerPublishTime) || 0;
      return {
        id: item.uuid || link,
        title,
        summary,
        summaryAvailable: Boolean(summary),
        relevance,
        url: link,
        publisher: item.publisher || "Yahoo Finance",
        publishedAt: timestamp ? new Date(timestamp * 1000).toISOString() : null,
        symbols: [symbol],
        impact: classifyNewsImpact(title + " " + summary)
      };
    })
    .filter(item => item && item.url);
}

function normalizeSymbols(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map(item => String(item || "").trim().toUpperCase())
      .filter(symbol => /^[A-Z0-9.^=_-]{1,32}$/.test(symbol))
  )].slice(0, 40);
}

async function getRegisteredSymbols(env) {
  if (!env.NEWS_KV) throw new Error("Falta configurar el binding NEWS_KV.");
  const stored = await env.NEWS_KV.get("news:symbols");
  if (!stored) return [];
  try {
    return normalizeSymbols(JSON.parse(stored));
  } catch {
    return [];
  }
}

async function refreshNews(env, symbols) {
  if (!env.NEWS_KV) throw new Error("Falta configurar el binding NEWS_KV.");

  const merged = new Map();
  for (const symbol of normalizeSymbols(symbols)) {
    try {
      const news = await fetchYahooNews(symbol);
      for (const item of news) {
        const existing = merged.get(item.url);
        if (existing) {
          existing.symbols.push(symbol);
        } else {
          merged.set(item.url, item);
        }
      }
    } catch (error) {
      // Un ticker sin respuesta no debe impedir consultar los demás.
    }
  }

  const items = [...merged.values()]
    .map(item => ({ ...item, symbols: [...new Set(item.symbols)] }))
    .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""))
    .slice(0, 250);

  const result = {
    items,
    updatedAt: new Date().toISOString()
  };

  await env.NEWS_KV.put("news:latest", JSON.stringify(result));
  return result;
}

export default {
  async fetch(request, env) {
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

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "MiCartera Yahoo fundamentals + news" }, 200, origin);
    }

    /*
     * RUTA ORIGINAL DE FUNDAMENTALES.
     * Se conserva el flujo cookie + crumb y la validación de respuesta JSON.
     */
    if (url.pathname === "/fundamentals" && request.method === "GET") {
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
          "price,summaryDetail,defaultKeyStatistics,financialData,assetProfile"
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
          return json({
            error: "Yahoo devolvió una respuesta que no es JSON.",
            stage: "quoteSummary"
          }, 502, origin);
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

    /* Registro de tickers que la aplicación tiene en cartera o seguimiento. */
    if (url.pathname === "/symbols" && request.method === "POST") {
      if (!env?.NEWS_KV) {
        return json({ error: "Falta configurar el binding NEWS_KV." }, 503, origin);
      }
      const body = await request.json().catch(() => ({}));
      const symbols = normalizeSymbols(body.symbols);
      await env.NEWS_KV.put("news:symbols", JSON.stringify(symbols));
      return json({ ok: true, count: symbols.length }, 200, origin);
    }

    /* Actualización inmediata solicitada desde el botón de la aplicación. */
    if (url.pathname === "/refresh" && request.method === "POST") {
      if (!env?.NEWS_KV) {
        return json({ error: "Falta configurar el binding NEWS_KV." }, 503, origin);
      }
      const body = await request.json().catch(() => ({}));
      const symbols = normalizeSymbols(
        Array.isArray(body.symbols) && body.symbols.length
          ? body.symbols
          : await getRegisteredSymbols(env)
      );
      if (!symbols.length) {
        return json({ error: "No hay símbolos registrados para actualizar." }, 400, origin);
      }
      try {
        const result = await refreshNews(env, symbols);
        return json({
          ok: true,
          count: result.items.length,
          updatedAt: result.updatedAt
        }, 200, origin);
      } catch (error) {
        return json({ error: String(error?.message || error) }, 502, origin);
      }
    }

    /* Lectura del último conjunto de noticias guardado. */
    if (url.pathname === "/news" && request.method === "GET") {
      if (!env?.NEWS_KV) {
        return json({ error: "Falta configurar el binding NEWS_KV." }, 503, origin);
      }
      const stored = await env.NEWS_KV.get("news:latest");
      let result = { items: [], updatedAt: null };
      if (stored) {
        try {
          result = JSON.parse(stored);
        } catch {
          return json({ error: "El almacenamiento de noticias contiene datos no válidos." }, 500, origin);
        }
      }
      const wanted = (url.searchParams.get("symbols") || "")
        .split(",")
        .map(symbol => symbol.trim().toUpperCase())
        .filter(Boolean);
      const items = wanted.length
        ? (result.items || []).filter(item =>
            (item.symbols || []).some(symbol => wanted.includes(String(symbol).toUpperCase()))
          )
        : (result.items || []);
      return json({ ...result, items }, 200, origin);
    }

    return json({
      error: "Ruta no encontrada. Usa /fundamentals?symbol=AAPL, /symbols, /refresh o /news."
    }, 404, origin);
  },

  /* Cloudflare Cron Trigger: ejecuta la recogida aunque la app esté cerrada. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const symbols = await getRegisteredSymbols(env);
      if (symbols.length) {
        await refreshNews(env, symbols);
      }
    })());
  }
};
