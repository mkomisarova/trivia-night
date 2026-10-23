// Trivia Night — Cloudflare Worker + Durable Object backend.
// One global game room (DO instance "main") holds all live state.

const QUESTIONS = [
  { q: "Which planet is known as the Red Planet?", options: ["Venus", "Mars", "Jupiter", "Saturn"], correct: 1, timeLimit: 20000 },
  { q: "What is the capital of France?", options: ["Paris", "Lyon", "Marseille", "Nice"], correct: 0, timeLimit: 20000 },
  { q: "How many legs does a spider have?", options: ["6", "8"], correct: 1, timeLimit: 15000 },
  { q: "Which ocean is the largest?", options: ["Atlantic", "Indian", "Pacific", "Arctic"], correct: 2, timeLimit: 20000 },
  { q: "What is the chemical symbol for gold?", options: ["Au", "Ag", "Gd", "Go"], correct: 0, timeLimit: 20000 },
  { q: "Who painted the Mona Lisa?", options: ["Michelangelo", "Da Vinci"], correct: 1, timeLimit: 15000 },
  { q: "What is the smallest prime number?", options: ["0", "1", "2", "3"], correct: 2, timeLimit: 20000 },
  { q: "Which language has the most native speakers?", options: ["English", "Mandarin", "Spanish", "Hindi"], correct: 1, timeLimit: 20000 },
  { q: "What is the hardest natural substance on Earth?", options: ["Diamond", "Quartz"], correct: 0, timeLimit: 15000 },
  { q: "How many continents are there?", options: ["5", "6", "7", "8"], correct: 2, timeLimit: 20000 },
  { q: "What gas do plants absorb from the atmosphere?", options: ["Oxygen", "Carbon dioxide", "Nitrogen", "Hydrogen"], correct: 1, timeLimit: 20000 },
  { q: "Which animal is the fastest on land?", options: ["Lion", "Cheetah"], correct: 1, timeLimit: 15000 },
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function computePoints(correct, elapsedMs, timeLimitMs) {
  if (!correct) return 0;
  return Math.round(1000 - 500 * clamp(elapsedMs / timeLimitMs, 0, 1));
}

function randomPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function newId() {
  return crypto.randomUUID();
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.game = null;
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("game");
      this.game = stored || this.freshGame();
    });
  }

  freshGame() {
    return {
      pin: randomPin(),
      phase: "lobby", // lobby | question | reveal | leaderboard | final
      questionIndex: -1,
      questionStartedAt: null,
      players: {}, // id -> { name, joinedAt }
      answers: {}, // questionIndex -> { playerId -> { optionIndex, points, answeredAt } }
    };
  }

  async save() {
    await this.state.storage.put("game", this.game);
  }

  leaderboard() {
    const totals = {};
    for (const id of Object.keys(this.game.players)) totals[id] = 0;
    for (const qAnswers of Object.values(this.game.answers)) {
      for (const [playerId, a] of Object.entries(qAnswers)) {
        totals[playerId] = (totals[playerId] || 0) + a.points;
      }
    }
    return Object.entries(totals)
      .map(([id, points]) => ({ id, name: this.game.players[id]?.name || "?", points }))
      .sort((a, b) => b.points - a.points);
  }

  publicQuestion() {
    const q = QUESTIONS[this.game.questionIndex];
    if (!q) return null;
    const revealed = this.game.phase === "reveal" || this.game.phase === "leaderboard" || this.game.phase === "final";
    return {
      index: this.game.questionIndex,
      total: QUESTIONS.length,
      text: q.q,
      options: q.options,
      timeLimit: q.timeLimit,
      startedAt: this.game.questionStartedAt,
      correct: revealed ? q.correct : null,
    };
  }

  publicState(playerId) {
    const myAnswer =
      playerId && this.game.questionIndex >= 0
        ? this.game.answers[this.game.questionIndex]?.[playerId] || null
        : null;
    return {
      pin: this.game.pin,
      phase: this.game.phase,
      question: this.publicQuestion(),
      players: Object.entries(this.game.players).map(([id, p]) => ({ id, name: p.name })),
      leaderboard: ["leaderboard", "final"].includes(this.game.phase) ? this.leaderboard() : [],
      myAnswer,
      serverNow: Date.now(),
    };
  }

  async handleJoin(body) {
    const name = (body.name || "").trim().slice(0, 24);
    if (!name) return json({ error: "Name required" }, 400);
    const id = newId();
    this.game.players[id] = { name, joinedAt: Date.now() };
    await this.save();
    return json({ playerId: id, ...this.publicState(id) });
  }

  async handleAnswer(body) {
    const { playerId, questionIndex, optionIndex } = body;
    if (!this.game.players[playerId]) return json({ error: "Unknown player" }, 400);
    if (this.game.phase !== "question" || questionIndex !== this.game.questionIndex) {
      return json({ error: "Question is not active" }, 400);
    }
    const q = QUESTIONS[this.game.questionIndex];
    if (!this.game.answers[questionIndex]) this.game.answers[questionIndex] = {};
    if (this.game.answers[questionIndex][playerId]) {
      return json({ error: "Already answered" }, 400);
    }
    const elapsed = Date.now() - this.game.questionStartedAt;
    const correct = optionIndex === q.correct;
    const points = computePoints(correct, elapsed, q.timeLimit);
    this.game.answers[questionIndex][playerId] = { optionIndex, points, answeredAt: Date.now() };
    await this.save();
    return json({ ok: true });
  }

  requireHost(body) {
    return body.hostSecret && this.env.HOST_SECRET && body.hostSecret === this.env.HOST_SECRET;
  }

  async handleHostAction(action, body) {
    if (!this.requireHost(body)) return json({ error: "Not authorized" }, 403);

    if (action === "verify") {
      return json({ ok: true });
    } else if (action === "start") {
      this.game.phase = "question";
      this.game.questionIndex = 0;
      this.game.questionStartedAt = Date.now();
    } else if (action === "reveal") {
      this.game.phase = "reveal";
    } else if (action === "leaderboard") {
      this.game.phase = "leaderboard";
    } else if (action === "next") {
      const nextIndex = this.game.questionIndex + 1;
      if (nextIndex >= QUESTIONS.length) {
        this.game.phase = "final";
      } else {
        this.game.phase = "question";
        this.game.questionIndex = nextIndex;
        this.game.questionStartedAt = Date.now();
      }
    } else if (action === "newgame") {
      this.game = this.freshGame();
    } else {
      return json({ error: "Unknown action" }, 400);
    }
    await this.save();
    return json({ ok: true });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    if (url.pathname === "/api/state" && request.method === "GET") {
      const playerId = url.searchParams.get("playerId");
      return json(this.publicState(playerId));
    }

    if (url.pathname === "/api/join" && request.method === "POST") {
      return this.handleJoin(await request.json());
    }

    if (url.pathname === "/api/answer" && request.method === "POST") {
      return this.handleAnswer(await request.json());
    }

    const hostMatch = url.pathname.match(/^\/api\/host\/([a-z]+)$/);
    if (hostMatch && request.method === "POST") {
      return this.handleHostAction(hostMatch[1], await request.json());
    }

    return json({ error: "Not found" }, 404);
  }
}

export default {
  async fetch(request, env) {
    const id = env.GAME_ROOM.idFromName("main");
    const stub = env.GAME_ROOM.get(id);
    return stub.fetch(request);
  },
};
