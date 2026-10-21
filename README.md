# EcoSync V2 · Campus Energy Intelligence

A full-stack JavaScript portfolio application with **React (JSX), Vite, Node.js, Express, PostgreSQL (optional), Recharts, Framer Motion, and a bilingual AI command interface with local fallback and optional Groq**.

## Run locally

Requirements: Node.js 20.19+ or 22.12+.

```bash
npm install
npm run install:all
cp backend/.env.example backend/.env
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:8000/api/health

## AI assistant

Groq is optional. Without a key—or if Groq rejects it—the built-in deterministic bilingual assistant still supports lecture lookup, cancellations with confirmation, and energy summaries. To enable generative AI, add a **new valid** Groq API key to `backend/.env`:

```text
GROQ_API_KEY=your_key
GROQ_MODEL=llama-3.3-70b-versatile
```

Groq free-tier access has limits and its model availability can change. The AI **proposes** operations; the user must explicitly confirm cancellation. Keep this key only on the backend, never in Vite environment variables.

## Persistence / deployment

- Local development: `backend/data.json` JSON persistence.
- Production: set `DATABASE_URL` to a PostgreSQL connection string (such as a hosted database) to persist changes across redeploys. This version stores the application state in a JSONB row; it is sufficient for a portfolio, but not a full relational schema.
- Deploy frontend via Vercel (`frontend` root, `npm run build`, output `dist`). Set **VITE_API_URL** only after adding cross-origin API configuration or rewrite `/api` to your backend with a Vercel rewrite rule. The included `frontend/vercel.json` handles that via `ECOSYNC_API_ORIGIN` on Vercel configuration if you replace its placeholder URL.
- Deploy backend via Render (`backend` root, `npm install`, `npm start`). Configure `FRONTEND_ORIGIN`, `GROQ_API_KEY`, `DATABASE_URL` and `PORT` (provided by Render). Without PostgreSQL, JSON-file state on ephemeral hosts may reset.
- No authentication: suitable for controlled portfolio review; for a public write-enabled deployment add per-visitor isolation, authentication, or server-side rate limits before exposing state-changing operations.

## Endpoints

GET `/api/health`, `/api/rooms`, `/api/lectures`, `/api/dashboard`, `/api/analytics`, `/api/activity`.

POST `/api/lectures`, `/api/lectures/:id/cancel`, `/api/ai`.

## Photos and licensing

University of Pennsylvania photographs from Wikimedia Commons; photo attribution and individual licenses must be respected. Source pages:
- https://commons.wikimedia.org/wiki/File:University_of_Pennsylvania_Campus_20240528.jpg (CC BY-SA 4.0)
- https://commons.wikimedia.org/wiki/File:Inside_of_Fisher_Fine_Arts_Library,_University_of_Pennsylvania.jpg (CC0)
- https://commons.wikimedia.org/wiki/File:Quadrangle_University_of_Pennsylvania.jpg
- https://commons.wikimedia.org/wiki/File:Furness_Lib_interior_looking_N_UPenn.JPG

**EcoSync is an independent portfolio project, not affiliated with or connected to the University of Pennsylvania.** Building labels and energy loads are illustrative, not university operational data. Energy savings are schedule-derived estimates, not metered outcomes.

## Security notes

Do not upload `.env` or paste API keys in chats. Rotate any previously exposed Groq API key. The built-in assistant never changes data by itself. AI requests have a per-process 15/minute/IP limit. Public writable APIs still require isolation or authentication before broad deployment.

## Branding
EcoSync original icon and logo are included in `frontend/public/`. The sidebar uses `ecosync-icon.png`, and the browser favicon uses `favicon.png`.
