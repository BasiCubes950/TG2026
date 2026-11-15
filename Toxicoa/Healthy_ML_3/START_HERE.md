# Healthy Reddit — complete current project

Includes the complete Chrome extension (comment extraction fix plus PIN forwarding fix), the ML-only Node.js backend, parent portal, Python ML service, and trained Logistic Regression model.

## Install/update
1. Back up any existing backend data files (including parent accounts, pairing, and settings). Do not overwrite them with an empty/new data store.
2. Replace existing code files in your local `backend/` and `chrome-extension/` folders, or use these complete folders and transfer your existing backend data.
3. In `backend/ml_service`: activate its Python virtual environment and run `python -m uvicorn app:app --host 127.0.0.1 --port 8766`. Install dependencies from `requirements.txt` if needed.
4. In `backend/`: run `node server.js`.
5. On `chrome://extensions`, click Reload on Healthy Reddit, then reload Reddit. Do not remove/reinstall unnecessarily: it can reset pairing.

The Node.js service is still required for pairing, PIN verification, the parent portal and approval decisions. Classification uses the trained Python ML model, not keyword fallback.

## Known limitation
The Python Toxic-BERT feature calculation produced `Tensor.item() cannot be called on meta tensors` in a recent test. The model service may return HTTP 503 until that environment/inference issue is resolved. This ZIP consolidates the latest existing versions and PIN fix; it does not claim that the Toxic-BERT error has been resolved.
