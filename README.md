# Fella Ride

The frontend is hosted on Vercel, the API can run on Render's free web-service plan, and shared community data is stored in Supabase. Render's free service can sleep while idle, so its first request after a quiet period may take longer. Supabase's free plan has usage limits and may pause inactive projects.

Community profiles and rides are public to anyone who can reach the API. Live GPS location remains local to the visitor's browser. Never put the Supabase service-role key in frontend code or commit it to this repository.

## Supabase database

1. Create a Supabase project at <https://supabase.com/dashboard>.
2. In the project's **SQL Editor**, run the contents of [`backend/schema.sql`](backend/schema.sql).
3. From **Project Settings → API**, copy the Project URL and the `service_role` key. Keep the key private.

## Render API

1. Create a **Web Service** at <https://dashboard.render.com/> and connect `niriksham-spec/fellaa`.
2. Set **Root Directory** to `backend`, **Build Command** to `npm install`, and **Start Command** to `npm start`.
3. Choose the **Free** instance plan. Do not add a disk; Supabase stores persistent state.
4. Set these environment variables:
   - `SUPABASE_URL`: the Supabase Project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: the private `service_role` key
   - `ALLOWED_ORIGIN`: `https://fellaa.vercel.app`
5. Deploy, then confirm `https://<your-render-service>.onrender.com/api/health` returns `{"ok":true}`.

## Vercel frontend

The frontend project is `fellaa` and its domain is `https://fellaa.vercel.app`. Open it with the Render API URL:

```text
https://fellaa.vercel.app/?api=https://<your-render-service>.onrender.com
```

Use the exact deployed frontend origin (without a path or query) for Render's `ALLOWED_ORIGIN`.

## Local development

Run the backend with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set in the environment, then open the frontend with `?api=http://localhost:3000`. Do not place private keys in browser code.
