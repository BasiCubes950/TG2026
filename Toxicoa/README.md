# Toxicoa: Healthy Reddit

**A Chrome extension that pauses toxic Reddit threads so a parent and teen can review them together.**

Nearly half of U.S. teens have been bullied or harassed online, and most never tell an adult. Toxicoa doesn't block content silently or spy on the teen. It predicts when a Reddit thread is likely to turn toxic, puts up a pause screen, and invites the teen to look at it *with* a parent, who gets AI-written conversation starters for the talk.

---

## How it works

```
 Teen opens a Reddit thread
          │
          ▼
 Chrome extension reads the title, post text and first 5 comments
          │
          ▼
 Node backend ──► Python ML service
                   1. toxic-bert scores each of the 5 comments
                   2. trained logistic regression predicts whether
                      the rest of the thread will turn toxic
          │
          ▼
 Safe ─────────► page shows normally
 Low/Med/High ─► full-screen pause: "Ask a parent" or "Go back"
 Blocked level ► quiet redirect to the Reddit home feed
          │
          ▼
 Parent enters PIN on the teen's screen → sees the post + 3 Gemini coaching tips
          → "View this time" or "Block this level for 30 days"
```

### What the teen sees
| Situation | Result |
|---|---|
| Thread predicted **safe** | Normal Reddit |
| Thread flagged **Low / Medium / High** | Full-screen pause with the level shown, plus *Ask a parent* and *Return to Reddit feed* buttons |
| Thread's level is under a 30-day block | Sent back to the Reddit home feed |
| Fewer than 5 comments available, or the model fails | *Safety check unavailable* screen with Retry / Go back. It never guesses "safe." |

### What the parent does
1. Creates an account in the **Parent Portal** with an email, a password and a 4–8 digit PIN.
2. Generates a **6-digit pairing code** (valid 10 minutes) and enters it in the teen's extension.
3. When a thread is paused, enters the PIN in the review window. Only after the PIN is verified do the post and coaching tips appear.
4. Chooses **View** (this thread, this visit only) or **Block for 30 days** (every thread at that level).
5. Manages the PIN, active blocks and paired browsers from the portal.

---

## The model

The classifier is the logistic regression from our datathon notebook (`improve_target_and_features.ipynb`), saved as `reddit_toxicity_model.pkl`.

- **Training data:** 10,000 posts sampled from a 188,000-post Reddit dataset, filtered to English posts with at least 10 comments (7,391 posts).
- **Label:** a thread counts as toxic if its *later* comments (after the first 5) include at least 2 comments with a toxic-bert score ≥ 0.8, making up at least 10% of those later comments. The model never sees the comments that define the label.
- **Inputs:** post text, subreddit, posting hour and weekday, title and body length, and the text and toxic-bert scores of the first 5 comments.
- **Performance:** this feature set averaged **ROC-AUC 0.84** and **F1 0.42** for the toxic class across 5 random train/test splits (about 10% of threads are toxic).
- **Levels:** Low / Medium / High come from how far the model's score is above its decision threshold. They are **not calibrated probabilities** and still need validation.

---

## Project structure

```
Toxicoa/
└── Healthy_ML_3/
    ├── chrome-extension/        Teen's browser (Manifest V3, "Healthy Reddit" v0.2.2)
    │   ├── content.js           Pause overlay, thread reading, Reddit navigation handling
    │   ├── comment-fetch.js     Gets the 5 oldest comments from Reddit's JSON
    │   ├── background.js        Talks to the backend, stores the device token, opens the review window
    │   ├── setup.html/js        Pairing popup (enter the 6-digit code)
    │   ├── review.html/js       Parent review window (PIN first, then post + tips)
    │   ├── options.html/js      Developer settings (backend URL)
    │   └── config.js            Default backend URL
    └── backend/
        ├── server.js            Node API: accounts, pairing, PIN checks, 30-day blocks
        ├── store.js             JSON-file storage; encrypts PINs, hashes passwords
        ├── gemini.js            Parent coaching tips (built-in tips if no API key)
        ├── public/              Parent Portal web page
        └── ml_service/
            ├── app.py           Python FastAPI service that runs the model
            ├── reddit_toxicity_model.pkl
            └── requirements.txt
```

---

## Setup

You need **Node.js 18+**, **Python 3.11 or 3.12**, and Chrome. Run each service in its own terminal.

### 1. Python ML service (port 8766)
```bash
cd Healthy_ML_3/backend/ml_service
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8766
```
The first prediction downloads the toxic-bert weights, so it can be slow.

### 2. Node backend + Parent Portal (port 8787)
```bash
cd Healthy_ML_3/backend
GEMINI_API_KEY=your-key node server.js     # the key is optional
```

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Backend port (also update `config.js` and `manifest.json` if you change it) |
| `PYTHON_MODEL_URL` | `http://127.0.0.1:8766` | Where the ML service runs |
| `GEMINI_API_KEY` | none | Turns on AI coaching tips |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Gemini model name |
| `DB_FILE` | `./data.json` | Storage file |
| `PIN_SECRET` | random, saved in the DB | Key for encrypting PINs |

### 3. Chrome extension
1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select `Healthy_ML_3/chrome-extension`.
3. After code changes, click **Reload**. Don't remove and re-add the extension, or the pairing is lost.

### 4. Pair and test
1. Parent: open <http://localhost:8787>, create an account, then click **Generate pairing code**.
2. Teen: log into Reddit, click the extension icon, and enter the code. The portal turns green.
3. Open a Reddit thread with at least 5 comments. Look for `[ML prediction]` in the Node terminal and `POST /predict 200` in the Python terminal.

**Health checks:** <http://localhost:8787/api/health> and <http://127.0.0.1:8766/health>

### Demo across two devices (same Wi-Fi)
Find the host computer's Wi-Fi IP address, for example `192.168.x.x`. The parent opens `http://<IP>:8787` on their phone. On the teen's Chrome, open the extension's **Options** page, set the backend URL to `http://<IP>:8787`, and click Save. Use a trusted private network only, because traffic is plain HTTP.

---

## API

**Parent** (portal session token): `POST /api/parent/signup` · `POST /api/parent/login` · `POST /api/parent/logout` · `GET /api/parent/me` · `GET|POST /api/parent/pin` · `POST /api/parent/pairing` · `GET /api/parent/pairing/:code` · `POST /api/parent/blocks/reset` · `POST /api/parent/children/:id/unpair`

**Extension** (device token): `POST /api/device/pair` · `POST /api/device/heartbeat` · `POST /api/thread/check` · `POST /api/thread/coaching` · `POST /api/thread/decision`

**ML service:** `POST /predict` with `{title, body, comments[5], community_name, date_posted, community_members_num}` returns `{bucket, predicted_toxic, margin, decision_threshold, score, early_comment_scores}`.

---

## Safety and privacy design

- **PIN first:** the review window shows nothing about the post until the parent's PIN is verified.
- **Brute-force lockout:** 5 wrong PINs lock entry for 5 minutes.
- **Alt-account resistant:** pairing is tied to the browser install, not the Reddit account, so switching accounts doesn't remove protection. The parent sees every username used.
- **Fails closed:** if the model can't score a thread, the pause stays up.
- **Local processing:** Reddit content is scored on your own machine. Only Gemini coaching (if turned on) sends the post title and an excerpt to Google.

---

## Known limitations

This is a **hackathon prototype**, not production parental-control software.

- **Training vs. live mismatch:** the model was trained on each thread's first 5 comments in time order. Live, the extension uses the 5 oldest comments it can get from Reddit, which may differ (deleted comments, rate limits). Subscriber count isn't available on the page, so it is always 0.
- **Threads with fewer than 5 comments** can't be scored and show the *Safety check unavailable* screen.
- **The feed isn't scanned.** Only thread pages are checked.
- **Levels are provisional** and need tuning on a held-out, reviewed set.
- **toxic-bert errors:** one test hit `Tensor.item() cannot be called on meta tensors`, which makes the ML service return HTTP 503. If you see this, reinstall `torch`/`transformers` in a fresh virtual environment.
- **Easy to bypass:** a teen can disable the extension or use another browser profile. For real use, force-install it through Chrome family or enterprise policy.
- **Not deployment-ready:** plain HTTP, open CORS, broad `http://*/*` permission for the demo, and storage in a single JSON file.
- **Loading the `.pkl` file runs code,** so only use a model file from a trusted teammate.
- `options.html` still loads a `classifier.js` file that was removed, so its "Try the local scorer" box doesn't work.

## Future work

1. Cross-check the toxicity labels with a second, independent AI model.
2. Replace logistic regression with transformer models trained on all 188k posts.
3. Test on teen-heavy communities and tune the Low / Medium / High levels on real data.
