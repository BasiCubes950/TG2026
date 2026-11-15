# Healthy Reddit: Python model + existing Node backend

## What changed
The Node backend now asks a local Python FastAPI service to run `reddit_toxicity_model.pkl`. The Chrome extension supplies title, description, up to 5 visible comments, subreddit and any available post timestamp. All parent pairing, PIN-first review, coaching and 30-day policies are preserved.

### Install (Mac, from Reddit/backend/ml_service)
1. Use Python 3.11 or 3.12 and Node.js >=18.
2. **Only use this .pkl if you trust the person who generated it**; loading pickle/joblib executes Python objects.
3. `python3 -m venv .venv`
4. `source .venv/bin/activate`
5. `python -m pip install -r requirements.txt`
6. `python -m uvicorn app:app --host 127.0.0.1 --port 8766`
   First toxic-bert call will download public model weights and can be slow. Keep this terminal running.
7. In a **second** terminal, from `Reddit/backend`, run `node server.js`.
8. Open `http://localhost:8787/api/health` and `http://127.0.0.1:8766/health`.
9. On child's Chrome, load the `chrome-extension` folder and reload it. Your existing browser pairing persists if the same extension ID / installation is retained. Parent's portal stays on `http://<MAC-WIFI-IP>:8787`.

## Important limitations of this hackathon prototype
* The training notebook used toxic-bert scores for the first **5 chronological comments**. Current extension reads **5 visible comments**; their DOM order may not be chronological and comment timestamps are not guaranteed. This creates train/serve mismatch.
* `community_members_num` defaults to 0 because Reddit does not provide it in the post's DOM; post timestamp can be missing, so the feature may differ from training.
* If fewer than 5 comments are visible or the Python service fails, the existing keyword scorer is used for immediate toxicity only. It is NOT a predictive ML result.
* Low/Medium/High tiers for the trained model use **provisional margins from the notebook's training threshold**. Model's sigmoid-transformed margin is not a calibrated probability, and the three tiers MUST be validated on a held-out human-reviewed set before serious deployment.
* The existing immediate title/description toxicity detection remains a keyword scorer, not a dedicated pretrained detection model.
* This is for trusted local testing, not production parental controls. The regular extension can be disabled, the on-page content can flash before filtering, and code paths can permit unsafe content when inspection fails.
* This implementation does not send your Reddit data to a hosted prediction API, but any Gemini coaching is a separate external service if enabled.

## Service request and response
POST `http://127.0.0.1:8766/predict` with JSON:
`{"title":"...","body":"...","comments":["a","b","c","d","e"],"community_name":"AskReddit","date_posted":"2026-11-14T12:00:00Z","community_members_num":0}`
Response: `bucket`, `predicted_toxic`, `margin`, `decision_threshold`, `score`, `early_comment_scores`, `source`.
