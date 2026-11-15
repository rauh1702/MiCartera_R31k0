# Worker de MiCartera R31k0: fundamentales y noticias programadas

## Activación de noticias (necesaria una sola vez)
1. En Cloudflare abre Workers & Pages y selecciona el Worker que ya usa la app.
2. Sustituye su código por `yahoo-fundamentals.js` y despliega.
3. En Settings → Bindings, crea un binding KV con nombre de variable `NEWS_KV` y un namespace nuevo (por ejemplo `micartera-news`).
4. En Settings → Triggers → Cron Triggers, añade `0 * * * *` para ejecutar cada hora.
5. Comprueba `/health`; debe responder `{"ok":true,...}`.

La app registra automáticamente los tickers de cartera y seguimiento al abrirse. Cloudflare guarda esa lista en KV y el Cron actualiza noticias cada hora aunque la app esté cerrada. «Actualizar ahora» fuerza una consulta manual.

## Rutas
- GET `/health`
- GET `/fundamentals?symbol=AAPL` (se conserva el servicio anterior)
- POST `/symbols` con JSON `{"symbols":["AAPL","ONDS"]}`
- POST `/refresh` para forzar consulta inmediata
- GET `/news?symbols=AAPL,ONDS`

## Limitaciones
Las noticias se obtienen del buscador de Yahoo Finance; su cobertura y disponibilidad pueden cambiar. El resumen es extractivo, basado en el texto breve suministrado por Yahoo, no un resumen generado tras leer el artículo completo. La clasificación positiva/negativa/neutral es heurística por palabras clave y orientativa, no una recomendación de inversión. Se conservan hasta 250 noticias, deduplicadas por URL.

Los endpoints de noticias no requieren credenciales: solo se envían símbolos, nunca cantidades, posiciones ni importes. CORS limita el uso desde navegadores a GitHub Pages y localhost, pero no bloquea clientes directos. Configura rate limiting en Cloudflare si fuera necesario.
