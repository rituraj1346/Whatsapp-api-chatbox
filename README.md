# Business Inbox

Send and read messages from your **WhatsApp Business API number** on your Android phone, iPhone and computer, all at the same time. It talks straight to Meta's official WhatsApp Cloud API, so you don't need Twilio, Gupshup or any other provider. You can install it like a normal app and get notifications.

It runs online on **Netlify** (the website) with **Supabase** (the database). Both have free plans. You never edit code: after the one-time hosting setup below, everything is set up inside the app.

## What you can do in the app

| Where | What |
|---|---|
| **Chats** | Read and reply. Send photos, videos, audio and documents. See ✓ sent, ✓✓ delivered, blue ✓✓ read, ⚠ failed (with the reason). Search chats and see unread counts |
| **Chats** | Start a new chat, or send an approved template when the 24-hour window is closed |
| **Chats** | Click a contact's name to rename them (the new name shows on every device) |
| **Chats** | Quick replies: tap ⚡, or type `/` at the start of a message |
| Settings → **Connection** | Enter your Meta details. They are checked with Meta before saving, then encrypted and locked. Register your phone number with a PIN |
| Settings → **Receive messages** | Shows this app's address. The webhook is connected for you, so you don't need the Meta dashboard |
| Settings → **Business profile** | About, description, address, email, websites, category |
| Settings → **Templates** | See all templates with their status (Approved / Waiting / Rejected with the reason), create and delete them |
| Settings → **Quick replies** | Add, edit and delete saved answers |
| Settings → **Auto-replies** | A welcome message for first-time customers, and an away message outside opening hours |
| Login | Anyone can tap **Create an account**. Each account is its own business: it connects its own WhatsApp number and only sees its own chats, templates and settings. The first account owns the site |
| Settings → **Chats & security** | Your account; the owner also sees every account and can delete one. Read receipts, notifications on this device, the list of devices getting notifications (remove a lost phone), install the app, change password, log out |
| Settings → **Branding** | Your own app name and colour, for the icon, home-screen name and colours |

## Put it online (one time, about 15 minutes)

You need: [Node.js](https://nodejs.org) 20.12 or newer on your computer, a free [Supabase](https://supabase.com) account and a free [Netlify](https://netlify.com) account.

### 1. Create the database (Supabase)

1. On [supabase.com](https://supabase.com) click **New project**. Choose a name, a **database password** (write it down) and the region closest to you. Wait until the project is ready.
2. Click **Connect** at the top of the project. Under **Connection string**, choose **Transaction pooler** and copy the address. It looks like
   `postgresql://postgres.abcd…:[YOUR-PASSWORD]@aws-0-….pooler.supabase.com:6543/postgres`.
   Replace `[YOUR-PASSWORD]` with your database password. This is your **DATABASE_URL**.
3. Go to **Project Settings → API Keys** and copy the **anon** (or **publishable**) key. This is your **SUPABASE_ANON_KEY**. It is safe to show in a browser.

You don't create any tables. The app creates them itself and locks them so only the app can read them.

### 2. Upload the app (Netlify)

**Option A — from GitHub (updates go live automatically when you push):**

1. On [app.netlify.com](https://app.netlify.com) click **Add new project → Import an existing project → GitHub** and pick this repository.
2. Leave **Build command** empty and **Publish directory** as `public` (Netlify reads `netlify.toml`). Add the three environment variables from step 3 below on this same screen, then click **Deploy**.

**Option B — from your computer:**

1. Get the code (`git clone https://github.com/rituraj1346/Whatsapp-api-chatbox.git && cd Whatsapp-api-chatbox`), then run:
   ```
   npm install
   npm run deploy
   ```
2. The first time, a browser window asks you to log in to Netlify and **Authorize**. Back in the terminal, choose **Create & configure a new project**, pick your team and type a project name (for example `sweetshop-inbox`). The upload then finishes and shows your address, for example `https://sweetshop-inbox.netlify.app`.

(Drag-and-drop upload on Netlify's website doesn't work for this app, because it can't upload the app's server part.)

### 3. Add the settings in Netlify

1. Make a secret key: run `npm run secret` and copy the long line it prints.
2. On [app.netlify.com](https://app.netlify.com) open your project → **Project configuration** → **Environment variables** → **Add a variable** → **Add a single variable**, and add these three:

| Key | Value |
|---|---|
| `DATABASE_URL` | the connection string from step 1.2 (with your password in it) |
| `SECRET_KEY` | the line from `npm run secret` |
| `SUPABASE_ANON_KEY` | the key from step 1.3 |

3. Deploy again so the new settings take effect: `npm run deploy` (Option B), or **Deploys → Trigger deploy** in Netlify (Option A).

**Never commit secrets to GitHub.** `.env` and the `data/` folder (which holds a local secret key) are already in `.gitignore`. Put real values only in Netlify's environment variables.

**Keep `SECRET_KEY` the same forever.** It encrypts your Meta details. If it changes, the app asks for your Meta details again, and each device has to turn notifications on again.

### 4. Open the app

Open your Netlify address, **create an account** (username + password; the first one becomes the owner), then enter the 4 values from Meta:

| Value | Where to find it in Meta |
|---|---|
| **Access token** | [business.facebook.com](https://business.facebook.com) → Settings → Users → **System users** → Add (Admin) → Assign your app and WhatsApp account → **Generate new token**. Tick **whatsapp_business_messaging** and **whatsapp_business_management**, and choose "Never" for expiry |
| **Phone number ID** | [developers.facebook.com/apps](https://developers.facebook.com/apps) → your app → WhatsApp → **API Setup**, under the "From" number |
| **WhatsApp Business Account ID** | Same API Setup page, just below the Phone number ID |
| **App secret** | Your app → **App settings → Basic** → App secret → Show |

Click **Check & save**. The app connects Meta's webhook to your Netlify address by itself. **Receive messages** should show **✓ Connected**. That's it.

No Meta app yet? Click **Create app** → **Business** → add **WhatsApp**. You get a free test number right away. To use your real number, add it on API Setup, verify it, add a payment method, then use **Register phone number** in Settings → Connection.

**Do I have to enter my details every time?** No. Your Meta details are saved encrypted in Supabase. Each device stays logged in for 30 days, then asks only for your username and password.

### Updating the app later

Push to GitHub (Option A) or run `npm run deploy` again (Option B). Your messages and settings stay in Supabase.

### Using a different Postgres database instead of Supabase

Any hosted Postgres that accepts SSL works (Neon, Railway, AWS RDS, your own server): set `DATABASE_URL` to its connection string (`postgresql://user:password@host:5432/dbname`). SSL is required unless the host is `localhost`. The app creates its own tables on first start. Without `SUPABASE_ANON_KEY` devices check for new messages every 30 seconds instead of instantly.

If you give the site a new name or your own domain in Netlify, deploy once more, then click **Settings → Receive messages → Connect webhook now** so Meta uses the new address.

## Use it on Android, iPhone and your computer

Use your Netlify address (or your own domain) on every device.

| Device | Install | Turn on notifications |
|---|---|---|
| **iPhone / iPad** (iOS 16.4+) | Open the address in **Safari** → **Share** → **Add to Home Screen** | Open the app **from the Home Screen** → Settings → Chats & security → **🔔 Turn on notifications** → Allow |
| **Android** | Open in **Chrome** → tap **Install** (or menu ⋮ → **Install app**) | Settings → Chats & security → **🔔 Turn on notifications** → Allow |
| **Computer** | **Chrome/Edge**: click the install icon in the address bar. **Mac Safari**: File → **Add to Dock** | Same button in Settings → Chats & security |

- **Devices stay in sync.** A new message shows everywhere within a second. Reading a chat on one device clears its unread badge and notifications on the others. Renames show everywhere.
- **Devices getting notifications** (Settings → Chats & security) lists every phone and computer with notifications on. Use **Remove** for a lost or old phone. **Show the message text in notifications** can be turned off for privacy.
- **Typing:** on phones, Enter adds a new line and the round button sends. On computers, Enter sends and Shift+Enter adds a new line.
- **Android back button** closes a chat or Settings, like a normal app.
- You do **not** need an Apple developer account, the App Store, Google Play or Firebase.

## Limits of the free plans

- **Supabase pauses free projects after about a week with no activity.** While it is paused, the app shows "Cannot reach the database" and new WhatsApp messages can't be saved. Meta keeps retrying for a while, so short pauses usually lose nothing. Open [supabase.com](https://supabase.com) and click **Restore** if it happens. A paid Supabase plan never pauses.
- **File size:** you can send files up to **4 MB** from the app, and received files over about 4 MB can't be opened in the app (open them in WhatsApp on a phone). This is a Netlify Functions limit.
- **Netlify's free plan** has a monthly allowance of function calls. Every message, page load and check uses a few. A small business normally stays well inside it. You can see the usage in Netlify.
- If **SUPABASE_ANON_KEY** is missing, the app still works but checks for new messages every 30 seconds instead of instantly.

## WhatsApp's rules

- **24-hour window:** you can send normal messages only within 24 hours of the customer's last message. After that, or to start a new chat, send an **approved template**.
- **Templates** are checked by Meta first (usually minutes). Some categories cost money per message.
- **Test number:** it can only message up to **5 numbers** that you add under API Setup → "To".

## Security notes

- Your access token, app secret and notification keys are encrypted (AES-256-GCM) with `SECRET_KEY` and never sent to the browser. Someone with only the database can't read them. Messages are not encrypted in the database.
- The app's tables have row level security turned on with no rules, so Supabase's public API (and the anon key) can't read them. Only the app, through `DATABASE_URL`, can.
- Instant updates between devices go through a secret Supabase channel and carry no message text, only "something changed in chat X". Devices then load the details through the logged-in app. Changing your password makes a new channel.
- Connection details need your password to change, and they lock again after 10 minutes. After 10 wrong passwords, that address is blocked for 15 minutes.
- **Backups:** Supabase backs up paid projects daily. On the free plan, use **Database → Backups** or export the tables now and then.
- **Accounts:** sign-up is open to anyone with your address. Every account is kept apart (its own Meta details, chats, templates, quick replies, notifications and webhook address `/webhook/<username>`). The first account to sign up is the **owner**: only the owner changes Branding and can delete accounts. Commercial use needs a license, see **License** below.
- **Forgot your password?** In Supabase open **Table Editor → users**, delete your row, then sign up again with the same username and enter your Meta details again. Your old chats stay in the database under that username and come back. (If you delete the owner's row, the next account to sign up does **not** become owner; set `owner` to true on a row in the same table.)

## Try it on your computer first (optional)

`npm install && npm start`, then open **http://localhost:3000**. It uses a built-in database in the `data/` folder, so you don't need Supabase for this. You can set everything up and send messages, but Meta can only deliver incoming messages to an https address, so replies only arrive once the app is online.

## License

Copyright © 2026 Rituraj Deka. Released under the **[PolyForm Noncommercial License 1.0.0](LICENSE)**.

- ✅ **Free** for personal use, learning, research, hobby projects, charities, schools and government bodies.
- ❌ **Not free for commercial use.** Selling it, hosting it for paying customers, or using it to run a for-profit business requires a **paid commercial license**. Open an issue on this repository or contact the owner to ask.
- Keep the copyright notice and the `LICENSE` file in every copy.

**If you get a commercial license:** don't use WhatsApp's name or logo as your product's name or icon (Meta's brand rules forbid it; use the **Branding** tab). Hosting it for other businesses means joining Meta's **Tech Provider** program. The dependencies are MIT, Apache-2.0 and MPL-2.0 (web-push: share changes to its own files). Not legal advice.

## Project layout

```
public/            the app's pages (Netlify serves them as they are)
  index.html       screens and dialogs, home-screen app tags
  style.css        look and feel, light/dark, phone layout, safe areas
  common.js        helpers: safe DOM building, API calls, branding, device detection
  settings.js      Settings screens, notifications, branding
  app.js           login and the inbox, live updates between devices, back button
  sw.js            service worker: notifications only, caches nothing
netlify/functions/
  app.mjs          the server as one Netlify Function
netlify.toml       tells Netlify what goes to the function, and the security headers
src/
  app.js           the server: inbox API, manifest and icons
  server.js        runs the same server on your computer (npm start)
  admin.js         every Settings route, webhook auto-setup, branding, push routes
  auth.js          password, sessions, lock/unlock, rate limit
  config.js        hosting settings (environment variables)
  db.js            Postgres: Supabase online, built-in PGlite on your computer
  settings.js      encrypted credentials and saved preferences
  whatsapp.js      Meta Graph API calls, friendly error hints
  webhook.js       messages and status updates from Meta
  events.js        live updates: Supabase Realtime online, an event stream locally
  push.js          Web Push notifications to installed devices
  icons.js         draws the app icons (PNG and SVG) in the brand colour
  autoreply.js     welcome and away messages
test/              npm test: full check against fake Meta, push and Supabase services
```

## API example

```bash
# log in and keep the cookie
curl -c cookies.txt -H "Content-Type: application/json" -d '{"username":"your username","password":"your password"}' https://your-site.netlify.app/api/login

# send a text (within the 24-hour window)
curl -b cookies.txt -H "Content-Type: application/json" -d '{"to":"919876543210","text":"Your order is ready!"}' https://your-site.netlify.app/api/send

# send an approved template with one variable
curl -b cookies.txt -H "Content-Type: application/json" \
  -d '{"to":"919876543210","name":"order_ready","language":"en","params":["Asha"]}' https://your-site.netlify.app/api/send-template

# list chats
curl -b cookies.txt https://your-site.netlify.app/api/conversations
```

`npm run dev` restarts on file changes, and `npm test` runs the full check without touching your data.
