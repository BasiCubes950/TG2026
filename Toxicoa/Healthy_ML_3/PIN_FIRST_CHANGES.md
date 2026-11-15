# Parent PIN-first review update

The child-facing review popup initially shows **only** a PIN entry form. The backend verifies the PIN before returning flagged title, description, sampled comments, or AI coaching tips. PIN success unlocks the *parent review*, not the Reddit post. The parent must then explicitly choose View or Block. Failed PIN checks share the existing server-side five-attempt lockout.

## Local installation
1. Stop the running backend (`Ctrl+C` in its terminal).
2. Replace your local `Reddit/backend` and `Reddit/chrome-extension` with the folders in this ZIP. **If you have modified these files since the earlier ZIP, back up your changes before replacing.**
3. Start backend again: `cd Reddit/backend && node server.js`.
4. At `chrome://extensions`, click **Reload** on Healthy Reddit, or load unpacked from this ZIP's `chrome-extension` folder.
5. Existing pairing should persist if reloading the same installed extension. Re-pair if you removed and reinstalled the extension.
6. Visit a flagged Reddit discussion. Clicking Ask Parent should display only the PIN form. Enter an incorrect PIN and verify no content appears. Enter the correct PIN and confirm content/tips become visible while Reddit remains covered. Click View to unblock, or Block for 30 days.

This is a **hackathon prototype**, not tamper-resistant parental control software. On shared devices a technical user with developer tools or extension privileges can bypass browser extensions; backend uses unencrypted HTTP on local Wi-Fi.
