#!/usr/bin/env python3
"""Train a multilingual early Reddit thread toxicity predictor.

Expected CSV columns (headers optional):
 title, description, comments, toxicity_scores, label

Comments and toxicity_scores are CSV-quoted serialized lists. Comments must
already be in chronological order; first three comments are input, later ones
are label-only. Existing label is ignored to prevent ambiguous target semantics.

Example:
 python XLM-RoBERTa_baseline.py train --csv reddit.csv --out model_dir
 python XLM-RoBERTa_baseline.py predict --out model_dir --title '...' --description '...' --comments '["one", "two", "three"]'
"""
import argparse
import ast
import json
import os
import random
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from sklearn.metrics import (average_precision_score, classification_report,
                             confusion_matrix, f1_score, precision_score,
                             recall_score, roc_auc_score)
from sklearn.model_selection import train_test_split
from transformers import (AutoModelForSequenceClassification, AutoTokenizer,
                          DataCollatorWithPadding, Trainer, TrainingArguments,
                          set_seed)
from datasets import Dataset

COLS = ["title", "description", "comments", "toxicity_scores", "original_label"]


def parse_list(x):
    if isinstance(x, list):
        return x
    if not isinstance(x, str) or not x.strip():
        return None
    try:
        v = json.loads(x)
    except (ValueError, TypeError):
        try:
            v = ast.literal_eval(x)
        except (ValueError, SyntaxError):
            return None
    return v if isinstance(v, list) else None


def read_csv(path, has_header):
    # Python CSV parser handles escaped double quotes like ""sicuro"".
    if has_header:
        df = pd.read_csv(path, dtype=str, keep_default_na=False)
        renames = {
            "Title": "title", "Description": "description",
            "Comments": "comments", "scores": "toxicity_scores",
            "toxic_scores": "toxicity_scores", "toxicity_probs": "toxicity_scores",
            "comment_toxicity_scores": "toxicity_scores",
            "comment_toxicity": "toxicity_scores",
        }
        df = df.rename(columns=renames)
        if "toxicity_scores" not in df.columns:
            raise ValueError("Could not find a toxicity_scores column. Rename the scores column or use --no-header.")
        missing = [x for x in ("title", "description", "comments") if x not in df.columns]
        if missing:
            raise ValueError(f"Missing columns: {missing}")
    else:
        df = pd.read_csv(path, header=None, names=COLS, dtype=str, keep_default_na=False)
    return df


def make_example(row, min_future, comment_threshold, thread_threshold):
    comments = parse_list(row["comments"])
    scores = parse_list(row["toxicity_scores"])
    if comments is None or scores is None or len(comments) != len(scores):
        return None
    if len(comments) < 3 + min_future:
        return None
    if not all(isinstance(c, str) and c.strip() for c in comments[:3]):
        return None
    try:
        scores = [float(s) for s in scores]
    except (TypeError, ValueError):
        return None
    if not all(np.isfinite(s) and 0 <= s <= 1 for s in scores):
        return None

    future = np.asarray(scores[3:], dtype=float)
    future_count = int(np.sum(future >= comment_threshold))
    future_ratio = future_count / len(future)
    y = int(future_ratio >= thread_threshold)
    title = str(row["title"]).strip()
    desc = str(row["description"]).strip()
    # Explicit markers identify the components. Do NOT include future comments or scores.
    input_text = (f"TITLE: {title}\nDESCRIPTION: {desc}\n"
                  f"COMMENT 1: {comments[0]}\nCOMMENT 2: {comments[1]}\n"
                  f"COMMENT 3: {comments[2]}")
    return {
        "text": input_text, "labels": y, "future_toxic_ratio": future_ratio,
        "future_comment_count": len(future), "future_toxic_count": future_count
    }


def safe_split(df, seed, test_size):
    counts = df["labels"].value_counts()
    if len(counts) != 2 or counts.min() < 3:
        raise ValueError(f"Need both classes with >=3 samples. Label counts: {counts.to_dict()}. Try changing --thread-threshold.")
    try:
        tr, te = train_test_split(df, test_size=test_size, random_state=seed,
                                  stratify=df["labels"])
    except ValueError as e:
        raise ValueError(f"Stratified split failed: {e}") from e
    return tr.reset_index(drop=True), te.reset_index(drop=True)


def metrics_from_scores(y, p, threshold):
    pred = (p >= threshold).astype(int)
    result = {
        "threshold": float(threshold), "precision": float(precision_score(y, pred, zero_division=0)),
        "recall": float(recall_score(y, pred, zero_division=0)),
        "f1": float(f1_score(y, pred, zero_division=0)),
        "confusion_matrix": confusion_matrix(y, pred, labels=[0, 1]).tolist(),
    }
    if len(np.unique(y)) == 2:
        result["pr_auc_average_precision"] = float(average_precision_score(y, p))
        result["roc_auc"] = float(roc_auc_score(y, p))
    return result


def predict_probabilities(trainer, dataset):
    logits = trainer.predict(dataset).predictions
    logits = logits[0] if isinstance(logits, tuple) else logits
    logits = np.asarray(logits, dtype=float)
    shift = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shift)
    return (exp / exp.sum(axis=1, keepdims=True))[:, 1]


def prepared_splits(args):
    """Read the exported future-only labels and preserve the external test set."""
    from sklearn.model_selection import train_test_split
    dataset_dir = Path(args.csv).resolve().parent
    if not (dataset_dir / "manifest.json").exists():
        dataset_dir = Path(__file__).resolve().parent / "balanced_early_toxicity"
    manifest = json.loads((dataset_dir / "manifest.json").read_text())
    args.comment_threshold = manifest["comment_score_threshold"]
    args.thread_threshold = manifest["future_ratio_threshold"]
    args.min_future = manifest["minimum_future_comments"]

    def load(path):
        frame = pd.read_csv(path, keep_default_na=False)
        required = {"title", "description", "early_comments", "future_toxic_index",
                    "future_toxic_ratio", "future_comment_count", "group_id", "source_row"}
        if not required.issubset(frame):
            raise ValueError(f"Missing prepared columns: {required - set(frame.columns)}")
        texts = []
        for row in frame.to_dict("records"):
            comments = parse_list(row["early_comments"])
            if comments is None or len(comments) != 3 or not all(isinstance(c, str) and c.strip() for c in comments):
                raise ValueError("early_comments must contain exactly three nonempty strings")
            texts.append(f"TITLE: {row['title']}\nDESCRIPTION: {row['description']}\n"
                         + "\n".join(f"COMMENT {i+1}: {c}" for i, c in enumerate(comments)))
        frame["text"] = texts
        frame["labels"] = pd.to_numeric(frame["future_toxic_index"], errors="raise")
        if not frame.labels.isin([0, 1]).all():
            raise ValueError("Invalid binary labels")
        expected = (frame.future_toxic_ratio >= args.thread_threshold).astype(int)
        if not expected.equals(frame.labels.astype(int)):
            raise ValueError("Prepared labels disagree with manifest threshold")
        return frame

    balanced = load(args.csv)
    full = load(dataset_dir / "train_full.csv")
    test = load(dataset_dir / "test_natural.csv")
    if not set(balanced.source_row).issubset(set(full.source_row)):
        raise ValueError("Balanced rows must belong to full training pool")
    group_labels = full.groupby("group_id")["labels"].max()
    _, val_groups = train_test_split(group_labels.index.to_numpy(), test_size=0.125,
                                    stratify=group_labels, random_state=args.seed)
    val = full.loc[full.group_id.isin(val_groups)].copy()
    available = balanced.loc[~balanced.group_id.isin(val_groups)]
    n = int(available.labels.value_counts().reindex([0, 1], fill_value=0).min())
    if n == 0:
        raise ValueError("Both training classes required")
    train_df = pd.concat([available.loc[available.labels == label].sample(n=n, random_state=args.seed)
                          for label in [0, 1]]).sample(frac=1, random_state=args.seed)
    for left, right in [(train_df, val), (train_df, test), (val, test)]:
        if set(left.group_id) & set(right.group_id):
            raise ValueError("Overlapping groups across splits")
    return tuple(frame.reset_index(drop=True) for frame in (train_df, val, test))


def train(args):
    set_seed(args.seed)
    headers = pd.read_csv(args.csv, nrows=0).columns
    prepared = "early_comments" in headers and "future_toxic_index" in headers
    if prepared:
        train_df, val, test = prepared_splits(args)
    else:
        df = read_csv(args.csv, args.has_header)
        examples = []
        for row in df.to_dict("records"):
            ex = make_example(row, args.min_future, args.comment_threshold, args.thread_threshold)
            if ex is not None:
                examples.append(ex)
        df = pd.DataFrame(examples)
        if df.empty:
            raise ValueError("No usable threads. Check CSV format, score lengths, and --min-future.")
        print(f"Valid threads: {len(df):,}; discarded: {len(read_csv(args.csv, args.has_header)) - len(df):,}")
        print("Class distribution:", df["labels"].value_counts().to_dict())
        train_val, test = safe_split(df, args.seed, 0.10)
        train_df, val = safe_split(train_val, args.seed, 1/9)  # overall 80/10/10
    os.makedirs(args.out, exist_ok=True)

    print("Train/validation/test:", len(train_df), len(val), len(test))
    for name, frame in [("train", train_df), ("validation", val), ("test", test)]:
        print(name, "class counts:", frame.labels.value_counts().to_dict())
    print("Future ratio threshold:", args.thread_threshold)
    if args.prepare_only:
        for name, frame in [("train", train_df), ("validation", val), ("test", test)]:
            frame.to_csv(os.path.join(args.out, name + "_prepared.csv"), index=False)
        print("Prepared splits verified; model training skipped.")
        return

    tok = AutoTokenizer.from_pretrained(args.model)
    def tokenize(batch):
        return tok(batch["text"], truncation=True, max_length=args.max_length)
    def as_dataset(frame):
        ds = Dataset.from_pandas(frame[["text", "labels"]], preserve_index=False)
        return ds.map(tokenize, batched=True, remove_columns=["text"])
    ds_train, ds_val, ds_test = map(as_dataset, (train_df, val, test))
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model, num_labels=2, id2label={0: "LOW_FUTURE_TOXICITY", 1: "HIGH_FUTURE_TOXICITY"},
        label2id={"LOW_FUTURE_TOXICITY": 0, "HIGH_FUTURE_TOXICITY": 1}
    )

    def evaluate(pred):
        logits, labels = pred
        logits = np.asarray(logits)
        pred_labels = np.argmax(logits, axis=-1)
        return {"f1": float(f1_score(labels, pred_labels, zero_division=0)),
                "precision": float(precision_score(labels, pred_labels, zero_division=0)),
                "recall": float(recall_score(labels, pred_labels, zero_division=0))}

    training_args = TrainingArguments(
        output_dir=os.path.join(args.out, "checkpoints"),
        learning_rate=args.lr,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.eval_batch_size,
        gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs,
        weight_decay=0.01,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="f1",
        greater_is_better=True,
        save_total_limit=2,
        fp16=torch.cuda.is_available(),
        report_to="none",
        seed=args.seed,
    )
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=ds_train,
        eval_dataset=ds_val,
        processing_class=tok,
        data_collator=DataCollatorWithPadding(tok),
        compute_metrics=evaluate,
    )
    trainer.train()

    # Select classification threshold on validation set ONLY.
    p_val = predict_probabilities(trainer, ds_val)
    y_val = val["labels"].to_numpy()
    thresholds = np.linspace(0.05, 0.95, 91)
    best_threshold = float(max(thresholds,
                               key=lambda th: f1_score(y_val, p_val >= th, zero_division=0)))
    val_metrics = metrics_from_scores(y_val, p_val, best_threshold)
    p_test = predict_probabilities(trainer, ds_test)
    y_test = test["labels"].to_numpy()
    test_metrics = metrics_from_scores(y_test, p_test, best_threshold)

    saved_model = os.path.join(args.out, "model")
    trainer.save_model(saved_model)
    tok.save_pretrained(saved_model)
    settings = {
        "base_model": args.model, "comment_threshold": args.comment_threshold,
        "thread_threshold": args.thread_threshold, "min_future": args.min_future,
        "prediction_threshold": best_threshold, "max_length": args.max_length,
        "train_size": len(train_df), "val_size": len(val), "test_size": len(test),
        "validation_metrics": val_metrics, "test_metrics": test_metrics,
    }
    with open(os.path.join(args.out, "results.json"), "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
    test_out = test[["labels", "future_toxic_ratio", "future_comment_count"]].copy()
    test_out["predicted_probability"] = p_test
    test_out["predicted_label"] = (p_test >= best_threshold).astype(int)
    test_out.to_csv(os.path.join(args.out, "test_predictions.csv"), index=False)
    print("Validation:", json.dumps(val_metrics, indent=2))
    print("Test:", json.dumps(test_metrics, indent=2))
    print("Model saved to", saved_model)


def predict(args):
    with open(os.path.join(args.out, "results.json"), encoding="utf-8") as f:
        settings = json.load(f)
    comments = parse_list(args.comments)
    if comments is None or len(comments) < 3 or not all(isinstance(c, str) for c in comments[:3]):
        raise ValueError("--comments must be a JSON list of at least 3 comment strings, in chronological order")
    text = (f"TITLE: {args.title}\nDESCRIPTION: {args.description}\n"
            f"COMMENT 1: {comments[0]}\nCOMMENT 2: {comments[1]}\nCOMMENT 3: {comments[2]}")
    model_dir = os.path.join(args.out, "model")
    tok = AutoTokenizer.from_pretrained(model_dir)
    model = AutoModelForSequenceClassification.from_pretrained(model_dir)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device).eval()
    batch = tok(text, return_tensors="pt", truncation=True,
                max_length=settings["max_length"]).to(device)
    with torch.inference_mode():
        p = float(torch.softmax(model(**batch).logits, dim=-1)[0, 1].item())
    threshold = settings["prediction_threshold"]
    print(json.dumps({"probability_future_ratio_at_least_threshold": p,
                      "future_ratio_threshold": settings["thread_threshold"],
                      "decision_threshold": threshold, "predicted_label": int(p >= threshold)},
                     indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    tr = sub.add_parser("train")
    tr.add_argument("--csv", required=True)
    tr.add_argument("--prepare-only", action="store_true", help="Validate/export splits without downloading or training a model")
    tr.add_argument("--out", default="reddit_toxicity_model")
    tr.add_argument("--has-header", action="store_true", help="Set if CSV has column names")
    tr.add_argument("--model", default="xlm-roberta-base", help="Multilingual model for Italian/English threads")
    tr.add_argument("--comment-threshold", type=float, default=0.5)
    tr.add_argument("--thread-threshold", type=float, default=0.20)
    tr.add_argument("--min-future", type=int, default=10)
    tr.add_argument("--max-length", type=int, default=512)
    tr.add_argument("--batch-size", type=int, default=8)
    tr.add_argument("--eval-batch-size", type=int, default=16)
    tr.add_argument("--grad-accum", type=int, default=4)
    tr.add_argument("--epochs", type=float, default=3)
    tr.add_argument("--lr", type=float, default=2e-5)
    tr.add_argument("--seed", type=int, default=42)
    pr = sub.add_parser("predict")
    pr.add_argument("--out", default="reddit_toxicity_model")
    pr.add_argument("--title", required=True)
    pr.add_argument("--description", default="")
    pr.add_argument("--comments", required=True, help="JSON list of comments, first 3 used")
    args = parser.parse_args()
    if args.command == "train":
        train(args)
    else:
        predict(args)


if __name__ == "__main__":
    main()
