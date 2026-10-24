(function () {
  "use strict";

  var WORKER_URL = (window.TRIVIA_CONFIG && window.TRIVIA_CONFIG.WORKER_URL || "").replace(/\/$/, "");
  var POLL_MS = 1200;

  var SHAPES = [
    '<svg class="shape" viewBox="0 0 24 24"><polygon points="12,3 21,20 3,20" fill="currentColor"/></svg>',
    '<svg class="shape" viewBox="0 0 24 24"><polygon points="12,2 22,12 12,22 2,12" fill="currentColor"/></svg>',
    '<svg class="shape" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor"/></svg>',
    '<svg class="shape" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3" fill="currentColor"/></svg>'
  ];

  var app = document.getElementById("app");

  var playerId = localStorage.getItem("trivia_player_id") || null;
  var hostSecret = localStorage.getItem("trivia_host_secret") || null;
  var isHost = false;
  var hostVerifying = !!hostSecret;

  var state = null;       // last server /api/state response
  var clockOffset = 0;    // serverNow - Date.now() at last poll
  var loadError = false;
  var lastStateSignature = null;

  function stateSignature(s) {
    if (!s) return "null";
    var copy = Object.assign({}, s);
    delete copy.serverNow; // changes every poll; not a real state change
    return JSON.stringify(copy);
  }

  var ui = {
    pinOk: false,
    pinDraft: "",
    pinError: "",
    nameDraft: "",
    joining: false,
    joinError: "",
    submitting: false,
    submitError: "",
    hostPassDraft: "",
    hostPassError: "",
    tickHandle: null,
    qrRenderedFor: null
  };

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function now() {
    return Date.now() + clockOffset;
  }

  async function api(path, opts) {
    var res = await fetch(WORKER_URL + path, opts);
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(body.error || "Request failed");
    return body;
  }

  // ---------- render ----------

  function render(fromPoll) {
    if (fromPoll && document.activeElement && app.contains(document.activeElement) && document.activeElement.matches("input[data-field]")) {
      return; // don't blow away a form the user is actively typing into
    }
    if (!WORKER_URL || WORKER_URL.indexOf("YOUR-SUBDOMAIN") !== -1) {
      app.innerHTML = renderNotConfigured();
      return;
    }
    if (loadError && !state) {
      app.innerHTML = renderConnectionError();
      return;
    }
    if (!state) {
      app.innerHTML = '<div class="panel center"><p class="muted">Loading Trivia Night…</p></div>';
      return;
    }
    if (!isHost && window.location.hash === "#host" && !state.players.some(function (p) { return p.id === playerId; })) {
      app.innerHTML = renderHostLogin();
      return;
    }
    if (isHost) {
      app.setAttribute("data-host", "true");
      app.innerHTML = renderHost();
    } else {
      app.removeAttribute("data-host");
      app.innerHTML = renderPlayer();
    }
    startOrStopTicker();
    if (isHost && state.phase === "lobby") renderQrIfNeeded();
  }

  function renderNotConfigured() {
    return '<div class="panel center"><h2 class="display" style="font-size:22px;">Trivia Night</h2>' +
      '<p class="muted" style="margin-top:12px;">This page isn\'t connected to a game server yet. Edit config.js with your deployed Worker URL.</p></div>';
  }

  function renderConnectionError() {
    return '<div class="panel center"><h2 class="display" style="font-size:22px;">Trivia Night</h2>' +
      '<p class="muted" style="margin-top:12px;">Can\'t reach the game server right now. Trying again…</p></div>';
  }

  // ---------- HOST ----------

  function renderHost() {
    var header = '<div class="row between">' +
      '<div><span class="eyebrow">Hosting</span><h1 class="display" style="font-size:28px; margin-top:4px;">Trivia Night</h1></div>' +
      '<button class="btn btn-ghost" data-action="host-newgame">New game</button>' +
      '</div>';

    var body = "";
    if (state.phase === "lobby") body = renderHostLobby();
    else if (state.phase === "question") body = renderHostQuestion();
    else if (state.phase === "reveal") body = renderHostReveal();
    else if (state.phase === "leaderboard") body = renderHostLeaderboard();
    else if (state.phase === "final") body = renderHostFinal();

    return header + body;
  }

  function joinUrl() {
    try {
      var u = new URL(window.location.href);
      u.hash = "";
      u.searchParams.set("pin", state.pin);
      return u.toString();
    } catch (e) {
      return window.location.href;
    }
  }

  function renderHostLobby() {
    return '<div class="panel center">' +
      '<span class="eyebrow">Scan or enter code to join</span>' +
      '<div class="pin-display" style="margin-top:6px;">' + esc(state.pin) + '</div>' +
      '<div id="qr-box" style="margin-top:16px;"></div>' +
      '<p class="muted" style="margin-top:14px;">Players open the link, enter this code, pick a nickname, and join below.</p>' +
      '<button class="btn" style="margin-top:10px;" data-action="host-copylink">Copy join link</button>' +
      '</div>' +
      '<div class="panel">' +
      '<div class="row between"><h3>Players</h3><span class="pill">' + state.players.length + ' joined</span></div>' +
      '<div class="players-list" style="margin-top:14px;">' +
      (state.players.length
        ? state.players.map(function (p) { return '<div class="player-row"><span>' + esc(p.name) + '</span></div>'; }).join("")
        : '<p class="muted">Waiting for players…</p>') +
      '</div>' +
      '<button class="btn btn-accent btn-block" style="margin-top:18px;" data-action="host-start" ' + (state.players.length ? "" : "disabled") + '>Start game</button>' +
      '</div>';
  }

  function renderHostQuestion() {
    var q = state.question;
    return '<div class="panel center">' +
      renderTimer() +
      '<p class="qcount" style="margin-top:12px;">QUESTION ' + (q.index + 1) + ' OF ' + q.total + '</p>' +
      '<h2 class="question-text" style="margin-top:8px;">' + esc(q.text) + '</h2>' +
      '</div>' +
      '<div class="panel">' +
      renderOptionTiles(q, { interactive: false }) +
      '<div class="row between" style="margin-top:18px;">' +
      '<span class="muted">' + state.players.length + ' players in this round</span>' +
      '<button class="btn btn-accent" data-action="host-reveal">Reveal answer</button>' +
      '</div>' +
      '</div>';
  }

  function renderHostReveal() {
    var q = state.question;
    return '<div class="panel center">' +
      '<p class="qcount">QUESTION ' + (q.index + 1) + ' OF ' + q.total + '</p>' +
      '<h2 class="question-text" style="margin-top:8px;">' + esc(q.text) + '</h2>' +
      '</div>' +
      '<div class="panel">' +
      renderOptionTiles(q, { interactive: false, reveal: true }) +
      '<button class="btn btn-accent btn-block" style="margin-top:14px;" data-action="host-leaderboard">Show leaderboard</button>' +
      '</div>';
  }

  function renderHostLeaderboard() {
    var isLast = state.question.index >= state.question.total - 1;
    return '<div class="panel">' +
      '<h2 class="display center" style="font-size:22px;">Leaderboard</h2>' +
      '<div class="players-list" style="margin-top:16px; max-height:none;">' + renderLeaderboardRows(state.leaderboard) + '</div>' +
      '<button class="btn btn-accent btn-block" style="margin-top:18px;" data-action="host-next">' +
      (isLast ? "Show final results" : "Next question") +
      '</button>' +
      '</div>';
  }

  function renderHostFinal() {
    return '<div class="panel">' +
      '<h2 class="display center" style="font-size:24px;">Final Results</h2>' +
      renderPodium(state.leaderboard) +
      '<div class="players-list" style="margin-top:20px; max-height:none;">' + renderLeaderboardRows(state.leaderboard) + '</div>' +
      '<button class="btn btn-block" style="margin-top:18px;" data-action="host-newgame">Start a new game</button>' +
      '</div>';
  }

  // ---------- host login ----------

  function renderHostLogin() {
    return '<div class="panel center">' +
      '<span class="eyebrow">Host login</span>' +
      '<h2 class="display" style="font-size:22px; margin-top:6px;">Enter the host passphrase</h2>' +
      '<form data-form="hostpass" class="col" style="margin-top:18px;">' +
      '<input type="text" name="trivia-host-passphrase" placeholder="Passphrase" data-field="hostpass" value="' + esc(ui.hostPassDraft) + '" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus>' +
      '<p class="muted" style="margin-top:8px; font-size:13px;">Typed: <span class="mono" id="hostpass-echo">' + esc(ui.hostPassDraft || "(empty)") + '</span></p>' +
      (ui.hostPassError ? '<p class="error-text">' + esc(ui.hostPassError) + '</p>' : "") +
      '<button class="btn btn-accent btn-block" type="submit">Continue</button>' +
      '</form>' +
      '</div>';
  }

  // ---------- PLAYER ----------

  function renderPlayer() {
    var myDoc = state.players.find(function (p) { return p.id === playerId; });

    if (!myDoc) return renderJoinScreen();

    if (state.phase === "lobby") return renderPlayerLobby(myDoc);
    if (state.phase === "question") return renderPlayerQuestion(myDoc);
    if (state.phase === "reveal") return renderPlayerReveal(myDoc);
    if (state.phase === "leaderboard") return renderPlayerLeaderboard(myDoc);
    if (state.phase === "final") return renderPlayerFinal(myDoc);
    return "";
  }

  function renderJoinScreen() {
    if (!ui.pinOk) {
      return '<div class="panel center">' +
        '<span class="eyebrow">Join game</span>' +
        '<h2 class="display" style="font-size:22px; margin-top:6px;">Enter the code</h2>' +
        '<form data-form="pin" class="col" style="margin-top:18px;">' +
        '<input class="pin-input" type="tel" inputmode="numeric" maxlength="4" placeholder="----" data-field="pin" value="' + esc(ui.pinDraft) + '">' +
        (ui.pinError ? '<p class="error-text">' + esc(ui.pinError) + '</p>' : "") +
        '<button class="btn btn-accent btn-block" type="submit">Continue</button>' +
        '</form>' +
        '</div>';
    }
    return '<div class="panel center">' +
      '<span class="eyebrow">Join game</span>' +
      '<h2 class="display" style="font-size:22px; margin-top:6px;">Pick a nickname</h2>' +
      '<form data-form="name" class="col" style="margin-top:18px;">' +
      '<input type="text" maxlength="20" placeholder="Nickname" data-field="name" value="' + esc(ui.nameDraft) + '" autofocus>' +
      (ui.joinError ? '<p class="error-text">' + esc(ui.joinError) + '</p>' : "") +
      '<button class="btn btn-accent btn-block" type="submit" ' + (ui.joining ? "disabled" : "") + '>' + (ui.joining ? "Joining…" : "Join") + '</button>' +
      '</form>' +
      '</div>';
  }

  function renderPlayerLobby(myDoc) {
    return '<div class="panel center">' +
      '<span class="eyebrow">You\'re in</span>' +
      '<h2 class="display" style="font-size:24px; margin-top:6px;">' + esc(myDoc.name) + '</h2>' +
      '<p class="muted" style="margin-top:10px;">Waiting for the host to start the game…</p>' +
      '<p class="muted" style="margin-top:6px;">' + state.players.length + ' players in the lobby</p>' +
      '</div>';
  }

  function renderPlayerQuestion() {
    var q = state.question;
    var mine = state.myAnswer;
    return '<div class="panel center">' +
      renderTimer() +
      '<p class="qcount" style="margin-top:12px;">QUESTION ' + (q.index + 1) + ' OF ' + q.total + '</p>' +
      '<h2 class="question-text" style="margin-top:8px;">' + esc(q.text) + '</h2>' +
      '</div>' +
      '<div class="panel">' +
      (mine
        ? '<p class="center muted">Answer locked in. Waiting for the host to reveal…</p>'
        : renderOptionTiles(q, { interactive: true })) +
      (ui.submitError ? '<p class="error-text center" style="margin-top:10px;">' + esc(ui.submitError) + '</p>' : "") +
      '</div>';
  }

  function renderPlayerReveal() {
    var q = state.question;
    var mine = state.myAnswer;
    var gotIt = mine && mine.optionIndex === q.correct;
    return '<div class="panel center">' +
      '<p class="qcount">QUESTION ' + (q.index + 1) + ' OF ' + q.total + '</p>' +
      '<h2 class="question-text" style="margin-top:8px;">' + esc(q.text) + '</h2>' +
      '<p style="margin-top:14px; font-weight:800; font-size:18px; color:' + (mine ? (gotIt ? "var(--correct)" : "var(--incorrect)") : "var(--ink-dim)") + ';">' +
      (mine ? (gotIt ? "+" + mine.points + " points — correct!" : "Incorrect") : "Time's up — no answer submitted") +
      '</p>' +
      '</div>' +
      '<div class="panel">' + renderOptionTiles(q, { interactive: false, reveal: true, myOption: mine ? mine.optionIndex : null }) + '</div>';
  }

  function renderPlayerLeaderboard() {
    var rows = state.leaderboard;
    var myRank = rows.findIndex(function (r) { return r.id === playerId; }) + 1;
    return '<div class="panel">' +
      '<h2 class="display center" style="font-size:22px;">Leaderboard</h2>' +
      (myRank ? '<p class="center" style="margin-top:8px;">You\'re <span class="mono" style="color:var(--accent); font-weight:700;">#' + myRank + '</span></p>' : "") +
      '<div class="players-list" style="margin-top:16px; max-height:none;">' + renderLeaderboardRows(rows) + '</div>' +
      '<p class="muted center" style="margin-top:14px;">Waiting for the host to continue…</p>' +
      '</div>';
  }

  function renderPlayerFinal() {
    var rows = state.leaderboard;
    var myRank = rows.findIndex(function (r) { return r.id === playerId; }) + 1;
    var myScore = rows.find(function (r) { return r.id === playerId; });
    return '<div class="panel">' +
      '<h2 class="display center" style="font-size:24px;">Final Results</h2>' +
      renderPodium(rows) +
      '<div class="panel center" style="margin-top:18px; background:var(--bg-raised-2);">' +
      '<p class="muted">You placed</p>' +
      '<p class="display" style="font-size:40px; color:var(--accent); margin-top:4px;">#' + (myRank || "—") + '</p>' +
      '<p class="mono" style="color:var(--ink-dim); margin-top:4px;">' + (myScore ? myScore.points : 0) + ' points</p>' +
      '</div>' +
      '<div class="players-list" style="margin-top:18px; max-height:none;">' + renderLeaderboardRows(rows) + '</div>' +
      '</div>';
  }

  // ---------- shared pieces ----------

  function renderTimer() {
    if (!state.question || state.phase !== "question") return "";
    var remaining = clamp(state.question.timeLimit - (now() - state.question.startedAt), 0, state.question.timeLimit);
    var frac = state.question.timeLimit ? remaining / state.question.timeLimit : 0;
    var r = 42, c = 2 * Math.PI * r;
    var offset = c * (1 - frac);
    var color = frac < 0.25 ? "var(--incorrect)" : "var(--accent)";
    return '<div class="timer-wrap">' +
      '<svg width="96" height="96" viewBox="0 0 96 96">' +
      '<circle cx="48" cy="48" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="8"/>' +
      '<circle cx="48" cy="48" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="8" ' +
      'stroke-dasharray="' + c + '" stroke-dashoffset="' + offset + '" stroke-linecap="round"/>' +
      '</svg>' +
      '<div class="timer-num mono" style="color:' + color + ';">' + Math.ceil(remaining / 1000) + '</div>' +
      '</div>';
  }

  function renderOptionTiles(q, opts) {
    opts = opts || {};
    var html = '<div class="options-grid" data-count="' + q.options.length + '">';
    for (var i = 0; i < q.options.length; i++) {
      var isCorrect = opts.reveal && i === q.correct;
      var dim = opts.reveal && !isCorrect;
      var mineMark = opts.myOption === i ? " ✓ your answer" : "";
      html += '<button class="option-tile opt-' + i + '" ' +
        (opts.interactive ? 'data-action="select-option" data-option="' + i + '"' : "disabled") +
        (dim ? ' data-dim="true"' : "") +
        (isCorrect ? ' data-correct="true"' : "") +
        '>' + SHAPES[i] +
        '<span style="flex:1;">' + esc(q.options[i]) + mineMark + '</span></button>';
    }
    html += "</div>";
    return html;
  }

  function renderLeaderboardRows(rows) {
    if (!rows.length) return '<p class="muted">No scores yet.</p>';
    return rows.map(function (r, i) {
      return '<div class="player-row">' +
        '<span class="row" style="gap:10px;"><span class="rank-badge" data-top="' + (i + 1) + '">' + (i + 1) + '</span>' + esc(r.name) + '</span>' +
        '<span class="score mono">' + r.points + '</span>' +
        '</div>';
    }).join("");
  }

  function renderPodium(rows) {
    var order = [1, 0, 2];
    var heights = [120, 150, 95];
    var colors = ["#C9C2E0", "var(--accent)", "#C98A4E"];
    var html = '<div class="podium">';
    for (var i = 0; i < 3; i++) {
      var pos = order[i];
      var r = rows[pos];
      html += '<div class="podium-col">' +
        '<div class="podium-name">' + (r ? esc(r.name) : "—") + '</div>' +
        '<div class="podium-score">' + (r ? r.points + " pts" : "") + '</div>' +
        '<div class="podium-bar" style="height:' + heights[i] + 'px; background:' + colors[i] + '; color:#2A1C00;">#' + (pos + 1) + '</div>' +
        '</div>';
    }
    html += "</div>";
    return html;
  }

  // ---------- ticker ----------

  function startOrStopTicker() {
    var remainingNow = state && state.phase === "question"
      ? clamp(state.question.timeLimit - (now() - state.question.startedAt), 0, state.question.timeLimit)
      : 0;
    var shouldTick = remainingNow > 0;
    if (shouldTick && !ui.tickHandle) {
      ui.tickHandle = setInterval(function () {
        var remaining = clamp(state.question.timeLimit - (now() - state.question.startedAt), 0, state.question.timeLimit);
        if (remaining <= 0) {
          clearInterval(ui.tickHandle);
          ui.tickHandle = null;
          return; // the next poll will pick up the server's phase change
        }
        var timerEl = app.querySelector(".timer-num");
        if (!timerEl) return;
        var svgEl = app.querySelector(".timer-wrap svg circle:last-child");
        var r = 42, c = 2 * Math.PI * r, frac = remaining / state.question.timeLimit;
        if (svgEl) svgEl.setAttribute("stroke-dashoffset", c * (1 - frac));
        timerEl.textContent = Math.ceil(remaining / 1000);
      }, 250);
    } else if (!shouldTick && ui.tickHandle) {
      clearInterval(ui.tickHandle);
      ui.tickHandle = null;
    }
  }

  function renderQrIfNeeded() {
    var box = document.getElementById("qr-box");
    if (!box || !window.QRCode) return;
    var url = joinUrl();
    if (ui.qrRenderedFor === url) return;
    box.innerHTML = "";
    try { new QRCode(box, { text: url, width: 140, height: 140 }); ui.qrRenderedFor = url; } catch (e) {}
  }

  function copyLink() {
    try { navigator.clipboard.writeText(joinUrl()); } catch (e) {}
  }

  // ---------- host actions ----------

  async function hostAction(action) {
    try {
      await api("/api/host/" + action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostSecret: hostSecret })
      });
      await poll();
    } catch (e) {}
  }

  async function verifyHostSecret(secret) {
    try {
      await api("/api/host/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostSecret: secret })
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- player actions ----------

  function submitPin(pin) {
    ui.pinError = "";
    if (pin.trim() === state.pin) ui.pinOk = true;
    else ui.pinError = "That code doesn't match. Check the host's screen and try again.";
    render();
  }

  async function submitName(name) {
    name = name.trim();
    if (!name) { ui.joinError = "Enter a nickname to continue."; render(); return; }
    ui.joining = true; ui.joinError = ""; render();
    try {
      var res = await api("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name })
      });
      playerId = res.playerId;
      localStorage.setItem("trivia_player_id", playerId);
      state = res;
    } catch (e) {
      ui.joining = false;
      ui.joinError = "Couldn't join — check your connection and try again.";
      render();
      return;
    }
    ui.joining = false;
    render();
  }

  async function selectOption(optionIndex) {
    if (ui.submitting || !state.question) return;
    var remaining = clamp(state.question.timeLimit - (now() - state.question.startedAt), 0, state.question.timeLimit);
    if (remaining <= 0) return;
    ui.submitting = true;
    try {
      await api("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId: playerId, questionIndex: state.question.index, optionIndex: optionIndex })
      });
      await poll();
    } catch (e) {
      ui.submitError = "Couldn't submit your answer — try again.";
    }
    ui.submitting = false;
    render();
  }

  // ---------- event delegation ----------

  app.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-action]");
    if (!btn) return;
    var action = btn.getAttribute("data-action");
    if (action === "host-start") hostAction("start");
    else if (action === "host-reveal") hostAction("reveal");
    else if (action === "host-leaderboard") hostAction("leaderboard");
    else if (action === "host-next") hostAction("next");
    else if (action === "host-newgame") hostAction("newgame");
    else if (action === "host-copylink") copyLink();
    else if (action === "select-option") selectOption(parseInt(btn.getAttribute("data-option"), 10));
  });

  app.addEventListener("input", function (e) {
    var field = e.target.closest("input[data-field]");
    if (!field) return;
    var name = field.getAttribute("data-field");
    if (name === "pin") ui.pinDraft = field.value;
    else if (name === "name") ui.nameDraft = field.value;
    else if (name === "hostpass") {
      ui.hostPassDraft = field.value;
      var echo = document.getElementById("hostpass-echo");
      if (echo) echo.textContent = field.value || "(empty)";
    }
  });

  app.addEventListener("submit", function (e) {
    var form = e.target.closest("form");
    if (!form) return;
    e.preventDefault();
    var kind = form.getAttribute("data-form");
    if (kind === "pin") {
      var pinField = form.querySelector('[data-field="pin"]');
      ui.pinDraft = pinField.value;
      submitPin(pinField.value);
    } else if (kind === "name") {
      var nameField = form.querySelector('[data-field="name"]');
      ui.nameDraft = nameField.value;
      submitName(nameField.value);
    } else if (kind === "hostpass") {
      var passField = form.querySelector('[data-field="hostpass"]');
      var pass = passField.value.trim();
      ui.hostPassDraft = pass;
      verifyHostSecret(pass).then(function (ok) {
        if (ok) {
          hostSecret = pass;
          localStorage.setItem("trivia_host_secret", hostSecret);
          isHost = true;
          ui.hostPassError = "";
        } else {
          ui.hostPassError = "That passphrase isn't right.";
        }
        render();
      });
    }
  });

  // ---------- polling ----------

  async function poll() {
    var prevLoadError = loadError;
    try {
      var qs = playerId ? "?playerId=" + encodeURIComponent(playerId) : "";
      var before = Date.now();
      var res = await api("/api/state" + qs, { method: "GET" });
      clockOffset = res.serverNow - before;
      state = res;
      loadError = false;
    } catch (e) {
      loadError = true;
    }
    var sig = stateSignature(state);
    var changed = sig !== lastStateSignature || loadError !== prevLoadError;
    lastStateSignature = sig;
    if (changed) render(true);
  }

  // ---------- boot ----------

  async function boot() {
    var params = new URLSearchParams(window.location.search);
    if (params.get("pin")) ui.pinDraft = params.get("pin");

    if (hostVerifying) {
      var ok = await verifyHostSecret(hostSecret);
      if (ok) {
        isHost = true;
      } else {
        hostSecret = null;
        localStorage.removeItem("trivia_host_secret");
      }
      hostVerifying = false;
    }

    await poll();

    if (ui.pinDraft && state && ui.pinDraft === state.pin) {
      ui.pinOk = true;
    }

    setInterval(poll, POLL_MS);
    render();
  }

  boot();
})();
