import cors from "cors";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import {
  COLORS,
  VARIANT_SETUP_DESCRIPTION,
  createInitialBoard,
  oppositeColor,
  tryMove,
} from "../../shared/game.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, "../../client/dist");
const port = Number(process.env.PORT || 3001);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
  },
});

const games = new Map();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/games", (_request, response) => {
  response.json(listLobbyGames());
});

app.get("/api/variant", (_request, response) => {
  response.json({ description: VARIANT_SETUP_DESCRIPTION });
});

if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get("*", (request, response, next) => {
    if (request.path.startsWith("/api") || request.path.startsWith("/socket.io")) {
      next();
      return;
    }

    response.sendFile(path.join(clientDistPath, "index.html"));
  });
}

function gameRoomId(gameId) {
  return `game:${gameId}`;
}

function listLobbyGames() {
  return [...games.values()]
    .filter((game) => game.status !== "finished")
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((game) => ({
      id: game.id,
      name: game.name,
      status: game.status,
      hasPassword: Boolean(game.password),
      timeLimitMinutes: game.timeLimitMinutes,
      createdAt: game.createdAt,
      players: {
        white: game.players.white?.name ?? null,
        black: game.players.black?.name ?? null,
      },
    }));
}

function getVisibleClocks(game, now = Date.now()) {
  const clocks = {
    white: game.clocks.white,
    black: game.clocks.black,
  };

  if (game.status === "active" && game.turnStartedAt) {
    const elapsed = now - game.turnStartedAt;
    clocks[game.activeColor] = Math.max(0, clocks[game.activeColor] - elapsed);
  }

  return clocks;
}

function serializePlayer(player) {
  if (!player) {
    return null;
  }

  return {
    name: player.name,
    connected: player.connected,
  };
}

function serializeGame(game) {
  return {
    id: game.id,
    name: game.name,
    status: game.status,
    board: game.board,
    activeColor: game.activeColor,
    players: {
      white: serializePlayer(game.players.white),
      black: serializePlayer(game.players.black),
    },
    timeLimitMinutes: game.timeLimitMinutes,
    createdAt: game.createdAt,
    startedAt: game.startedAt,
    moves: game.moves,
    lastMove: game.lastMove,
    clocks: getVisibleClocks(game),
    result: game.result,
    rematch: game.rematch,
    variantDescription: VARIANT_SETUP_DESCRIPTION,
  };
}

function emitLobbyUpdate() {
  io.emit("lobby:update", listLobbyGames());
}

function emitGameState(game) {
  io.to(gameRoomId(game.id)).emit("game:state", serializeGame(game));
}

function clearSocketSession(socket) {
  socket.data.currentGameId = null;
  socket.data.color = null;
  socket.data.playerToken = null;
}

function attachSocketToGame(socket, gameId, color, token) {
  socket.join(gameRoomId(gameId));
  socket.data.currentGameId = gameId;
  socket.data.color = color;
  socket.data.playerToken = token;
}

function createPlayerSeat(socket, name) {
  return {
    socketId: socket.id,
    token: randomUUID(),
    name,
    connected: true,
  };
}

function createRematchState() {
  return {
    requestedBy: null,
  };
}

function resetGameForRematch(game) {
  const startingTimeMs = game.timeLimitMinutes * 60 * 1000;
  game.board = createInitialBoard();
  game.activeColor = COLORS.WHITE;
  game.status = "active";
  game.clocks = {
    white: startingTimeMs,
    black: startingTimeMs,
  };
  game.startedAt = Date.now();
  game.turnStartedAt = Date.now();
  game.moves = [];
  game.lastMove = null;
  game.result = null;
  game.lastClockBroadcastAt = 0;
  game.rematch = createRematchState();
}

function finishGame(game, result) {
  if (game.status === "finished") {
    return;
  }

  game.clocks = getVisibleClocks(game);
  game.status = "finished";
  game.result = result;
  game.turnStartedAt = null;
  game.rematch = createRematchState();
  emitGameState(game);
  emitLobbyUpdate();
}

function maybeDeleteGame(game) {
  if (!game.players.white && !game.players.black) {
    games.delete(game.id);
    emitLobbyUpdate();
  }
}

function removePlayerFromGame(socket, reason) {
  const gameId = socket.data.currentGameId;
  const color = socket.data.color;
  clearSocketSession(socket);

  if (!gameId || !color) {
    return;
  }

  socket.leave(gameRoomId(gameId));

  const game = games.get(gameId);
  if (!game) {
    return;
  }

  const seat = game.players[color];
  if (!seat || seat.socketId !== socket.id) {
    return;
  }

  game.players[color] = null;
  game.rematch = createRematchState();

  if (game.status === "waiting") {
    games.delete(game.id);
    emitLobbyUpdate();
    return;
  }

  if (game.status === "active" && !game.result) {
    const winner = oppositeColor(color);
    if (game.players[winner]) {
      finishGame(game, { winner, reason });
    } else {
      games.delete(game.id);
      emitLobbyUpdate();
    }
    return;
  }

  emitGameState(game);
  maybeDeleteGame(game);
}

function markPlayerDisconnected(socket) {
  const gameId = socket.data.currentGameId;
  const color = socket.data.color;
  clearSocketSession(socket);

  if (!gameId || !color) {
    return;
  }

  const game = games.get(gameId);
  if (!game) {
    return;
  }

  const seat = game.players[color];
  if (!seat || seat.socketId !== socket.id) {
    return;
  }

  seat.connected = false;
  seat.socketId = null;
  emitGameState(game);
  emitLobbyUpdate();
}

function ensureString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function ensureTimeLimit(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 10;
  }

  return Math.min(180, Math.max(1, Math.round(numericValue)));
}

function getGameBySocket(socket) {
  const gameId = socket.data.currentGameId;
  if (!gameId) {
    return null;
  }

  return games.get(gameId) ?? null;
}

io.on("connection", (socket) => {
  socket.emit("lobby:update", listLobbyGames());

  socket.on("create-game", (payload, callback = () => {}) => {
    const playerName = ensureString(payload?.playerName, "Белые");
    const gameName = ensureString(payload?.name, "Партия 16x16");
    const password = ensureString(payload?.password);
    const timeLimitMinutes = ensureTimeLimit(payload?.timeLimitMinutes);

    if (getGameBySocket(socket)) {
      callback({ ok: false, error: "Сначала покиньте текущую игру." });
      return;
    }

    const gameId = randomUUID().slice(0, 8);
    const startingTimeMs = timeLimitMinutes * 60 * 1000;
    const game = {
      id: gameId,
      name: gameName,
      password,
      board: createInitialBoard(),
      activeColor: COLORS.WHITE,
      status: "waiting",
      players: {
        white: createPlayerSeat(socket, playerName),
        black: null,
      },
      timeLimitMinutes,
      clocks: {
        white: startingTimeMs,
        black: startingTimeMs,
      },
      createdAt: Date.now(),
      startedAt: null,
      turnStartedAt: null,
      moves: [],
      lastMove: null,
      result: null,
      rematch: createRematchState(),
      lastClockBroadcastAt: 0,
    };

    games.set(gameId, game);
    attachSocketToGame(socket, gameId, COLORS.WHITE, game.players.white.token);

    callback({
      ok: true,
      color: COLORS.WHITE,
      game: serializeGame(game),
      sessionToken: game.players.white.token,
      playerName: game.players.white.name,
    });

    emitLobbyUpdate();
  });

  socket.on("join-game", (payload, callback = () => {}) => {
    const game = games.get(ensureString(payload?.gameId));
    if (!game) {
      callback({ ok: false, error: "Игра не найдена." });
      return;
    }

    if (game.status !== "waiting" || game.players.black) {
      callback({ ok: false, error: "К этой игре уже нельзя подключиться." });
      return;
    }

    if (game.password && game.password !== ensureString(payload?.password)) {
      callback({ ok: false, error: "Неверный пароль." });
      return;
    }

    if (getGameBySocket(socket)) {
      callback({ ok: false, error: "Сначала покиньте текущую игру." });
      return;
    }

    game.players.black = createPlayerSeat(socket, ensureString(payload?.playerName, "Черные"));
    game.status = "active";
    game.startedAt = Date.now();
    game.turnStartedAt = Date.now();
    game.lastClockBroadcastAt = 0;

    attachSocketToGame(socket, game.id, COLORS.BLACK, game.players.black.token);

    const serializedGame = serializeGame(game);
    callback({
      ok: true,
      color: COLORS.BLACK,
      game: serializedGame,
      sessionToken: game.players.black.token,
      playerName: game.players.black.name,
    });

    emitGameState(game);
    emitLobbyUpdate();
  });

  socket.on("make-move", (payload, callback = () => {}) => {
    const game = getGameBySocket(socket);
    const color = socket.data.color;

    if (!game || !color) {
      callback({ ok: false, error: "Вы не находитесь в игре." });
      return;
    }

    if (game.status !== "active") {
      callback({ ok: false, error: "Партия уже завершена или еще не началась." });
      return;
    }

    if (game.activeColor !== color) {
      callback({ ok: false, error: "Сейчас ход соперника." });
      return;
    }

    const clocks = getVisibleClocks(game);
    if (clocks[color] <= 0) {
      finishGame(game, { winner: oppositeColor(color), reason: "time" });
      callback({ ok: false, error: "Время вышло." });
      return;
    }

    const from = payload?.from;
    const to = payload?.to;
    const moveResult = tryMove(game.board, from, to, color);
    if (!moveResult.ok) {
      callback(moveResult);
      return;
    }

    game.board = moveResult.board;
    game.moves.push({
      ...moveResult.move,
      moveNumber: game.moves.length + 1,
    });
    game.lastMove = moveResult.move;
    game.clocks = clocks;
    game.activeColor = oppositeColor(color);

    if (moveResult.resolution.status === "finished") {
      game.status = "finished";
      game.result = {
        winner: moveResult.resolution.winner,
        reason: moveResult.resolution.reason,
      };
      game.turnStartedAt = null;
      game.rematch = createRematchState();
    } else {
      game.turnStartedAt = Date.now();
      game.lastClockBroadcastAt = 0;
    }

    emitGameState(game);
    emitLobbyUpdate();
    callback({ ok: true });
  });

  socket.on("request-rematch", (callback = () => {}) => {
    const game = getGameBySocket(socket);
    const color = socket.data.color;

    if (!game || !color) {
      callback({ ok: false, error: "Вы не находитесь в игре." });
      return;
    }

    if (game.status !== "finished") {
      callback({ ok: false, error: "Реванш доступен только после завершения партии." });
      return;
    }

    if (!game.players.white || !game.players.black) {
      callback({ ok: false, error: "Для реванша нужны оба игрока." });
      return;
    }

    if (game.rematch.requestedBy === color) {
      callback({ ok: false, error: "Запрос на реванш уже отправлен." });
      return;
    }

    if (game.rematch.requestedBy === oppositeColor(color)) {
      resetGameForRematch(game);
      emitGameState(game);
      emitLobbyUpdate();
      callback({ ok: true, restarted: true });
      return;
    }

    game.rematch.requestedBy = color;
    emitGameState(game);
    callback({ ok: true, restarted: false });
  });

  socket.on("cancel-rematch", (callback = () => {}) => {
    const game = getGameBySocket(socket);
    const color = socket.data.color;

    if (!game || !color) {
      callback({ ok: false, error: "Вы не находитесь в игре." });
      return;
    }

    if (game.status !== "finished") {
      callback({ ok: false, error: "Сейчас нечего отменять." });
      return;
    }

    if (game.rematch.requestedBy !== color) {
      callback({ ok: false, error: "Ваш запрос на реванш не найден." });
      return;
    }

    game.rematch.requestedBy = null;
    emitGameState(game);
    callback({ ok: true });
  });

  socket.on("reconnect-game", (payload, callback = () => {}) => {
    if (getGameBySocket(socket)) {
      callback({ ok: false, error: "Сначала покиньте текущую игру." });
      return;
    }

    const game = games.get(ensureString(payload?.gameId));
    const sessionToken = ensureString(payload?.sessionToken);
    if (!game || !sessionToken) {
      callback({ ok: false, error: "Сохраненная игра не найдена." });
      return;
    }

    let color = null;
    if (game.players.white?.token === sessionToken) {
      color = COLORS.WHITE;
    } else if (game.players.black?.token === sessionToken) {
      color = COLORS.BLACK;
    }

    if (!color) {
      callback({ ok: false, error: "Сессия игрока недействительна." });
      return;
    }

    const seat = game.players[color];
    seat.socketId = socket.id;
    seat.connected = true;

    attachSocketToGame(socket, game.id, color, seat.token);

    callback({
      ok: true,
      color,
      game: serializeGame(game),
      sessionToken: seat.token,
      playerName: seat.name,
    });

    emitGameState(game);
    emitLobbyUpdate();
  });

  socket.on("leave-game", (callback = () => {}) => {
    removePlayerFromGame(socket, "resignation");
    callback({ ok: true });
  });

  socket.on("disconnect", () => {
    markPlayerDisconnected(socket);
  });
});

setInterval(() => {
  let lobbyChanged = false;
  const now = Date.now();

  for (const game of games.values()) {
    if (game.status !== "active" || !game.turnStartedAt) {
      if (game.status === "finished" && !game.players.white && !game.players.black) {
        games.delete(game.id);
        lobbyChanged = true;
      }
      continue;
    }

    const clocks = getVisibleClocks(game, now);
    if (clocks[game.activeColor] <= 0) {
      game.clocks = clocks;
      game.status = "finished";
      game.result = {
        winner: oppositeColor(game.activeColor),
        reason: "time",
      };
      game.turnStartedAt = null;
      game.rematch = createRematchState();
      emitGameState(game);
      lobbyChanged = true;
      continue;
    }

    if (now - game.lastClockBroadcastAt >= 1000) {
      game.lastClockBroadcastAt = now;
      emitGameState(game);
    }
  }

  if (lobbyChanged) {
    emitLobbyUpdate();
  }
}, 250);

server.listen(port, () => {
  console.log(`Chess16 server started on http://localhost:${port}`);
});
