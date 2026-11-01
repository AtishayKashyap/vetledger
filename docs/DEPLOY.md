# Deploying the live demo (free tier)

Everything here is free and needs no credit card. Total time is about 20 minutes. Use "Sign in with GitHub" for every service.

```
browser ──> Vercel (React app, apps/web)
              └─ /api/* rewrite (same origin: no CORS, SameSite=strict cookie works)
                   └──> Render (API + reminder worker, Docker)
                          ├──> Neon (PostgreSQL)
                          └──> Upstash (Redis: rate limits + job queue)
```

## 1. Neon: PostgreSQL

**With the Neon CLI** (the project is already linked: `neon.ts` + `.neon`):
```bash
npm i -g neon@latest
neon login
neon deploy          # provisions Postgres and writes DATABASE_URL + DATABASE_URL_UNPOOLED into .env
```
Then in `.env`, **delete the local `MIGRATION_DATABASE_URL` line** (it would override Neon's) and add `APP_DB_PASSWORD=$(openssl rand -hex 24)`.

**Or in the console:** create a project at https://neon.tech and copy the **pooled** and **direct** connection strings from *Dashboard → Connect* (toggle "Connection pooling").

Either way, you end up with three values:

| Variable | Value | Used for |
|---|---|---|
| `DATABASE_URL` | pooled string (host contains `-pooler`) | API traffic (PgBouncer, transaction mode) |
| `DATABASE_URL_UNPOOLED` | direct string | migrations (they take a session advisory lock) |
| `APP_DB_PASSWORD` | a long random string you generate | migrations create the `vetledger_app` role with it; the API connects as that role |

Why the extra role? Both Neon strings log in as the database **owner**, and owners bypass row-level security. The API refuses to start in production with such a role. With `APP_DB_PASSWORD` set, it connects to the pooled host as `vetledger_app`, so tenant isolation is enforced by Postgres. (`deploy/neon-setup.sql` creates the role manually if you prefer.)

## 2. Upstash: Redis
1. Sign up at https://upstash.com and choose **Create Database**: type *Redis*, same region as Neon, free plan.
2. Copy the **`rediss://…` URL** from the database page (Connect → "Redis URL"; it starts with `rediss://default:`).

## 3. Seed the demo database (GitHub Actions)
Render's free plan has no shell, so the database is seeded from GitHub Actions.
1. In this repo, go to **Settings → Secrets and variables → Actions → New repository secret**:
   - `DEMO_MIGRATION_DATABASE_URL`: your **direct** (`DATABASE_URL_UNPOOLED`) string.
   - `DEMO_APP_DB_PASSWORD`: your `APP_DB_PASSWORD`.
2. Go to the **Actions** tab, select **Reset demo database**, click **Run workflow**, and wait for the green tick.
3. Optional: to re-seed automatically every Monday (undoing whatever visitors changed), add a repository **variable** `DEMO_DB_ENABLED` = `true` under the same settings page, on the *Variables* tab.

## 4. Render: API
1. Sign up at https://render.com, then choose **New → Blueprint** and connect the `vetledger` repo. Render reads [`render.yaml`](../render.yaml).
2. Render asks for the values marked `sync: false`:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | Neon **pooled** string |
   | `DATABASE_URL_UNPOOLED` | Neon **direct** string |
   | `APP_DB_PASSWORD` | the **same** password you saved as the `DEMO_APP_DB_PASSWORD` GitHub secret (migrations created the role with it) |
   | `REDIS_URL` | the Upstash `rediss://` URL |
   | `REMINDER_WEBHOOK_URL` | leave empty (reminders are logged), or use a free https://webhook.site URL to watch them arrive |
   | `OTEL_EXPORTER_OTLP_ENDPOINT` / `_HEADERS` | leave empty |

3. Click **Apply**. The first build takes about 5 minutes. When it's live, open `https://<your-service>.onrender.com/healthz`; it should return `{"status":"ok"}`.
4. Note the service URL. If it isn't exactly `https://vetledger-api.onrender.com`, edit [`apps/web/vercel.json`](../apps/web/vercel.json) so the `/api/:path*` rewrite points to your URL, then commit.

## 5. Vercel: web app
1. Sign up at https://vercel.com and choose **Add New → Project**, then import the `vetledger` repo.
2. Set **Root Directory** to `apps/web`. The framework preset is detected as **Vite**; keep the default build settings.
3. Click **Deploy**. Your demo is at `https://<project>.vercel.app`.

## 6. Check it works
- Log in as `vet@sunrise.vet` with password `vetledger-demo`. The other demo accounts are listed on the login page.
- **The first request after about 15 idle minutes takes up to ~50 seconds**, because Render's free plan sleeps. After that it's fast. Open the site a minute before showing it to anyone.
- Log in as `vet@deccan.vet` in a private window: the second clinic sees completely different data. That's the row-level security working.

## Costs and limits (all free)
| Service | Free limit | Our usage |
|---|---|---|
| Neon | 0.5 GB storage, compute autosuspends | Demo data is a few MB |
| Upstash | Daily command quota | The worker polls every 60 s (`WORKER_DRAIN_DELAY_SEC`), and stops while Render sleeps |
| Render | 750 instance-hours/month, sleeps after 15 min idle | One service runs both the API and the worker |
| Vercel | Hobby plan | Static site plus the rewrite |
