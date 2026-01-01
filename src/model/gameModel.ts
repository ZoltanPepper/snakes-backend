// src/model/gameModel.ts

/**
 * Authoritative backend game model helpers
 *
 * Contracts:
 * - Tile indices are 0..boardSize inclusive
 * - Finish tile === boardSize
 * - Team position always within bounds
 * - awaiting_proof + pending_tile always move together
 * - Jump resolution is single-step only
 */

export type TileKind = "empty" | "task" | "jump" | "boss";

export interface Game {
  id: string;
  clanName: string;
  boardSize: number;
  status: "active" | "finished";
}

export interface Team {
  id: string;
  name: string;
  index: number;
  position: number; // 0..boardSize
  awaitingProof: boolean;
  pendingTile: number | null;
}

export interface Tile {
  index: number;
  kind: TileKind;
  title?: string | null;
  description?: string | null;
  jumpTo?: number | null;
}

/* -------------------- invariants -------------------- */

export function clampTile(n: number, boardSize: number): number {
  if (!Number.isInteger(n)) return 0;
  if (n < 0) return 0;
  if (n > boardSize) return boardSize;
  return n;
}

export function isProofTile(kind: TileKind): boolean {
  return kind === "task" || kind === "boss";
}

export function assertTileIndex(index: number, boardSize: number) {
  if (!Number.isInteger(index) || index < 0 || index > boardSize) {
    throw new Error(`Invalid tile index ${index} (0..${boardSize})`);
  }
}

/* -------------------- db readers -------------------- */

export function readGame(db: any, gameId: string): Game | null {
  const r = db.exec(
    "SELECT id, clan_name, board_size, status FROM games WHERE id = ? LIMIT 1",
    [gameId]
  );
  const row = r?.[0]?.values?.[0];
  if (!row) return null;

  return {
    id: String(row[0]),
    clanName: String(row[1]),
    boardSize: Number(row[2]),
    status: row[3] === "finished" ? "finished" : "active"
  };
}

export function readTeam(db: any, gameId: string, teamId: string): Team | null {
  const r = db.exec(
    `SELECT id, name, team_index, position, awaiting_proof, pending_tile
     FROM teams
     WHERE game_id = ? AND id = ?
     LIMIT 1`,
    [gameId, teamId]
  );
  const row = r?.[0]?.values?.[0];
  if (!row) return null;

  return {
    id: String(row[0]),
    name: String(row[1]),
    index: Number(row[2]),
    position: Number(row[3]),
    awaitingProof: Number(row[4]) === 1,
    pendingTile: row[5] === null ? null : Number(row[5])
  };
}

export function readTile(db: any, gameId: string, index: number): Tile {
  const r = db.exec(
    `SELECT kind, title, description, jump_to
     FROM tile_tasks
     WHERE game_id = ? AND tile_index = ?
     LIMIT 1`,
    [gameId, index]
  );

  const row = r?.[0]?.values?.[0];
  if (!row) {
    return { index, kind: "empty" };
  }

  return {
    index,
    kind: row[0] as TileKind,
    title: row[1] ?? null,
    description: row[2] ?? null,
    jumpTo: row[3] ?? null
  };
}

/* -------------------- movement logic -------------------- */

export interface RollResult {
  roll: number;
  from: number;
  to: number;
  jump: null | { from: number; to: number };
  needsProof: boolean;
  tileKind: TileKind;
}

/**
 * Resolves a dice roll + optional jump.
 * No DB writes — pure logic.
 */
export function resolveRoll(
  boardSize: number,
  from: number,
  roll: number,
  landingTile: Tile
): { to: number; jump: RollResult["jump"] } {
  let to = clampTile(from + roll, boardSize);
  let jump: RollResult["jump"] = null;

  if (landingTile.kind === "jump" && typeof landingTile.jumpTo === "number") {
    const jt = clampTile(landingTile.jumpTo, boardSize);
    jump = { from: to, to: jt };
    to = jt;
  }

  return { to, jump };
}

/* -------------------- state transitions -------------------- */

export function applyLanding(
  to: number,
  tile: Tile
): { awaitingProof: boolean; pendingTile: number | null } {
  const needsProof = isProofTile(tile.kind);
  return {
    awaitingProof: needsProof,
    pendingTile: needsProof ? to : null
  };
}

/* -------------------- guards -------------------- */

export function assertCanRoll(team: Team) {
  if (team.awaitingProof) {
    throw new Error("Team is awaiting proof");
  }
}

export function assertCanSubmitProof(team: Team) {
  if (!team.awaitingProof || team.pendingTile === null) {
    throw new Error("No proof expected");
  }
}