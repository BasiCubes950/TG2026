# Datathon2026: Toxicoa

**Predicting which Reddit threads will turn toxic before they do, and helping parents and teens talk about it.**

Most toxicity tools spot a hostile comment after it has already been posted. This project tries to predict whether a discussion **will become toxic**, using only the post and its first few replies. We then use that prediction in **Toxicoa (Healthy Reddit)**, a Chrome extension that pauses risky threads and invites a teen to review them with a parent.

## Why it matters

- Nearly half of U.S. teens (46%) have experienced at least one form of cyberbullying ([Pew Research Center, 2022](https://www.pewresearch.org/internet/2022/12/15/teens-and-cyberbullying-2022/)).
- Most teens who are bullied online don't tell an adult. In one survey, only 41% had told anyone ([Cox / NCMEC, 2014](https://www.coxenterprises.com/news/survey-teens-don-t-tell-adults-when-they-are-bull)).
- Research links open parent–teen communication to lower cyberbullying victimization.

Toxicoa uses each flagged thread as a chance for parent and teen to talk, rather than a silent block.

## Repository structure

```
TG2026-main/
├── ML/                          Data pipeline + model training (Jupyter notebooks)
│   ├── ML_README.md             Full details: pipeline, results, limitations
│   ├── data-cleaning.ipynb      188,140 posts → cleaned text + time-ordered comments
│   ├── data-sampling.ipynb      Random sample of 10,000 posts
│   ├── data-labeling.ipynb      Scores every comment with toxic-bert
│   ├── classifier.ipynb                     Track 1: text-only models (SVM, logistic regression, …)
│   ├── classifier_svm_10000_results.ipynb   Track 1: TF-IDF SVM results
│   ├── embeddings_svm_10000_results.ipynb   Track 1: sentence embeddings vs. TF-IDF
│   ├── improve_target_and_features.ipynb    Track 2: final model (exports the .pkl)
│   └── XLM-RoBERTa_baseline.py             Fine-tuned XLM-RoBERTa baseline
│
└── Toxicoa/                     The product: Chrome extension + backend
    ├── README.md                Setup, architecture, API, limitations
    └── Healthy_ML_3/
        ├── chrome-extension/    Teen's browser: pause screen + parent review window
        └── backend/             Node server (accounts, pairing, PIN, blocks, Gemini tips)
            └── ml_service/      Python service that runs the trained model
```

**Transformer baseline:** [`ML/XLM-RoBERTa_baseline.py`](https://github.com/YulSung950/TG2026/blob/main/ML/XLM-RoBERTa_baseline.py) contains the XLM-RoBERTa baseline training script.

## How the pieces fit

```
 ML/ notebooks                                     Toxicoa/
 ─────────────                                     ────────
 Reddit export (188k posts)                        Teen opens a Reddit thread
      │ clean → sample 10k → label (toxic-bert)          │
      ▼                                                  ▼
 Train logistic regression ──► reddit_toxicity_model.pkl ──► Python ML service
 (post + metadata + first 5 comments)                    │
                                                         ▼
                                     Safe → normal page · Flagged → pause + parent review
```

## Results at a glance

There are no human labels. Comment toxicity is scored by `unitary/toxic-bert`, and a thread's label comes from its **later** comments. All results measure agreement with those model-generated labels.

| Model | What it sees | Toxic share | ROC-AUC | F1 (toxic class) |
|---|---|---|---|---|
| Track 1: tuned TF-IDF SVM | Title + text | 22% | n/a | 0.555 |
| Track 2, A | Post text only | 10% | 0.807 ± 0.013 | 0.376 |
| Track 2, B | + community, time, length | 10% | 0.824 ± 0.016 | 0.401 |
| **Track 2, C (deployed)** | **+ first 5 comments** | 10% | **0.842 ± 0.015** | **0.423** |

Track 2 values are averages over 5 random train/test splits. Tracks 1 and 2 use different targets (22% vs. 10% toxic), so compare F1 only within a track.

**As a triage tool:** the 10% of threads the model ranks riskiest are 33% toxic, versus a 10% base rate, and contain a third of all toxic threads.

See [`ML/ML_README.md`](ML/ML_README.md) for the full methodology.

## Quick start

**Reproduce the model:** put `reddit_posts.csv` in `ML/` (the data is not included in this repo), install the dependencies, and run the notebooks in order:
```bash
pip install pandas numpy scikit-learn matplotlib joblib torch transformers tqdm langdetect
```
`data-cleaning` → `data-sampling` → `data-labeling` → `improve_target_and_features`

**Run the extension:** you need Node.js 18+, Python 3.11/3.12 and Chrome.
```bash
# Terminal 1: ML service
cd Toxicoa/Healthy_ML_3/backend/ml_service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8766

# Terminal 2: backend + parent portal (http://localhost:8787)
cd Toxicoa/Healthy_ML_3/backend
node server.js
```
Then load `Toxicoa/Healthy_ML_3/chrome-extension` at `chrome://extensions` (**Developer mode → Load unpacked**). Full instructions are in [`Toxicoa/README.md`](Toxicoa/README.md).

## Limitations

- **Labels come from a model,** not people. toxic-bert is English-only and can flag blunt but harmless language.
- **The deployed model needs 5 comments** before it can predict, so it can't score a brand-new thread.
- **Moderate accuracy:** it catches many toxic threads but also raises false alarms, so it's best for ranking threads for review rather than automatic blocking.
- **Prototype only:** the extension uses plain HTTP and simple file storage, and a teen can disable it. It isn't ready for real-world deployment.
- **Limited Domain:** our dataset covers a limited set of Reddit communities, which may reduce the model’s ability to generalize to other communities and platforms.

Domain-adaptation theory bounds target-domain error by source-domain error, distribution differences, and the minimum combined error:

$$
\epsilon_T(h) \leq \epsilon_S(h) + \frac{1}{2}d_{\mathcal{H}\Delta\mathcal{H}}(P_S^X,P_T^X) + \lambda_{\mathcal{H}}
$$

For Toxicoa, this means strong performance on sampled Reddit communities does not guarantee similar results elsewhere. We use this as a conceptual explanation, not a numerical guarantee, because the divergence and joint-error terms have not been estimated. Ben-David et al., 2010.
## Future work

1. Cross-check the toxicity labels with a second, independent AI model.
2. Replace logistic regression with transformer models trained on all 188k posts.
3. Test on teen-heavy communities and tune the Low / Medium / High levels on real data.
