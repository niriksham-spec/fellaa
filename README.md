# Fella Ride

The web app and API are hosted on Vercel. Firebase Authentication handles email/password sign-in, and Cloud Firestore stores rides, profiles, bookings, and communities.

## One-time Firebase setup

1. Select the Firebase project `fellaride-982b2` (or change `.firebaserc` and the API URL in `indexx.html` if using another project).
2. In **Authentication → Sign-in method**, enable **Email/Password**. Add `fellaa.vercel.app`, `localhost`, and (if used locally) `127.0.0.1` under **Authentication → Settings → Authorized domains**.
3. Create a Cloud Firestore database in **Native mode**.
4. In **Project settings → General → Your apps**, register a Web app and get its `apiKey` and `appId`.
5. The API can run on Vercel without enabling Firebase Cloud Functions or upgrading Firebase to Blaze. Firestore and Vercel still have usage limits; review both services' quotas.

Firestore rules in this repository deny direct browser access. The API verifies Firebase Authentication ID tokens and uses a private service account to access Firestore and Firebase Authentication.

## Configure and deploy the Vercel API

In the Vercel project settings, add these Environment Variables for Production (and Preview if needed):

```text
FIREBASE_PROJECT_ID=fellaride-982b2
FIREBASE_WEB_API_KEY=your-web-app-api-key
FIREBASE_APP_ID=your-web-app-id
FIREBASE_AUTH_DOMAIN=fellaride-982b2.firebaseapp.com
FIREBASE_SERVICE_ACCOUNT=<service-account JSON>
OTP_SECRET=<long random secret>
```

Get the Web app values from Firebase **Project settings → General → Your apps**. Create a service account with the minimum required access to Firebase Authentication and Firestore, then store its JSON privately as the `FIREBASE_SERVICE_ACCOUNT` Vercel environment variable. Never commit or paste service-account credentials into source code or chat. Set `OTP_SECRET` to a long, random value; do not use the development fallback in a deployed environment.

After adding the variables, redeploy the Vercel project. The API function is served from the same domain as the frontend, so the app does not need a Firebase Cloud Functions endpoint. The existing frontend is <https://fellaa.vercel.app>.

The live-events endpoint uses server-sent events. Serverless instances are not shared, so live updates can be less reliable on Vercel than on a persistent server.

For local development, `backend/sec.env` (git-ignored) must contain `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, and `FIREBASE_APP_ID`. For keyless Admin access, install the Google Cloud CLI and run `gcloud auth application-default login`, then `gcloud auth application-default set-quota-project fellaride-982b2`. Alternatively, set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON file outside the repository. Never commit or paste service-account credentials. Run `npm start` from the repository root, then open <http://localhost:3000>; the local server serves the frontend and API together.
