# Fella Ride

The web app is hosted on Vercel. Firebase Authentication handles email/password sign-in, Cloud Functions runs the API, and Cloud Firestore stores rides, profiles, bookings, and communities. Render is not used.

## One-time Firebase setup

1. Select the Firebase project `fellaride-982b2` (or change `.firebaserc` and the API URL in `indexx.html` if using another project).
2. In **Authentication → Sign-in method**, enable **Email/Password**. Add `fellaa.vercel.app`, `localhost`, and (if used locally) `127.0.0.1` under **Authentication → Settings → Authorized domains**.
3. Create a Cloud Firestore database in **Native mode**.
4. In **Project settings → General → Your apps**, register a Web app and get its `apiKey` and `appId`.
5. Enable billing for the project if Firebase requires the Blaze plan to deploy Cloud Functions. Cloud Functions and Firestore usage can incur charges; configure budget alerts.

Firestore rules in this repository deny direct browser access. The API uses the Cloud Functions service identity and verifies Firebase Authentication ID tokens.

## Configure and deploy the Firebase API

Install Node.js 20 or later. From the repository root, authenticate the Firebase CLI and select the configured project:

```powershell
npx firebase-tools login
npx firebase-tools use fellaride-982b2
```

Create `backend/.env.fellaride-982b2` (this file is git-ignored) with the Firebase Web app's public configuration:

```dotenv
FIREBASE_WEB_API_KEY=your-web-app-api-key
FIREBASE_APP_ID=your-web-app-id
FIREBASE_AUTH_DOMAIN=fellaride-982b2.firebaseapp.com
```

These Web app settings are public, unlike service-account keys. Do not create or upload a service-account key for Cloud Functions; the deployed function uses its Firebase service identity.

Deploy the API and restrictive Firestore rules:

```powershell
npx firebase-tools deploy --only functions:fellaRideApi,firestore:rules
```

The API is configured in `indexx.html` to use `https://us-central1-fellaride-982b2.cloudfunctions.net/fellaRideApi`. The first function invocation initializes the default communities and demo rides in Firestore.

## Frontend

The frontend is hosted at <https://fellaa.vercel.app>. Pushes to `main` deploy it through Vercel. If the Firebase project or function region changes, update `API` in `indexx.html` to the new Cloud Function URL. `window.FELLA_API_URL` can override it for local testing.

For local development, `backend/sec.env` (git-ignored) must contain `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, and `FIREBASE_APP_ID`. For keyless Admin access, install the Google Cloud CLI and run `gcloud auth application-default login`, then `gcloud auth application-default set-quota-project fellaride-982b2`. Alternatively, set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON file outside the repository. Never commit or paste service-account credentials. Run `npm start` from the repository root, then open <http://localhost:3000>; the local server serves the frontend and API together.
