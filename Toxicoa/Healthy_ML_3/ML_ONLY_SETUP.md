# Trained model only — Healthy Reddit

The **Python ML model is the only toxicity classifier**. Node.js remains necessary for the parent portal, pairing, PIN, Gemini coaching, and 30-day block policy. No keyword fallback is used.

## Run locally

1. From `backend/ml_service`, activate the existing Python environment (or create one), install `requirements.txt`, and run:
   `python -m uvicorn app:app --host 127.0.0.1 --port 8766`
2. From `backend`, run `node server.js`.
3. Keep the extension's backend URL pointing to Node port `8787`; reload the extension rather than removing it, to preserve pairing.
4. Check `http://localhost:8787/api/health` for `trained-logistic-regression-only`.
5. On a thread with five visible comments, look for `[ML prediction]` in Node and `POST /predict 200` in Python.

If fewer than five comments are extracted or Python fails, the extension displays **Safety check unavailable** with Retry / Go Back. It does not guess a safe label or silently expose the post. The first five *visible* comments are not guaranteed chronological and the risk buckets are provisional. This is a prototype, not production-grade child protection.

To keep existing parent and pairing records, **preserve your current backend data.json** (or the path configured by DB_FILE) and Chrome extension installation/storage. Don't overwrite a newer data file with the ZIP version.

## Feed behavior

Feed cards are **not scanned** in this ML-only version. The model needs five comments available on the thread page. A future feed-preview feature would need an API that obtains and orders the early comments without revealing the post.
