# Healthy Reddit: child extension

The teen's whole experience lives inside Reddit. There's no app, account, or dashboard for them.

| What the teen sees | When |
|---|---|
| Nothing (normal Reddit) | The thread's title, body and top comments score **Safe** |
| Full-screen frosted **Pause** checkpoint with a **Low / Medium / High** badge, *"Pause, ask for parent's permission to view"* and *"Go back to safety"* | The thread is flagged |
| Quiet redirect to the Reddit home feed | The thread's level is under an active 30-day block |
| A blurred card with a short note (feed only) | A post in the feed looks toxic to the local scorer |

Clicking the permission button opens the **co-viewing review window** on the teen's screen. It shows the post title (parent eyes only), three Gemini coaching tips, a PIN field, and two choices:
- **View Post & Ask for Passcode Next Time** lifts the cover for this thread and this visit only.
- **Block This Intensity Bucket for 30 Days** locks out that whole level and sends the teen home.

## Run it

1. Start the backend: `cd ../backend && node server.js` (see `../backend/README.md`).
2. Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
3. Parent: open http://localhost:8787, create an account with a PIN, click **Generate pairing code**.
4. Teen's Chrome: sign in to Reddit, click the extension icon, enter the 6-digit code. The parent portal turns green.

The toolbar icon shows an orange **!** until the browser is paired.

## Files

| File | Role |
|---|---|
| `content.js` | Pause overlay (shadow DOM, page set `inert`), thread reading, Reddit SPA navigation, feed blur |
| `background.js` | Only part that calls the backend; holds the device token; opens and tracks the review window; heartbeat every 15 min |
| `setup.html/js` | One-time pairing popup (auto-detects the signed-in Reddit account) |
| `review.html/js` | Co-viewing review window |
| `classifier.js` | Local SVM/keyword scorer, used only as a fallback when the server is unreachable and for feed blurring |
| `options.html/js` | Developer settings: backend URL and a scorer tester |
| `config.js` | Default backend URL |

## Plug in your SVM

Export it as `model.json` (format below) and put it in **both** this folder (local fallback) and `../backend/`
(the backend also checks this folder). Works with sklearn TfidfVectorizer (unigrams) + LinearSVC:

    terms = {w: [float(vec.idf_[i]), float(clf.coef_[0][i])] for w, i in vec.vocabulary_.items()}
    json.dump({"terms": terms, "bias": float(clf.intercept_[0])}, open("model.json", "w"))

Bucket cutoffs live in `BUCKETS` in `../backend/classifier.js` (and are mirrored in `classifier.js` here). Tune them on your labeled test set.

## Known limits (prototype)
- A teen can remove the extension or use another browser profile. For real use, force-install it with Chrome
  enterprise/family policy. The portal's "last active" time helps a parent notice if it stopped reporting.
- The overlay is regular page DOM, so someone with DevTools could remove it.
- Reddit's markup changes often. Thread reading uses `shreddit-post` / `shreddit-comment` (new Reddit) and
  `div.thing` (old Reddit). If it can't find the post within 8 s, it lets the page through rather than trapping the user.


## Same-Wi-Fi demo (v0.2.1)

The Node backend already listens on all network interfaces. Run `node server.js` from `Reddit/backend` on the computer hosting it. On that computer, find its Wi-Fi LAN IP (Mac: System Settings > Wi-Fi > Details > TCP/IP; often 192.168.x.x). On the parent's phone/computer, connected to the **same Wi-Fi**, visit `http://LAN_IP:8787` (replace LAN_IP). On the child's Chrome extension, open **Manage extension > Extension options**, enter `http://LAN_IP:8787` under Backend URL, and click Save. Refresh Reddit and pair as usual. If the extension and backend share the same computer, `http://localhost:8787` is also valid for the extension.

For demo convenience this development manifest includes the broad `http://*/*` host permission so the team can use different LAN IP addresses. **Restrict host permissions and use HTTPS before release.** The LAN parent portal is plain HTTP, so PINs, credentials and post content are not protected against others on the network; use trusted private Wi-Fi and demo-only credentials, not a public/hotel/campus network. Keep the Node server running and allow incoming connections to TCP port 8787 if prompted by the operating system firewall. Some networks use client isolation and will not permit device-to-device traffic.
