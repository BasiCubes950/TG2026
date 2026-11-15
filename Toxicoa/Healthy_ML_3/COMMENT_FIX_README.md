# Comment extraction fix (v0.2.2)

This release addresses `Not enough visible comments for prediction: 4` without changing the classifier, parent pairing, PIN, or 30-day rules.

**New extraction logic:** The extension first asks the background worker to retrieve comments from Reddit's JSON endpoint using `sort=old`, then orders available comments by timestamp and selects the first five. If Reddit blocks or limits JSON, the extension falls back to looking at **all** visible comments, including nested replies, and waits up to 6.5 seconds for them to render. Deleted/removed text is ignored.

**Limitations:** JSON may be inaccessible or incomplete, and the earliest five available comments may differ from the historical first five used for training. Threads with fewer than five accessible comments still display the safety-check error rather than silently exposing content. Feed cards remain unscanned. The model and its severity thresholds are unchanged.

## Install

1. Back up your existing project. If using the complete ZIP, preserve your current backend storage records (for example `data.json`) and any local configuration before copying. **You only need to replace the `chrome-extension/` code for this fix.**
2. Copy the new files into the same local extension directory currently loaded by Chrome (including the new `comment-fetch.js`), or point the existing extension installation to the new directory. Do not click Remove on the old extension if you want pairing to persist.
3. At `chrome://extensions`, click **Reload**; refresh the Reddit thread.
4. Keep the existing Node (`8787`) and Python (`8766`) servers running. Since backend files did not change, neither server needs a restart.
5. Check Node terminal for `[ML prediction]` and Python terminal for `POST /predict ... 200 OK`. If Reddit JSON is blocked and the DOM has fewer than five comments, the safety overlay remains in place.

**Safety:** The extension requests comment data directly from reddit.com, not from another third-party site. A server health check alone does not establish successful model inference.
