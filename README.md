# Trivia Night

A live trivia quiz for parties. Players join on their own phones with a 4-digit
code or a QR scan — no account, no app, no email invite. The host runs the game
from one shared screen with live scoring and a leaderboard after every question.

## How it's built

- **Frontend** (`index.html`, `style.css`, `app.js`): a static page hosted on
  GitHub Pages. Polls the backend roughly every 1.2s for live state.
- **Backend** (`worker/`): a Cloudflare Worker with a Durable Object holding the
  single live game — current question, players, answers, scores. Runs on
  Cloudflare's free plan, no credit card required.

Scoring: faster correct answers score closer to 1000; any wrong answer scores 0.
The correct answer is never sent to players until the host reveals it.

## Hosting a game

Visit the site and add `#host` to the URL once, e.g.:
`https://<your-username>.github.io/trivia-night/#host`

Enter the host passphrase (see below) — it's then remembered on that device, so
you won't need to re-enter it next time you host from the same browser.

## Replacing the filler questions

Edit the `QUESTIONS` array in `worker/src/index.js`, then redeploy with
`wrangler deploy` from inside the `worker/` folder.

## One-time setup (already done for this deployment)

1. `wrangler login` — signs in to Cloudflare.
2. `wrangler secret put HOST_SECRET` — sets the host passphrase.
3. `wrangler deploy` — publishes the Worker and prints its `*.workers.dev` URL.
4. That URL gets pasted into `config.js` at the repo root.
5. GitHub Pages is enabled on this repo, serving from the root of `main`.
