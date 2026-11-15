# ML: Predicting which Reddit threads turn toxic

The project goal is to predict toxicity **before** a discussion becomes toxic, rather than detecting it after the fact. This folder contains the machine-learning pipeline. It builds a labeled dataset of Reddit posts and trains classifiers that predict whether a thread will attract toxic comments.

There are two modeling tracks:

1. **Baseline:** predict from the post's **title and description alone**.
2. **Improved:** add community and timing metadata plus the thread's **first five comments**, and use a stricter, cleaner target.

There are no human annotations. Comment-level toxicity is scored by a pretrained model (`unitary/toxic-bert`), and a post's label is derived from those scores. Every result below measures agreement with model-generated labels, not verified toxicity.

## Pipeline

```
reddit_posts.csv                     raw export, one row per post, comments nested as JSON
      |  data-cleaning.ipynb
      v
reddit_text_only.csv                 188,140 posts: title, description, comments (JSON list of strings)
      |  data-sampling.ipynb
      v
reddit_text_10000.csv                random sample of 10,000 posts
      |  data-labeling.ipynb         scores every comment with toxic-bert
      v
reddit_text_10000_labeled.csv        adds comment_toxicity and num_toxic_comments
      |
      +--> classifier.ipynb, classifier_svm_10000_results.ipynb, embeddings_svm_10000_results.ipynb
      |        (Track 1: baseline, text only)
      |
      +--> improve_target_and_features.ipynb        (also reads reddit_posts.csv for metadata)
               (Track 2: improved model)  -->  reddit_text_10000_features.csv
                                               reddit_toxicity_deployment.pkl
                                               reddit_toxicity_model.pkl, reddit_threshold.pkl
```

## Notebooks

| Notebook | What it does |
| `data-cleaning.ipynb` | Keeps posts with at least 3 stored top-level comments. Drops posts whose title or description is empty or `[removed]`/`[deleted]`. Flattens each post's comments and replies into one list of comment texts sorted by time (comments without a timestamp go last). Writes `reddit_text_only.csv`. |
| `data-sampling.ipynb` | Draws a random sample of 10,000 posts into `reddit_text_10000.csv`. |
| `data-labeling.ipynb` | Scores each comment individually with `unitary/toxic-bert` (max 128 tokens). Writes `comment_toxicity` (a JSON list of probabilities aligned one-to-one with `comments`) and `num_toxic_comments` (scores >= 0.5). Includes a check that every score lines up with its comment. Runs on CUDA, Apple MPS, or CPU. |
| `classifier.ipynb` | Track 1. Builds the post-level target, then trains and tunes a linear SVM on TF-IDF features. Also compares logistic regression, Complement Naive Bayes, SGD logistic regression, and a small neural network. |
| `classifier_svm_10000_results.ipynb` | Track 1. The TF-IDF SVM experiment on the full 10,000-post sample, with saved results. |
| `embeddings_svm_10000_results.ipynb` | Track 1. Compares TF-IDF with frozen sentence embeddings (`all-MiniLM-L6-v2`) feeding the same SVM. |
| `improve_target_and_features.ipynb` | Track 2. Joins metadata back from the raw CSV, drops non-English posts, builds early-comment features and the cleaner target, compares three feature sets with repeated splits, and exports the trained model. |

## Data

The CSV files are not stored in this repository. To reproduce, put `reddit_posts.csv` in this folder and run the notebooks in the order above. Each notebook reads and writes its files in the current directory (or in a `Reddit/` folder at the repository root).

| File | Rows | Columns |
|---|---|---|
| `reddit_text_only.csv` | 188,140 | `title`, `description`, `comments` |
| `reddit_text_10000.csv` | 10,000 | same |
| `reddit_text_10000_labeled.csv` | 10,000 | adds `comment_toxicity`, `num_toxic_comments` |
| `reddit_text_10000_features.csv` | 7,391 | modeling table written by Track 2 |

Labeling the 10,000-post sample scored 156,315 comments, of which 9,192 (5.9%) were at or above the 0.5 toxicity threshold. The sample spans many communities, but the eight largest (including `personalfinance`, `TrueUnpopularOpinion`, `PersonalFinanceCanada`, and `AmItheAsshole`) make up about 31% of it.

## Track 1: baseline (post text only)

- **Target.** `toxic_index = 1` if at least 10% of a post's comments score >= 0.5. This gives 2,224 positive and 7,776 negative posts (22% positive).
- **Input.** `title + description`. Comments and toxicity scores are excluded from the input because they define the target.
- **Split.** 80% train / 20% test (7,999 / 2,001 posts), stratified, with duplicate texts kept on the same side. Seed 42.
- **Tuning.** 3-fold stratified group cross-validation on the training set only, selecting by toxic-class F1. For the SVM, 32 configurations were searched. The best was unigrams, `min_df=2`, `C=0.01`, balanced class weights.

**Results** (2,001 held-out posts, 444 of them toxic-thread):

| Model | Accuracy | Balanced accuracy | Toxic precision | Toxic recall | Toxic F1 |
|---|---|---|---|---|---|
| Always predict "not toxic" | 0.778 | 0.500 | n/a | 0.00 | 0.000 |
| TF-IDF SVM (default settings) | 0.780 | 0.685 | 0.504 | 0.514 | 0.509 |
| TF-IDF SVM (tuned) | 0.731 | 0.740 | 0.439 | 0.757 | 0.555 |
| MiniLM embeddings + SVM | 0.722 | 0.734 | 0.428 | 0.755 | 0.546 |

Cross-validation F1 was 0.520 for the tuned TF-IDF SVM and 0.539 for the embedding SVM, so the two are roughly tied. The tuned models catch about three in four toxic-thread posts, but more than half of what they flag is a false alarm. Accuracy is misleading here because always predicting "not toxic" already scores 77.8%.

## Track 2: improved model (metadata, early comments, cleaner target)

**What changed**

- **More information.** Community name, community size, posting hour and weekday, and title and description length are joined back from the raw CSV (matched on normalized title and description; 100% of posts matched). The first **5 comments** of each thread (their text and toxicity scores) are also used as features.
- **Target built only from later comments.** The comments after the first five define the label, so features and label never share a comment. A post is toxic if at least 2 of its later comments score >= 0.8 **and** they make up at least 10% of its later comments. A single borderline comment no longer flips a post.
- **English only.** 528 posts detected as another language are dropped, because `toxic-bert` is English-only. Short or unclear text is kept.
- **Eligibility.** A post needs at least 10 comments (5 early plus 5 later) to get a label.

**Data after filtering:** 10,000 posts, then 9,472 after the language filter, then 7,391 with at least 10 comments. The positive rate is 10.1% (743 posts). The split is 5,917 train / 1,474 test posts.

**How the toxic rate depends on the rule** (share of posts labeled toxic, with the 10% share requirement fixed):

| Comment score cutoff | at least 1 toxic comment | at least 2 | at least 3 |
|---|---|---|---|
| 0.5 | 23.4% | 18.5% | 9.0% |
| 0.8 | 13.3% | **10.1%** | 3.7% |
| 0.9 | 8.7% | 6.2% | 1.9% |

**Results.** Mean and standard deviation over 5 different train/test splits. Lift is average precision divided by the positive rate (1.0 means no better than guessing); a random ranking has ROC-AUC 0.5.

| Features | ROC-AUC | Average precision | Lift | F1 |
|---|---|---|---|---|
| A: post text only | 0.807 ± 0.013 | 0.302 ± 0.028 | 3.0 | 0.376 ± 0.027 |
| B: + community, time, length | 0.824 ± 0.016 | 0.324 ± 0.019 | 3.2 | 0.401 ± 0.021 |
| C: + first 5 comments | **0.842 ± 0.015** | **0.349 ± 0.024** | 3.5 | **0.423 ± 0.020** |

Each step helps, and the full gain from A to C (about +0.035 ROC-AUC) is more than twice the split-to-split spread. The individual A to B and B to C steps are each about one spread, so treat them as suggestive.

**Operating point of the exported model** (one split, 1,474 test posts, decision threshold chosen on training data only): precision 0.34, recall 0.45, F1 0.38, accuracy 0.86 (always predicting "not toxic" scores 0.90).

**Ranking threads for review.** Sorting test posts by the model's score, the top 5% are 39.7% toxic (against a 10.0% base rate) and contain 20% of all toxic threads. The top 10% are 33.3% toxic and contain 33% of them, and the top 20% are 28.9% toxic and contain 57%. This is the more useful framing than a hard yes/no flag.

**What drives predictions.** In the full model, political terms (for example `trump` in the post text) and some news and politics communities push predictions toward toxic. Help-seeking and personal-finance communities (`UKPersonalFinance`, `PersonalFinanceCanada`) and polite early replies (`thank`, `interested`) push toward calm. These are associations in model-labeled data, not causal claims.

**Track 1 and Track 2 numbers are not directly comparable.** The targets differ (22% vs 10% positive), so F1 and accuracy are not on the same scale. Compare ROC-AUC or lift once you compute them for the baseline.

**Important:** Track 2 predicts toxicity *after the first five comments have arrived*, not from the title alone. It cannot score a brand-new thread.

## Using the exported model

`improve_target_and_features.ipynb` writes `reddit_toxicity_deployment.pkl`, the full model (feature set C). The decision threshold chosen on training data (about 0.255) is stored on the model as `reddit_threshold_`.

```python
import joblib
model = joblib.load("reddit_toxicity_deployment.pkl")
scores = model.decision_function(features)          # features: a DataFrame with the columns below
flagged = scores >= model.reddit_threshold_
```

`features` needs one row per thread with these columns, built exactly as in steps 2 to 4 of the notebook:

- `post_text` (title + " " + description), `community_name`, `post_hour`, `post_weekday` (as text), `title_words_log`, `desc_words_log`, `title_has_q`, `community_size_log`
- `early_text` (the first 5 comments joined), and from toxic-bert scores of those comments: `early_max`, `early_mean`, `early_n_toxic` (scores >= 0.5), `early_n_toxic_hi` (scores >= 0.8), `early_chars_log`

The notebook also saves `reddit_toxicity_model.pkl` and `reddit_threshold.pkl`. Note that `reddit_threshold.pkl` holds the **comment-level** cutoff (0.8) used to define the target. It is not the classifier's decision threshold, so don't compare model scores against it. Use `model.reddit_threshold_`.

## Setup

```
pip install pandas numpy scikit-learn matplotlib joblib torch transformers tqdm langdetect
```

Run the notebooks from this folder in the order shown in the pipeline. The first run of `data-labeling.ipynb` and `embeddings_svm_10000_results.ipynb` downloads model weights from Hugging Face. A GPU (CUDA or Apple MPS) is strongly recommended for labeling.

## Limitations

- **Labels are model-generated.** `toxic-bert` is trained on English text and can flag blunt but non-abusive language. Comments are scored in isolation, without the parent comment or the post.
- **Small-thread noise.** In Track 1, a post with 10 comments or fewer becomes positive from a single flagged comment. Track 2 reduces this but does not remove it.
- **Limited scope.** Track 2 covers only English posts with at least 10 stored comments, and only the comments stored in the export are scored.
- **Skewed sample.** A handful of communities dominate the 10,000-post sample, so results may not transfer to other communities.
- **Moderate signal.** Even the best model flags many false alarms, so it is a triage tool for ranking threads for human review, not an automated enforcement system. It can also be unfair to dialects, sarcasm, and sensitive but legitimate discussions.

## Reproducibility notes

- In `improve_target_and_features.ipynb`, the repeated-split cell overwrites `train_mask` and `test_mask`. Any later cell that trains or evaluates a model must reset **both** masks first and confirm the two sets share no posts.

## Next steps

- Replace the TF-IDF text features in Track 2 with sentence embeddings, or try a gradient-boosted model.
- Label more than 10,000 posts, and check a sample of flagged threads by hand to estimate how often the toxicity labels are wrong.
- Tune the class weights and decision threshold on cross-validated training data only, and report ROC-AUC and average precision alongside F1.
- Add a small human-labeled validation set to measure label quality directly.