# Puente de fundamentales de Yahoo Finance (Cloudflare Worker)

Este pequeño servicio permite que MiCartera consulte los fundamentales de Yahoo Finance
sin depender de proxies CORS públicos. El Worker realiza en una misma petición el
intercambio de cookie de sesión + crumb y la llamada a `quoteSummary`.

## 1. Desplegar

1. Entra en tu panel de Cloudflare y abre **Workers & Pages**.
2. Crea un Worker nuevo (por ejemplo, `micartera-yahoo-fundamentals`).
3. Abre **Edit code** y sustituye el contenido por el de
   `cloudflare-worker/yahoo-fundamentals.js`.
4. Guarda y despliega.
5. Copia el dominio asignado, por ejemplo `https://nombre.nombre-cuenta.workers.dev`.

No necesitas introducir claves API, contraseñas ni cookies de Yahoo.

## 2. Comprobar el servicio

Abre estas direcciones sustituyendo el dominio por el tuyo:

- `https://TU-WORKER.workers.dev/health` — debe devolver `{"ok":true,...}`.
- `https://TU-WORKER.workers.dev/fundamentals?symbol=AAPL` — debe devolver JSON con
  `quoteSummary.result`, o un error indicando la fase exacta que Yahoo ha rechazado.

Prueba después un ticker real de tu lista de Seguimiento.

## 3. Conectar MiCartera

Todavía no se ha cambiado la aplicación principal ni sus datos. Primero hay que comprobar
que el Worker devuelve fundamentales correctamente desde tu cuenta/región. Cuando me
pases la URL `workers.dev` y confirmemos la prueba, conectaré el panel existente a ese
servicio sin tocar operaciones, posiciones ni el almacenamiento local.

## Seguridad y límites

- El Worker solo acepta un símbolo bursátil validado; no es un proxy de URL arbitraria.
- CORS solo permite el origen de GitHub Pages de MiCartera y localhost para pruebas.
  CORS no es autenticación: el endpoint sigue siendo accesible mediante clientes que no
  envían cabecera Origin. Conviene activar una regla de rate limiting en Cloudflare si
  se publica para uso continuado.
- No publiques cookies, crumbs ni credenciales. El servicio los obtiene y usa en memoria
  durante cada petición; no los devuelve ni los almacena.
- Yahoo Finance no ofrece una API pública documentada y puede cambiar o bloquear este
  acceso en cualquier momento. El Worker no garantiza cobertura para todos los activos.
