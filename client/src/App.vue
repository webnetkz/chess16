<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { io } from "socket.io-client";
import {
  BOARD_SIZE,
  FILES,
  VARIANT_SETUP_DESCRIPTION,
  getLegalMoves,
  isKingInCheck,
  sameSquare,
} from "../../shared/game.js";
import {
  playCaptureSound,
  playCheckSound,
  playInvalidSound,
  playMateSound,
  playMoveSound,
  playSelectSound,
  unlockAudio,
} from "./audio.js";

const socket = io({
  autoConnect: true,
});

const BOARD_SIZE_STORAGE_KEY = "chess16-board-size";
const DEFAULT_BOARD_SIZE = 760;
const MIN_BOARD_SIZE = 320;
const BOARD_SIZE_VIEWPORT_OFFSET = 240;
const SESSION_STORAGE_KEY = "chess16-session";
const playerName = ref(`Игрок-${Math.floor(Math.random() * 900 + 100)}`);
const createForm = reactive({
  name: "Партия 16x16",
  password: "",
  timeLimitMinutes: 10,
});
const joinPasswords = reactive({});
const games = ref([]);
const currentGame = ref(null);
const yourColor = ref(null);
const selectedSquare = ref(null);
const errorMessage = ref("");
const connectionState = ref("connecting");
const session = ref(loadStoredSession());
const resultModalOpen = ref(false);
const boardHostElement = ref(null);
const boardElement = ref(null);
const preferredBoardSize = ref(loadStoredBoardSize());
const boardSizeLimit = ref(DEFAULT_BOARD_SIZE);
const lastDragEndedAt = ref(0);
const dragState = reactive({
  phase: "idle",
  pointerId: null,
  from: null,
  piece: null,
  hoverSquare: null,
  startX: 0,
  startY: 0,
  pointerX: 0,
  pointerY: 0,
});
const resizeState = reactive({
  active: false,
  pointerId: null,
  startX: 0,
  startY: 0,
  startSize: DEFAULT_BOARD_SIZE,
});

let boardHostResizeObserver = null;

const isYourTurn = computed(
  () =>
    currentGame.value?.status === "active" &&
    yourColor.value &&
    currentGame.value.activeColor === yourColor.value,
);

const statusText = computed(() => {
  const game = currentGame.value;
  if (!game) {
    return "Создайте комнату или подключитесь к существующей партии.";
  }

  if (game.status === "waiting") {
    return `Комната создана. ID: ${game.id}. Ожидание второго игрока.`;
  }

  if (game.status === "finished") {
    if (!game.result?.winner) {
      return game.result?.reason === "stalemate"
        ? "Партия завершена вничью по пату."
        : "Партия завершена вничью.";
    }

    const winnerLabel = game.result.winner === "white" ? "Белые" : "Черные";
    const reasonMap = {
      checkmate: "мат",
      time: "время",
      resignation: "сдача",
      disconnect: "отключение",
      "king-captured": "взятие короля",
    };
    const reasonLabel = reasonMap[game.result.reason] ?? "завершение партии";
    return `${winnerLabel} победили (${reasonLabel}).`;
  }

  return isYourTurn.value ? "Ваш ход." : "Ход соперника.";
});

const legalMoves = computed(() => {
  const game = currentGame.value;
  if (!game || !selectedSquare.value || !isYourTurn.value) {
    return [];
  }

  return getLegalMoves(game.board, selectedSquare.value, yourColor.value);
});

const legalMoveSet = computed(
  () => new Set(legalMoves.value.map((square) => `${square.row}-${square.col}`)),
);

const displayedRows = computed(() =>
  yourColor.value === "black"
    ? Array.from({ length: BOARD_SIZE }, (_, index) => BOARD_SIZE - 1 - index)
    : Array.from({ length: BOARD_SIZE }, (_, index) => index),
);

const displayedCols = computed(() =>
  yourColor.value === "black"
    ? Array.from({ length: BOARD_SIZE }, (_, index) => BOARD_SIZE - 1 - index)
    : Array.from({ length: BOARD_SIZE }, (_, index) => index),
);

const displayedSquares = computed(() => {
  const game = currentGame.value;
  const rows = displayedRows.value;
  const cols = displayedCols.value;
  const bottomRow = rows[rows.length - 1];
  const leftCol = cols[0];
  const lastMove = game?.lastMove;

  return rows.flatMap((row) =>
    cols.map((col) => {
      const piece = game?.board?.[row]?.[col] ?? null;
      return {
        row,
        col,
        key: `${row}-${col}`,
        piece,
        labelFile: FILES[col],
        labelRank: BOARD_SIZE - row,
        showFile: row === bottomRow,
        showRank: col === leftCol,
        isDark: (row + col) % 2 === 1,
        isSelected: sameSquare(selectedSquare.value, { row, col }),
        isLegalTarget: legalMoveSet.value.has(`${row}-${col}`),
        isDragOrigin: dragState.phase === "dragging" && sameSquare(dragState.from, { row, col }),
        isDragHover: dragState.phase === "dragging" && sameSquare(dragState.hoverSquare, { row, col }),
        isLastMove:
          sameSquare(lastMove?.from, { row, col }) || sameSquare(lastMove?.to, { row, col }),
      };
    }),
  );
});

const moveLog = computed(() => [...(currentGame.value?.moves ?? [])].slice(-14).reverse());
const hasBothPlayers = computed(
  () => Boolean(currentGame.value?.players?.white && currentGame.value?.players?.black),
);
const rematchRequestedBy = computed(() => currentGame.value?.rematch?.requestedBy ?? null);
const canRequestRematch = computed(
  () =>
    currentGame.value?.status === "finished" &&
    Boolean(yourColor.value) &&
    hasBothPlayers.value &&
    rematchRequestedBy.value !== yourColor.value,
);
const canCancelRematch = computed(
  () =>
    currentGame.value?.status === "finished" &&
    Boolean(yourColor.value) &&
    rematchRequestedBy.value === yourColor.value,
);
const hasIncomingRematchRequest = computed(
  () =>
    currentGame.value?.status === "finished" &&
    Boolean(yourColor.value) &&
    rematchRequestedBy.value === (yourColor.value === "white" ? "black" : "white"),
);
const resultHeadline = computed(() => {
  const game = currentGame.value;
  if (!game?.result) {
    return "";
  }

  if (!game.result.winner) {
    return "Ничья";
  }

  if (game.result.winner === yourColor.value) {
    return "Вы победили";
  }

  return "Вы проиграли";
});
const resultDescription = computed(() => {
  const game = currentGame.value;
  if (!game?.result) {
    return "";
  }

  const reasonMap = {
    checkmate: "Партия завершена матом.",
    time: "Партия завершена по времени.",
    resignation: "Партия завершена после сдачи соперника.",
    disconnect: "Партия завершена из-за отключения соперника.",
    stalemate: "Партия завершена патом.",
    "king-captured": "Партия завершена взятием короля.",
  };

  return reasonMap[game.result.reason] ?? "Партия завершена.";
});
const rematchStatusText = computed(() => {
  if (!currentGame.value || currentGame.value.status !== "finished") {
    return "";
  }

  if (!hasBothPlayers.value) {
    return "Реванш недоступен: один из игроков уже покинул комнату.";
  }

  if (hasIncomingRematchRequest.value) {
    return "Соперник отправил запрос на реванш.";
  }

  if (canCancelRematch.value) {
    return "Запрос на реванш отправлен. Ожидание ответа соперника.";
  }

  return "Можно отправить запрос на реванш.";
});

const dragPieceStyle = computed(() => {
  if (dragState.phase !== "dragging" || !dragState.piece || !boardElement.value) {
    return null;
  }

  const rect = boardElement.value.getBoundingClientRect();
  const cellSize = Math.min(rect.width, rect.height) / BOARD_SIZE;

  return {
    width: `${cellSize * 0.88}px`,
    height: `${cellSize * 0.88}px`,
    left: `${dragState.pointerX}px`,
    top: `${dragState.pointerY}px`,
  };
});

const boardStyle = computed(() => ({
  width: `${clampBoardSize(preferredBoardSize.value)}px`,
  height: `${clampBoardSize(preferredBoardSize.value)}px`,
}));

function pieceClass(piece) {
  if (!piece) {
    return "";
  }

  const typeMap = {
    p: "pawn",
    r: "rook",
    n: "knight",
    b: "bishop",
    q: "queen",
    k: "king",
  };

  return `${piece.color} ${typeMap[piece.type]}`;
}

function clampBoardSize(size) {
  return Math.max(MIN_BOARD_SIZE, Math.min(Math.round(size), boardSizeLimit.value));
}

function loadStoredBoardSize() {
  try {
    const storedValue = Number(window.localStorage.getItem(BOARD_SIZE_STORAGE_KEY));
    return Number.isFinite(storedValue) ? Math.max(MIN_BOARD_SIZE, storedValue) : DEFAULT_BOARD_SIZE;
  } catch {
    return DEFAULT_BOARD_SIZE;
  }
}

function saveStoredBoardSize(size) {
  preferredBoardSize.value = Math.max(MIN_BOARD_SIZE, Math.round(size));
  window.localStorage.setItem(BOARD_SIZE_STORAGE_KEY, String(preferredBoardSize.value));
}

function updateBoardSizeLimit() {
  const widthLimit = boardHostElement.value
    ? Math.floor(boardHostElement.value.clientWidth - 4)
    : window.innerWidth;
  const heightLimit = Math.floor(window.innerHeight - BOARD_SIZE_VIEWPORT_OFFSET);

  boardSizeLimit.value = Math.max(
    MIN_BOARD_SIZE,
    Math.min(Math.max(MIN_BOARD_SIZE, widthLimit), Math.max(MIN_BOARD_SIZE, heightLimit)),
  );
}

function reconnectBoardHostObserver() {
  boardHostResizeObserver?.disconnect();
  boardHostResizeObserver = null;

  if (!boardHostElement.value || typeof ResizeObserver === "undefined") {
    return;
  }

  boardHostResizeObserver = new ResizeObserver(() => {
    updateBoardSizeLimit();
  });
  boardHostResizeObserver.observe(boardHostElement.value);
}

function clockLabel(ms) {
  const safeMs = Math.max(0, ms ?? 0);
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function clearSelection() {
  selectedSquare.value = null;
}

function resetDragState() {
  dragState.phase = "idle";
  dragState.pointerId = null;
  dragState.from = null;
  dragState.piece = null;
  dragState.hoverSquare = null;
  dragState.startX = 0;
  dragState.startY = 0;
  dragState.pointerX = 0;
  dragState.pointerY = 0;
}

function resetResizeState() {
  resizeState.active = false;
  resizeState.pointerId = null;
  resizeState.startX = 0;
  resizeState.startY = 0;
  resizeState.startSize = clampBoardSize(preferredBoardSize.value);
}

function shouldIgnoreClick() {
  return Date.now() - lastDragEndedAt.value < 180;
}

function getSquareFromPoint(clientX, clientY) {
  const board = boardElement.value;
  if (!board) {
    return null;
  }

  const rect = board.getBoundingClientRect();
  if (
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return null;
  }

  const colIndex = Math.min(
    BOARD_SIZE - 1,
    Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * BOARD_SIZE)),
  );
  const rowIndex = Math.min(
    BOARD_SIZE - 1,
    Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * BOARD_SIZE)),
  );
  const row = displayedRows.value[rowIndex];
  const col = displayedCols.value[colIndex];

  return {
    row,
    col,
    key: `${row}-${col}`,
  };
}

function setResultModalVisibility(game, previousGame = null) {
  if (!game || game.status !== "finished") {
    resultModalOpen.value = false;
    return;
  }

  const resultChanged =
    !previousGame ||
    previousGame.status !== "finished" ||
    previousGame.result?.winner !== game.result?.winner ||
    previousGame.result?.reason !== game.result?.reason;
  const rematchChanged =
    previousGame?.rematch?.requestedBy !== game.rematch?.requestedBy;

  if (resultChanged || rematchChanged) {
    resultModalOpen.value = true;
  }
}

function queueFollowUpSound(soundFn, delay = 120) {
  window.setTimeout(() => {
    soundFn();
  }, delay);
}

function playGameStateSound(previousGame, nextGame) {
  if (!previousGame || previousGame.id !== nextGame.id) {
    return;
  }

  const previousMovesCount = previousGame.moves?.length ?? 0;
  const nextMovesCount = nextGame.moves?.length ?? 0;
  const endedByMate =
    previousGame.status !== "finished" &&
    nextGame.status === "finished" &&
    ["checkmate", "king-captured"].includes(nextGame.result?.reason);

  if (nextMovesCount <= previousMovesCount) {
    if (endedByMate) {
      playMateSound();
    }
    return;
  }

  const baseSound = nextGame.lastMove?.captured ? playCaptureSound : playMoveSound;
  const activeSideInCheck =
    nextGame.status === "active" && isKingInCheck(nextGame.board, nextGame.activeColor);

  baseSound();

  if (endedByMate) {
    queueFollowUpSound(playMateSound, 140);
    return;
  }

  if (activeSideInCheck) {
    queueFollowUpSound(playCheckSound, 120);
  }
}

function loadStoredSession() {
  try {
    const value = window.localStorage.getItem(SESSION_STORAGE_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function saveSession(nextSession) {
  session.value = nextSession;
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(nextSession));
}

function clearSession() {
  session.value = null;
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

function applySessionResponse(response) {
  const previousGame = currentGame.value;
  yourColor.value = response.color;
  currentGame.value = response.game;
  playerName.value = response.playerName ?? playerName.value;
  clearSelection();
  setResultModalVisibility(response.game, previousGame);
  saveSession({
    gameId: response.game.id,
    color: response.color,
    sessionToken: response.sessionToken,
    playerName: response.playerName ?? playerName.value,
  });
}

function restoreSavedGame() {
  if (!session.value?.gameId || !session.value?.sessionToken) {
    return;
  }

  socket.emit(
    "reconnect-game",
    {
      gameId: session.value.gameId,
      sessionToken: session.value.sessionToken,
    },
    (response) => {
      if (!response.ok) {
        clearSession();
        if (!currentGame.value) {
          errorMessage.value = "Не удалось восстановить сохраненную партию.";
        }
        return;
      }

      errorMessage.value = "";
      applySessionResponse(response);
    },
  );
}

async function refreshGames() {
  try {
    const response = await fetch("/api/games");
    games.value = await response.json();
  } catch (error) {
    errorMessage.value = "Не удалось получить список комнат.";
  }
}

function requireName() {
  if (playerName.value.trim()) {
    return true;
  }

  errorMessage.value = "Введите имя игрока.";
  return false;
}

function createGame() {
  if (!requireName()) {
    return;
  }

  void unlockAudio();
  errorMessage.value = "";
  socket.emit(
    "create-game",
    {
      playerName: playerName.value,
      name: createForm.name,
      password: createForm.password,
      timeLimitMinutes: createForm.timeLimitMinutes,
    },
    (response) => {
      if (!response.ok) {
        errorMessage.value = response.error;
        return;
      }

      applySessionResponse(response);
    },
  );
}

function joinGame(gameId) {
  if (!requireName()) {
    return;
  }

  void unlockAudio();
  errorMessage.value = "";
  socket.emit(
    "join-game",
    {
      gameId,
      playerName: playerName.value,
      password: joinPasswords[gameId] ?? "",
    },
    (response) => {
      if (!response.ok) {
        errorMessage.value = response.error;
        return;
      }

      applySessionResponse(response);
    },
  );
}

function leaveGame() {
  socket.emit("leave-game", () => {
    clearSession();
    currentGame.value = null;
    yourColor.value = null;
    resultModalOpen.value = false;
    clearSelection();
    refreshGames();
  });
}

function requestRematch() {
  if (!currentGame.value) {
    return;
  }

  void unlockAudio();
  errorMessage.value = "";
  socket.emit("request-rematch", (response) => {
    if (!response.ok) {
      errorMessage.value = response.error;
    }
  });
}

function handleResizePointerDown(event) {
  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }

  resizeState.active = true;
  resizeState.pointerId = event.pointerId;
  resizeState.startX = event.clientX;
  resizeState.startY = event.clientY;
  resizeState.startSize = clampBoardSize(preferredBoardSize.value);
}

function sendMove(from, to) {
  void unlockAudio();
  socket.emit(
    "make-move",
    {
      from,
      to,
    },
    (response) => {
      if (!response.ok) {
        errorMessage.value = response.error;
        playInvalidSound();
        return;
      }

      errorMessage.value = "";
      clearSelection();
    },
  );
}

function cancelRematch() {
  if (!currentGame.value) {
    return;
  }

  errorMessage.value = "";
  socket.emit("cancel-rematch", (response) => {
    if (!response.ok) {
      errorMessage.value = response.error;
    }
  });
}

function handleSquareClick(square) {
  if (shouldIgnoreClick()) {
    return;
  }

  const game = currentGame.value;
  if (!game) {
    return;
  }

  const piece = game.board[square.row][square.col];
  if (selectedSquare.value && legalMoveSet.value.has(square.key)) {
    sendMove(selectedSquare.value, { row: square.row, col: square.col });
    return;
  }

  if (!isYourTurn.value) {
    clearSelection();
    return;
  }

  if (piece?.color === yourColor.value) {
    if (sameSquare(selectedSquare.value, square)) {
      clearSelection();
      return;
    }

    void unlockAudio();
    selectedSquare.value = { row: square.row, col: square.col };
    playSelectSound();
    return;
  }

  if (selectedSquare.value) {
    void unlockAudio();
    playInvalidSound();
  }

  clearSelection();
}

function handleSquarePointerDown(square, event) {
  if ((event.pointerType === "mouse" && event.button !== 0) || !isYourTurn.value) {
    return;
  }

  const piece = currentGame.value?.board?.[square.row]?.[square.col];
  if (piece?.color !== yourColor.value) {
    return;
  }

  dragState.phase = "pending";
  dragState.pointerId = event.pointerId;
  dragState.from = { row: square.row, col: square.col };
  dragState.piece = piece;
  dragState.hoverSquare = { row: square.row, col: square.col, key: square.key };
  dragState.startX = event.clientX;
  dragState.startY = event.clientY;
  dragState.pointerX = event.clientX;
  dragState.pointerY = event.clientY;
}

function handleGlobalPointerMove(event) {
  if (resizeState.active && resizeState.pointerId === event.pointerId) {
    const deltaX = event.clientX - resizeState.startX;
    const deltaY = event.clientY - resizeState.startY;
    const dominantDelta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
    saveStoredBoardSize(clampBoardSize(resizeState.startSize + dominantDelta));
    return;
  }

  if (
    dragState.phase === "idle" ||
    dragState.pointerId === null ||
    event.pointerId !== dragState.pointerId
  ) {
    return;
  }

  dragState.pointerX = event.clientX;
  dragState.pointerY = event.clientY;

  if (dragState.phase === "pending") {
    const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
    if (distance < 6) {
      return;
    }

    dragState.phase = "dragging";
    selectedSquare.value = { ...dragState.from };
    void unlockAudio();
    playSelectSound();
  }

  if (dragState.phase === "dragging") {
    dragState.hoverSquare = getSquareFromPoint(event.clientX, event.clientY);
  }
}

function handleGlobalPointerUp(event) {
  if (resizeState.active && resizeState.pointerId === event.pointerId) {
    resetResizeState();
    return;
  }

  if (
    dragState.phase === "idle" ||
    dragState.pointerId === null ||
    event.pointerId !== dragState.pointerId
  ) {
    return;
  }

  if (dragState.phase === "dragging") {
    const from = dragState.from ? { ...dragState.from } : null;
    const target = dragState.hoverSquare ?? getSquareFromPoint(event.clientX, event.clientY);
    lastDragEndedAt.value = Date.now();

    if (from && target && !sameSquare(from, target) && legalMoveSet.value.has(target.key)) {
      sendMove(from, { row: target.row, col: target.col });
    } else {
      if (target && from && !sameSquare(from, target)) {
        void unlockAudio();
        playInvalidSound();
      }

      if (from) {
        selectedSquare.value = from;
      }
    }
  }

  resetDragState();
}

function handleGlobalPointerCancel(event) {
  if (resizeState.pointerId !== null && event.pointerId === resizeState.pointerId) {
    resetResizeState();
    return;
  }

  if (dragState.pointerId !== null && event.pointerId === dragState.pointerId) {
    resetDragState();
  }
}

function handleGameState(game) {
  if (!currentGame.value || currentGame.value.id !== game.id) {
    return;
  }

  const previousGame = currentGame.value;
  currentGame.value = game;
  playGameStateSound(previousGame, game);
  setResultModalVisibility(game, previousGame);
  if (dragState.phase !== "idle") {
    resetDragState();
  }
  if (game.status !== "active") {
    clearSelection();
  }
}

function handleLobbyUpdate(nextGames) {
  games.value = nextGames;
}

function handleConnect() {
  connectionState.value = "connected";
  errorMessage.value = "";
  restoreSavedGame();
  refreshGames();
}

function handleDisconnect() {
  connectionState.value = "disconnected";
}

onMounted(() => {
  if (session.value?.playerName) {
    playerName.value = session.value.playerName;
  }

  socket.on("game:state", handleGameState);
  socket.on("lobby:update", handleLobbyUpdate);
  socket.on("connect", handleConnect);
  socket.on("disconnect", handleDisconnect);
  socket.on("connect_error", () => {
    connectionState.value = "disconnected";
    errorMessage.value = "Нет соединения с сервером.";
  });
  updateBoardSizeLimit();
  reconnectBoardHostObserver();
  window.addEventListener("resize", updateBoardSizeLimit);
  window.addEventListener("pointermove", handleGlobalPointerMove);
  window.addEventListener("pointerup", handleGlobalPointerUp);
  window.addEventListener("pointercancel", handleGlobalPointerCancel);

  refreshGames();
});

onBeforeUnmount(() => {
  socket.off("game:state", handleGameState);
  socket.off("lobby:update", handleLobbyUpdate);
  socket.off("connect", handleConnect);
  socket.off("disconnect", handleDisconnect);
  boardHostResizeObserver?.disconnect();
  window.removeEventListener("resize", updateBoardSizeLimit);
  window.removeEventListener("pointermove", handleGlobalPointerMove);
  window.removeEventListener("pointerup", handleGlobalPointerUp);
  window.removeEventListener("pointercancel", handleGlobalPointerCancel);
});

watch(boardHostElement, async () => {
  await nextTick();
  updateBoardSizeLimit();
  reconnectBoardHostObserver();
});
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <section class="panel brand-panel">
        <h1>Chess 16x16 Online</h1>
        <p class="muted">{{ VARIANT_SETUP_DESCRIPTION }}</p>
        <span class="connection-chip" :data-state="connectionState">
          {{ connectionState === "connected" ? "Сервер онлайн" : "Сервер недоступен" }}
        </span>
      </section>

      <section class="panel">
        <h2>Игрок</h2>
        <label class="field">
          <span>Имя</span>
          <input v-model="playerName" maxlength="24" placeholder="Введите имя" />
        </label>
      </section>

      <section class="panel">
        <h2>Создать игру</h2>
        <label class="field">
          <span>Название комнаты</span>
          <input v-model="createForm.name" maxlength="32" placeholder="Партия 16x16" />
        </label>
        <label class="field">
          <span>Пароль</span>
          <input
            v-model="createForm.password"
            maxlength="32"
            placeholder="Необязательно"
            type="password"
          />
        </label>
        <label class="field">
          <span>Контроль времени, минут</span>
          <input v-model.number="createForm.timeLimitMinutes" min="1" max="180" type="number" />
        </label>
        <button class="primary-button" @click="createGame">Создать комнату</button>
      </section>

      <section class="panel">
        <div class="panel-row">
          <h2>Список игр</h2>
          <button class="secondary-button" @click="refreshGames">Обновить</button>
        </div>

        <div v-if="games.length" class="game-list">
          <article v-for="game in games" :key="game.id" class="game-card">
            <div class="game-card-header">
              <strong>{{ game.name }}</strong>
              <span class="state-badge" :data-state="game.status">
                {{ game.status === "waiting" ? "Ожидание" : "В игре" }}
              </span>
            </div>
            <p class="game-card-meta">
              {{ game.players.white || "Белые" }} vs {{ game.players.black || "Ожидание" }}
            </p>
            <p class="game-card-meta">Время: {{ game.timeLimitMinutes }} мин.</p>
            <p class="game-card-meta">ID: {{ game.id }}</p>
            <label v-if="game.hasPassword" class="field compact-field">
              <span>Пароль</span>
              <input v-model="joinPasswords[game.id]" type="password" placeholder="Введите пароль" />
            </label>
            <button
              class="secondary-button wide-button"
              :disabled="game.status !== 'waiting' || currentGame"
              @click="joinGame(game.id)"
            >
              Подключиться
            </button>
          </article>
        </div>

        <p v-else class="muted">Пока нет доступных комнат.</p>
      </section>

      <section v-if="currentGame" class="panel">
        <h2>Текущая игра</h2>
        <p class="game-card-meta">Комната: {{ currentGame.name }}</p>
        <p class="game-card-meta">
          Вы играете за: {{ yourColor === "white" ? "белых" : "черных" }}
        </p>
        <button
          v-if="currentGame.status === 'finished' && !resultModalOpen"
          class="secondary-button wide-button reopen-result-button"
          @click="resultModalOpen = true"
        >
          Показать результат
        </button>
        <button class="danger-button wide-button" @click="leaveGame">Покинуть игру</button>
      </section>

      <section v-if="errorMessage" class="panel error-panel">
        <strong>Ошибка</strong>
        <p>{{ errorMessage }}</p>
      </section>
    </aside>

    <main class="stage">
      <section v-if="currentGame" class="board-stage">
        <header class="status-strip">
          <div>
            <p class="eyebrow">Статус партии</p>
            <h2>{{ statusText }}</h2>
          </div>
          <div class="timers">
            <div class="timer-card" :data-active="currentGame.activeColor === 'white'">
              <span>Белые</span>
              <strong>{{ clockLabel(currentGame.clocks.white) }}</strong>
            </div>
            <div class="timer-card" :data-active="currentGame.activeColor === 'black'">
              <span>Черные</span>
              <strong>{{ clockLabel(currentGame.clocks.black) }}</strong>
            </div>
          </div>
        </header>

        <div class="game-layout">
          <div ref="boardHostElement" class="board-host">
            <div class="board-wrapper cg-wrap">
              <div ref="boardElement" class="board" :style="boardStyle">
                <button
                  v-for="square in displayedSquares"
                  :key="square.key"
                  class="square"
                  :class="{
                    'square-dark': square.isDark,
                    'square-occupied': Boolean(square.piece),
                    'square-selected': square.isSelected,
                    'square-drag-hover': square.isDragHover,
                    'square-target': square.isLegalTarget,
                    'square-last': square.isLastMove,
                  }"
                  @pointerdown="handleSquarePointerDown(square, $event)"
                  @click="handleSquareClick(square)"
                >
                  <span v-if="square.showRank" class="rank-label">{{ square.labelRank }}</span>
                  <span v-if="square.showFile" class="file-label">{{ square.labelFile }}</span>
                  <piece
                    v-if="square.piece"
                    class="piece"
                    :class="[pieceClass(square.piece), { 'piece-hidden': square.isDragOrigin }]"
                  />
                </button>
              </div>
              <button
                class="board-resize-handle"
                title="Изменить размер доски"
                @pointerdown.stop.prevent="handleResizePointerDown"
              />
              <piece
                v-if="dragPieceStyle && dragState.piece"
                class="piece drag-piece"
                :class="pieceClass(dragState.piece)"
                :style="dragPieceStyle"
              />
            </div>
          </div>

          <aside class="game-info">
            <section class="panel">
              <h2>Игроки</h2>
              <p class="player-line">
                <span>Белые</span>
                <strong>{{ currentGame.players.white?.name || "Ожидание" }}</strong>
              </p>
              <p class="player-line">
                <span>Черные</span>
                <strong>{{ currentGame.players.black?.name || "Ожидание" }}</strong>
              </p>
            </section>

            <section class="panel">
              <h2>Ходы</h2>
              <div v-if="moveLog.length" class="move-log">
                <p v-for="move in moveLog" :key="move.moveNumber">
                  {{ move.moveNumber }}. {{ move.text }}
                </p>
              </div>
              <p v-else class="muted">Ходов пока нет.</p>
            </section>
          </aside>
        </div>
      </section>

      <section v-else class="empty-state">
        <div class="empty-card">
          <p class="eyebrow">Онлайн режим</p>
          <h2>Создайте комнату или войдите в открытую игру</h2>
          <p>
            Сервер хранит список активных партий в памяти, синхронизирует ходы, очередь хода и
            шахматные часы. Победа фиксируется по мату, времени, сдаче или отключению соперника.
          </p>
        </div>
      </section>
    </main>

    <div
      v-if="currentGame?.status === 'finished' && resultModalOpen"
      class="modal-backdrop"
      @click.self="resultModalOpen = false"
    >
      <section class="result-modal">
        <p class="eyebrow">Партия завершена</p>
        <h2>{{ resultHeadline }}</h2>
        <p class="modal-text">{{ resultDescription }}</p>
        <p class="modal-text">{{ rematchStatusText }}</p>

        <div class="modal-players">
          <div class="modal-player-card">
            <span>Белые</span>
            <strong>{{ currentGame.players.white?.name || "Ожидание" }}</strong>
          </div>
          <div class="modal-player-card">
            <span>Черные</span>
            <strong>{{ currentGame.players.black?.name || "Ожидание" }}</strong>
          </div>
        </div>

        <div class="modal-actions">
          <button v-if="canRequestRematch" class="primary-button" @click="requestRematch">
            {{ hasIncomingRematchRequest ? "Принять реванш" : "Запросить реванш" }}
          </button>
          <button v-if="canCancelRematch" class="secondary-button" @click="cancelRematch">
            Отменить запрос
          </button>
          <button class="secondary-button" @click="resultModalOpen = false">Закрыть</button>
          <button class="danger-button" @click="leaveGame">Покинуть комнату</button>
        </div>
      </section>
    </div>
  </div>
</template>
