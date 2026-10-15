# Fella Ride

The frontend is hosted on Vercel at <https://fellaa.vercel.app>. Its API is hosted on Render at <https://fellafly.onrender.com> and stores app data in PostgreSQL.

## Render backend

The backend service should use the `backend` root directory, `npm install` as its build command, and `npm start` as its start command. Choose Render's Free instance plan if available.

Set `DATABASE_URL` to the PostgreSQL connection string from Supabase **Project Settings → Database → Connection string**. Keep this value private. The backend creates its tables on startup; Render logs should show `database ready`. The root endpoint should display `Fella Ride API is running.`.

For email OTP delivery, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS` in Render. Without SMTP configuration, users can still use guest access.

## Vercel frontend

The frontend's API URL is configured in `indexx.html`. The production app is at <https://fellaa.vercel.app>. Pushes to `main` deploy the frontend automatically.

The app includes guest access as well as optional email OTP login. Do not commit database or SMTP credentials.
