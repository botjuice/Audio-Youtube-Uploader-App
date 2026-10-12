# Setup — Google / YouTube access

Yoosy Joosy uploads through the YouTube Data API using **your own** Google Cloud
project, so your quota is yours alone. Creating one is free and takes about five
minutes. You only do this once per Google account.

## 1. Create a project
Open <https://console.cloud.google.com/projectcreate>, name it anything (e.g. *Yoosy Joosy*), **Create**.

## 2. Enable the YouTube Data API v3
Open <https://console.cloud.google.com/apis/library/youtube.googleapis.com>, make sure your new project is selected at the top, **Enable**.

## 3. Configure the OAuth consent screen
Open <https://console.cloud.google.com/auth/overview> → **Get started**.
- App name: *Yoosy Joosy* · Support email: yours
- Audience: **External**
- Contact email: yours → **Create**

Then in **Audience**, add your Gmail address under **Test users**.

### ⚠️ Publish the app (recommended)
While the consent screen is in **Testing**, Google invalidates your sign-in every **7 days**, and you'll keep having to reconnect. On the same page click **Publish app** → **Confirm**. No verification is needed for personal use — the only effect is that the Google sign-in page shows an *"unverified app"* notice the first time; click **Advanced → Go to Yoosy Joosy (unsafe)** once and you're done. Tokens then last until you revoke them.

## 4. Create the OAuth client
Open <https://console.cloud.google.com/apis/credentials> → **Create credentials → OAuth client ID**.
- Application type: **Desktop app**
- Name: anything → **Create** → **Download JSON**

## 5. Connect in the app
Settings → Google / YouTube → **Choose client_secret.json…** → pick the downloaded file → **Connect Google**.
Your browser opens; sign in with the account that owns the YouTube channel and allow both YouTube permissions. The app shows your channel name when it's connected.

---

## Quota

Google gives each project 10,000 API units per day; one upload costs 1,600, a playlist add 50. The app's default of **6 uploads per day** fits inside that. The counter and the "resets in" timer in the sidebar follow YouTube's reset time (midnight Pacific). You can request more quota from Google at <https://support.google.com/youtube/contact/yt_api_form>.

## Troubleshooting

| Symptom | What it means / what to do |
|---|---|
| **Google: needs attention** in the sidebar, mentions "expired" or "invalid_grant" | Your token was revoked or expired (7-day Testing rule). Settings → Reconnect. Publish the consent screen to stop it recurring. |
| Connect opens the browser, then "Access blocked: … has not completed the Google verification process" | Your email isn't in Test users and the app isn't published. Add it, or publish (step 3). |
| Connect says "Google did not return a refresh token" | Remove Yoosy Joosy at <https://myaccount.google.com/permissions> and connect again. |
| Upload fails with **quotaExceeded** | Daily units used up; wait for the reset shown in the sidebar. |
| Upload fails with **uploadLimitExceeded** | YouTube's own channel limit (common on new/unverified channels). Verify the channel by phone at <https://www.youtube.com/verify>. |
| A recording shows **Needs you · no prayer name** | The filename has no Fajr/Dhuhr/…/Witr in it — rename it from the detail panel. |
| **unknown surah** | Add the spelling in Settings → Surah spellings (e.g. `thashr` → الحشر). |
| Something was uploaded outside the app and shows as Ready | Library → **Sync with YouTube** matches titles on your channel and marks them. Or use **Mark as uploaded** in the detail panel. |
| macOS: "app is damaged / can't be opened" | Unsigned build. `xattr -dr com.apple.quarantine "/Applications/Yoosy Joosy.app"` |
| Windows SmartScreen warning | Unsigned build. More info → Run anyway. |
| Auto-upload didn't pick up a new file | It waits for the file to finish copying (4 s of no changes), then uploads ~20 s later or at the next scheduled check. Check Activity for the reason if it was skipped. |
