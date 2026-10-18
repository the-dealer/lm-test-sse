# Test SSE · ¿Por qué no pierdes grasa?

Lead magnet de The Health Dealer. Página estática (`index.html`) + una función de Vercel (`api/lead.js`) que guarda el lead en Systeme.io y avisa a la setter por Telegram.

## 1. Systeme.io (antes de desplegar)

**API key:** icono de perfil → Ajustes → *Public API keys* → crear una nueva. Guárdala para el paso 3.

**Campos personalizados:** crea estos 6 campos de texto. El *slug* tiene que ser exactamente este:

| Slug | Para qué |
| --- | --- |
| `perfil` | Nombre del perfil |
| `perfil_frase` | Frase del perfil |
| `punto_partida` | Su primer eje en alerta ("el estrés") |
| `parrafo_porque` | Bloque "por qué no te funciona" |
| `cta_texto` | Texto del botón del email |
| `cta_url` | Enlace del botón del email |

Si algún slug no coincide, el contacto se guarda igual (nombre, email, teléfono y etiquetas) y te llega un aviso por Telegram. También puedes cambiar los slugs en `FIELD_MAP`, al principio de `api/lead.js`.

**Etiquetas:** no hace falta crearlas. La función crea las que falten.

**Automatizaciones:**
- Etiqueta `alerta_si` añadida → enviar email 1A (resultado con alerta).
- Etiqueta `alerta_no` añadida → enviar email 1B (resultado sin alerta).

## 2. Rellenar `CONFIG` en `index.html`

Al principio del `<script>`:

- `CALENDLY_URL` → tu enlace de reserva.
- `VSL_URL` → enlace de la VSL.
- `PRIVACY_URL` → revisa que la página existe y cubre datos de salud.

## 3. GitHub + Vercel

1. GitHub → *New repository* → `test-sse` (privado) → sube todos los archivos de esta carpeta, incluida la carpeta `api`.
2. Vercel → *Add New → Project* → importa `test-sse`. Framework: **Other**. Sin build command. *Deploy*.
3. Vercel → proyecto → *Settings → Environment Variables*:
   - `SYSTEME_API_KEY` = la key del paso 1
   - `TELEGRAM_BOT_TOKEN` = el token de tu bot de avisos
   - `TELEGRAM_CHAT_ID` = tu chat con el bot
4. *Deployments* → *Redeploy* para que coja las variables.

Opcional: dominio propio (p. ej. `test.thehealthdealer.es`) en *Settings → Domains*.

## 4. Prueba antes de publicar

Haz el test con tu email y teléfono, marcando "Sí, quiero verlo". Comprueba:

- Telegram: llega el aviso con el resumen.
- Systeme: el contacto tiene los 6 campos rellenos y las etiquetas (`test_sse`, `alerta_si`, `icp_…`, `perfil_resultado_…`).
- Email: llega el 1A con tus textos.
- Si algo falla: Vercel → *Logs* de la función `api/lead`.

## 5. Enlaces con origen

Para saber de qué vídeo viene cada lead:

- YouTube: `https://TU-DOMINIO/?utm_source=youtube&video=nombre-del-video`
- Instagram: `https://TU-DOMINIO/?utm_source=instagram`

Se guardan como etiqueta `origen_…` y aparecen en el aviso de Telegram.

## Meta Pixel

El test ya dispara `TestSSE_Start` al empezar y `Lead` al dejar los datos si encuentra el pixel. Pega el código base de "THD - SSE Pixel" dentro del `<head>` de `index.html`.
