"""Local Python ML prediction service. Run only with a .pkl from someone you trust.

POST /predict accepts title, body, first 5 comments, subreddit, date_posted,
community_members_num. Returns a class, raw margin, and exploratory risk bucket.
"""
import os
from pathlib import Path
from datetime import datetime, timezone
import numpy as np
import pandas as pd
import joblib
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
app = FastAPI(title="Healthy Reddit local model")
_model = None
_toxic = None

class Thread(BaseModel):
    title: str = ""
    body: str = ""
    comments: list[str] = Field(default_factory=list)
    community_name: str = "unknown"
    date_posted: str = ""
    community_members_num: float = 0

def model():
    global _model
    if _model is None:
        # SECURITY: joblib/pickle can execute arbitrary code; only load the teammate-verified model.
        _model = joblib.load(HERE / "reddit_toxicity_model.pkl")
        if not hasattr(_model, 'decision_function') or not hasattr(_model, 'predict'):
            raise RuntimeError('Model has no prediction interface')
    return _model

def toxicity_model():
    global _toxic
    if _toxic is None:
        from transformers import pipeline
        # Same model family specified in teammate's labeling notebook.
        _toxic = pipeline('text-classification', model='unitary/toxic-bert',
                          tokenizer='unitary/toxic-bert', device=-1)
    return _toxic

def text_score_batch(texts):
    # Score each early comment, not future comments; may download weights first time.
    results = toxicity_model()(list(texts), truncation=True, max_length=512, batch_size=5)
    scores=[]
    for r in results:
        s = float(r['score'])
        label=str(r['label']).lower()
        scores.append(s if label in ('toxic','label_1') else 1-s)
    return scores

def features(post, scores):
    try:
        dt=pd.to_datetime(post.date_posted, utc=True, errors='coerce')
    except Exception:
        dt=pd.NaT
    hour=str(dt.hour) if not pd.isna(dt) else '<NA>'
    weekday=str(dt.dayofweek) if not pd.isna(dt) else '<NA>'
    title, body=post.title or '',post.body or ''
    early=' \n '.join(post.comments[:5])
    return pd.DataFrame([{
       'post_text': title+' '+body,
       'early_text':early,
       'community_name':post.community_name or 'unknown',
       'post_hour':hour,'post_weekday':weekday,
       'title_words_log':float(np.log1p(len(title.split()))),
       'desc_words_log':float(np.log1p(len(body.split()))),
       'title_has_q':int('?' in title),
       'community_size_log':float(np.log1p(max(0,post.community_members_num))),
       'early_max':max(scores),
       'early_mean':float(np.mean(scores)),
       'early_n_toxic':sum(s>=0.5 for s in scores),
       'early_n_toxic_hi':sum(s>=0.8 for s in scores),
       'early_chars_log':float(np.log1p(len(early))),
    }])

@app.get('/health')
def health():
    return {'ok':True,'model_file_present':(HERE/'reddit_toxicity_model.pkl').exists(),
            'model_loaded':_model is not None,'toxic_bert_loaded':_toxic is not None}

@app.post('/predict')
def predict(post: Thread):
    if len(post.comments)<5:
        raise HTTPException(422,'Need five early comments for this model')
    try:
        scores=text_score_batch(post.comments[:5])
        clf=model()
        x=features(post,scores)
        margin=float(clf.decision_function(x)[0])
        threshold=float(getattr(clf,'reddit_threshold_',0.0))
        predicted=bool(margin >= threshold)
        excess=margin-threshold
        # Three illustrative tiers based on decision margins (NOT calibrated probabilities).
        bucket=('safe' if not predicted else
                'low' if excess < 1.0 else 'medium' if excess < 2.0 else 'high')
        return {'bucket':bucket,'predicted_toxic':predicted,
                'margin':margin,'decision_threshold':threshold,
                'score':float(1/(1+np.exp(-np.clip(excess,-30,30)))),
                'early_comment_scores':scores,'source':'trained_logistic_regression',
                'note':'Score is not calibrated probability; buckets need validation.'}
    except Exception as e:
        # Local prototype: expose useful error information in Python server logs only.
        import traceback; traceback.print_exc()
        raise HTTPException(503,'Python model could not score this thread; see Python terminal')
