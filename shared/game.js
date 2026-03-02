export const BOARD_SIZE = 16;
export const FILES = "abcdefghijklmnop";
export const COLORS = {
  WHITE: "white",
  BLACK: "black",
};

export const PIECE_SYMBOLS = {
  white: {
    p: "♙",
    r: "♖",
    n: "♘",
    b: "♗",
    q: "♕",
    k: "♔",
  },
  black: {
    p: "♟",
    r: "♜",
    n: "♞",
    b: "♝",
    q: "♛",
    k: "♚",
  },
};

export const VARIANT_SETUP_DESCRIPTION =
  "Доска 16x16, по 16 пешек на второй линии, а вся первая линия заполнена фигурами в порядке: 2 ладьи, 2 коня, 2 слона, 2 ферзя, король, пешка, 2 слона, 2 коня, 2 ладьи.";

const WHITE_HOME_ROW = BOARD_SIZE - 1;
const BLACK_HOME_ROW = 0;
const WHITE_PAWN_ROW = BOARD_SIZE - 2;
const BLACK_PAWN_ROW = 1;
const BACK_RANK_SEQUENCE = ["r", "r", "n", "n", "b", "b", "q", "q", "k", "p", "b", "b", "n", "n", "r", "r"];

const KNIGHT_STEPS = [
  [-2, -1],
  [-2, 1],
  [-1, -2],
  [-1, 2],
  [1, -2],
  [1, 2],
  [2, -1],
  [2, 1],
];

const KING_STEPS = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

const ROOK_DIRECTIONS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

const BISHOP_DIRECTIONS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

function createPiece(color, type) {
  return { color, type };
}

export function oppositeColor(color) {
  return color === COLORS.WHITE ? COLORS.BLACK : COLORS.WHITE;
}

export function insideBoard(row, col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

export function cloneBoard(board) {
  return board.map((row) => row.map((piece) => (piece ? { ...piece } : null)));
}

export function createInitialBoard() {
  const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  const blackBackRank = [...BACK_RANK_SEQUENCE].reverse();

  for (let col = 0; col < BOARD_SIZE; col += 1) {
    board[BLACK_PAWN_ROW][col] = createPiece(COLORS.BLACK, "p");
    board[WHITE_PAWN_ROW][col] = createPiece(COLORS.WHITE, "p");
  }

  BACK_RANK_SEQUENCE.forEach((type, index) => {
    board[WHITE_HOME_ROW][index] = createPiece(COLORS.WHITE, type);
    board[BLACK_HOME_ROW][index] = createPiece(COLORS.BLACK, blackBackRank[index]);
  });

  return board;
}

export function getPiece(board, square) {
  if (!square || !insideBoard(square.row, square.col)) {
    return null;
  }

  return board[square.row][square.col];
}

export function sameSquare(first, second) {
  return Boolean(first && second && first.row === second.row && first.col === second.col);
}

export function toNotation(square) {
  if (!square || !insideBoard(square.row, square.col)) {
    return "";
  }

  return `${FILES[square.col]}${BOARD_SIZE - square.row}`;
}

function findKing(board, color) {
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const piece = board[row][col];
      if (piece?.type === "k" && piece.color === color) {
        return { row, col };
      }
    }
  }

  return null;
}

function collectSlidingTargets(board, from, directions, includeOwnOnAttack = false) {
  const piece = getPiece(board, from);
  const moves = [];

  for (const [rowStep, colStep] of directions) {
    let row = from.row + rowStep;
    let col = from.col + colStep;

    while (insideBoard(row, col)) {
      const occupant = board[row][col];

      if (!occupant) {
        moves.push({ row, col });
        row += rowStep;
        col += colStep;
        continue;
      }

      if (includeOwnOnAttack || occupant.color !== piece.color) {
        moves.push({ row, col });
      }

      break;
    }
  }

  return moves;
}

function getAttackSquares(board, from) {
  const piece = getPiece(board, from);
  if (!piece) {
    return [];
  }

  switch (piece.type) {
    case "p": {
      const direction = piece.color === COLORS.WHITE ? -1 : 1;
      return [-1, 1]
        .map((colOffset) => ({
          row: from.row + direction,
          col: from.col + colOffset,
        }))
        .filter((square) => insideBoard(square.row, square.col));
    }
    case "n":
      return KNIGHT_STEPS.map(([rowStep, colStep]) => ({
        row: from.row + rowStep,
        col: from.col + colStep,
      })).filter((square) => insideBoard(square.row, square.col));
    case "b":
      return collectSlidingTargets(board, from, BISHOP_DIRECTIONS, true);
    case "r":
      return collectSlidingTargets(board, from, ROOK_DIRECTIONS, true);
    case "q":
      return collectSlidingTargets(
        board,
        from,
        [...ROOK_DIRECTIONS, ...BISHOP_DIRECTIONS],
        true,
      );
    case "k":
      return KING_STEPS.map(([rowStep, colStep]) => ({
        row: from.row + rowStep,
        col: from.col + colStep,
      })).filter((square) => insideBoard(square.row, square.col));
    default:
      return [];
  }
}

function getPseudoLegalMoves(board, from) {
  const piece = getPiece(board, from);
  if (!piece) {
    return [];
  }

  switch (piece.type) {
    case "p": {
      const moves = [];
      const direction = piece.color === COLORS.WHITE ? -1 : 1;
      const startRow = piece.color === COLORS.WHITE ? WHITE_PAWN_ROW : BLACK_PAWN_ROW;
      const oneForward = { row: from.row + direction, col: from.col };
      const twoForward = { row: from.row + direction * 2, col: from.col };

      if (insideBoard(oneForward.row, oneForward.col) && !getPiece(board, oneForward)) {
        moves.push(oneForward);

        if (
          from.row === startRow &&
          insideBoard(twoForward.row, twoForward.col) &&
          !getPiece(board, twoForward)
        ) {
          moves.push(twoForward);
        }
      }

      for (const colOffset of [-1, 1]) {
        const captureSquare = { row: from.row + direction, col: from.col + colOffset };
        const targetPiece = getPiece(board, captureSquare);
        if (targetPiece && targetPiece.color !== piece.color) {
          moves.push(captureSquare);
        }
      }

      return moves;
    }
    case "n":
      return KNIGHT_STEPS.map(([rowStep, colStep]) => ({
        row: from.row + rowStep,
        col: from.col + colStep,
      })).filter((square) => {
        if (!insideBoard(square.row, square.col)) {
          return false;
        }

        const occupant = getPiece(board, square);
        return !occupant || occupant.color !== piece.color;
      });
    case "b":
      return collectSlidingTargets(board, from, BISHOP_DIRECTIONS);
    case "r":
      return collectSlidingTargets(board, from, ROOK_DIRECTIONS);
    case "q":
      return collectSlidingTargets(board, from, [...ROOK_DIRECTIONS, ...BISHOP_DIRECTIONS]);
    case "k":
      return KING_STEPS.map(([rowStep, colStep]) => ({
        row: from.row + rowStep,
        col: from.col + colStep,
      })).filter((square) => {
        if (!insideBoard(square.row, square.col)) {
          return false;
        }

        const occupant = getPiece(board, square);
        return !occupant || occupant.color !== piece.color;
      });
    default:
      return [];
  }
}

export function isSquareAttacked(board, square, byColor) {
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const piece = board[row][col];
      if (!piece || piece.color !== byColor) {
        continue;
      }

      const attacks = getAttackSquares(board, { row, col });
      if (attacks.some((attackSquare) => sameSquare(attackSquare, square))) {
        return true;
      }
    }
  }

  return false;
}

export function isKingInCheck(board, color) {
  const kingSquare = findKing(board, color);
  if (!kingSquare) {
    return true;
  }

  return isSquareAttacked(board, kingSquare, oppositeColor(color));
}

function simulateMove(board, from, to) {
  const nextBoard = cloneBoard(board);
  const movingPiece = nextBoard[from.row][from.col];
  const capturedPiece = nextBoard[to.row][to.col];

  nextBoard[from.row][from.col] = null;
  nextBoard[to.row][to.col] = movingPiece;

  let promotion = null;
  if (
    movingPiece.type === "p" &&
    ((movingPiece.color === COLORS.WHITE && to.row === BLACK_HOME_ROW) ||
      (movingPiece.color === COLORS.BLACK && to.row === WHITE_HOME_ROW))
  ) {
    nextBoard[to.row][to.col] = { ...movingPiece, type: "q" };
    promotion = "q";
  }

  return {
    board: nextBoard,
    movingPiece,
    capturedPiece,
    promotion,
  };
}

export function getLegalMoves(board, from, activeColor = null) {
  const piece = getPiece(board, from);
  if (!piece || (activeColor && piece.color !== activeColor)) {
    return [];
  }

  return getPseudoLegalMoves(board, from).filter((target) => {
    const nextState = simulateMove(board, from, target);
    return !isKingInCheck(nextState.board, piece.color);
  });
}

export function getPremoveTargets(board, from, activeColor = null) {
  const piece = getPiece(board, from);
  if (!piece || (activeColor && piece.color !== activeColor)) {
    return [];
  }

  return getPseudoLegalMoves(board, from);
}

export function playerHasLegalMove(board, color) {
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const piece = board[row][col];
      if (piece?.color !== color) {
        continue;
      }

      if (getLegalMoves(board, { row, col }, color).length > 0) {
        return true;
      }
    }
  }

  return false;
}

export function resolveBoardState(board, activeColor) {
  const whiteKing = findKing(board, COLORS.WHITE);
  const blackKing = findKing(board, COLORS.BLACK);

  if (!whiteKing && !blackKing) {
    return { status: "finished", winner: null, reason: "mutual-destruction" };
  }

  if (!whiteKing) {
    return { status: "finished", winner: COLORS.BLACK, reason: "king-captured" };
  }

  if (!blackKing) {
    return { status: "finished", winner: COLORS.WHITE, reason: "king-captured" };
  }

  if (playerHasLegalMove(board, activeColor)) {
    return { status: "active", winner: null, reason: null };
  }

  if (isKingInCheck(board, activeColor)) {
    return { status: "finished", winner: oppositeColor(activeColor), reason: "checkmate" };
  }

  return { status: "finished", winner: null, reason: "stalemate" };
}

export function tryMove(board, from, to, activeColor) {
  const movingPiece = getPiece(board, from);
  if (!movingPiece) {
    return { ok: false, error: "На выбранной клетке нет фигуры." };
  }

  if (movingPiece.color !== activeColor) {
    return { ok: false, error: "Сейчас ход другого цвета." };
  }

  const legalMoves = getLegalMoves(board, from, activeColor);
  if (!legalMoves.some((target) => sameSquare(target, to))) {
    return { ok: false, error: "Недопустимый ход." };
  }

  const nextState = simulateMove(board, from, to);
  const move = {
    color: movingPiece.color,
    piece: movingPiece.type,
    from,
    to,
    fromNotation: toNotation(from),
    toNotation: toNotation(to),
    captured: nextState.capturedPiece?.type ?? null,
    promotion: nextState.promotion,
    text: `${movingPiece.color === COLORS.WHITE ? "Белые" : "Черные"}: ${toNotation(from)} -> ${toNotation(to)}`,
  };

  return {
    ok: true,
    board: nextState.board,
    move,
    resolution: resolveBoardState(nextState.board, oppositeColor(activeColor)),
  };
}
