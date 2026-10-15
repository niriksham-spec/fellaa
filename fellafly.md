
## Setup

### 1. Firebase
1. Create a project at console.firebase.google.com.
2. Enable **Authentication → Phone**.
3. Add test phone numbers under **Phone numbers for testing**.
4. Add your Vercel domain under **Authorized domains**.
5. Copy the web config values into `index.html`.
6. Download a **service account key** (Project settings → Service accounts).

### 2. Database
1. Create a Supabase project.
2. Copy the **Session pooler** connection string with your database password.

### 3. Backend (Render)
1. Create a web service from the `backend` folder.
2. Build command: `npm install`. Start command: `npm start`.
3. Set environment variables:

| Key | Value |
|---|---|
| `DATABASE_URL` | Supabase connection string |
| `FIREBASE_SERVICE_ACCOUNT` | Full service account JSON |
| `DEV_MODE` | `true` (optional, for testing) |

### 4. Frontend (Vercel)
1. Import the `frontend` folder as a project.
2. Set `const API` in `index.html` to your Render URL, with no trailing slash.

### 5. Run locally
```bash
cd backend
npm install
npm start
```
Open `frontend/index.html` in a browser, or use any static server.

## Configuration

| Setting | Where | Default |
|---|---|---|
| Fare tariff | `server.js`, `TARIFF` | auto 30 + 15/km, cab 100 + 14/km, shared 20 + 6/km, minimum ₹20 |
| CO₂ factor | `server.js` | 0.12 kg per km (assumption, see limitations) |
| Live location duration | `server.js` | 15 minutes |
| Points per trip | `server.js` | 5 |


## Assumed limitations

These are known limits of the current version. Mention them honestly during the demo.

1. **Fares are estimates.** They use a simple formula, not live Uber, Ola or metered auto prices. No public API provides those.
2. **CO₂ figure is an assumption.** 0.12 kg per km is a demo factor. Replace it with an official emission factor before presenting it as fact.
3. **Ride positions on the map are simulated** from departure times. Only shared member locations are real, and they depend on the member's device.
4. **No payments.** Riders do not pay through the app. Fares are shown for comparison only.
5. **No driver licence or vehicle checks.** Drivers are not verified beyond phone login.
6. **No emergency or SOS feature** yet.
7. **No email or push notifications.** Alerts appear only inside the app while it is open.
8. **Free hosting limits.** Render sleeps after inactivity and can take about a minute to wake. Supabase free projects pause after a period of no use.
9. **Data is kept on free services.** Backups are not configured.
10. **Guest accounts** are tied to the browser. Clearing browser data starts a new account.
11. **Road distance** depends on the public OSRM demo server, which may be slow or rate-limited. The app falls back to a straight-line estimate.
12. **Location accuracy** depends on the device and browser permission.
13. **Phone login** uses Firebase test numbers during the demo. Real SMS needs Firebase billing and region limits to be checked.
14. **Privacy:** before real users join, add a privacy policy and a data deletion process.
15. **No automated tests.** Features were checked by hand.
16. **Not a licensed transport service.** Check state rules for shared fares before charging riders.

## Roadmap

- Payments and receipts
- Driver licence and vehicle verification
- SOS with trusted contacts
- Push notifications
- Real GPS tracking for drivers
- Official emission factors per vehicle type

## Licence

Add your chosen licence here, for example MIT.

## Team

Your name and team members.
