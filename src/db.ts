// src/db.ts
import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "app.sqlite");

export async function createDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const SQL = await initSqlJs({});
  const fileExists = fs.existsSync(DB_FILE);

  const db = fileExists
    ? new SQL.Database(new Uint8Array(fs.readFileSync(DB_FILE)))
    : new SQL.Database();

  // ---- base schema (new DBs get everything) ----
  db.run(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      clan_name TEXT NOT NULL,
      host_password_hash TEXT NOT NULL,
      board_size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      turn_team_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      discord_webhook_url TEXT NULL,
      board_url TEXT NULL,
      starts_at TEXT NULL,
      ends_at TEXT NULL,
      display_name TEXT NULL,
      join_code_hash TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      team_index INTEGER NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      awaiting_proof INTEGER NOT NULL DEFAULT 0,
      pending_tile INTEGER NULL
    );

    CREATE TABLE IF NOT EXISTS registrations (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      rsn TEXT NOT NULL,
      token_jti TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (game_id, rsn)
    );

    CREATE TABLE IF NOT EXISTS tile_tasks (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      tile_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NULL,
      description TEXT NULL,
      jump_to INTEGER NULL,
      UNIQUE (game_id, tile_index)
    );

    CREATE TABLE IF NOT EXISTS proofs (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      tile_index INTEGER NOT NULL,
      rsn TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (game_id, team_id, tile_index)
    );

    CREATE TABLE IF NOT EXISTS events (
      game_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (game_id, seq)
    );

    CREATE TABLE IF NOT EXISTS game_boards (
      game_id TEXT PRIMARY KEY,
      board_json TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_teams_game_teamindex ON teams(game_id, team_index);
    CREATE INDEX IF NOT EXISTS idx_regs_game_team ON registrations(game_id, team_id);
  `);

  // ---- lightweight migrations for older DBs ----
  // sql.js SQLite doesn't support "ADD COLUMN IF NOT EXISTS", so try and ignore errors.

  try { db.run("ALTER TABLE games ADD COLUMN board_url TEXT NULL;"); } catch {}
  try { db.run("ALTER TABLE games ADD COLUMN starts_at TEXT NULL;"); } catch {}
  try { db.run("ALTER TABLE games ADD COLUMN ends_at TEXT NULL;"); } catch {}
  try { db.run("ALTER TABLE games ADD COLUMN display_name TEXT NULL;"); } catch {}
  try { db.run("ALTER TABLE games ADD COLUMN join_code_hash TEXT NULL;"); } catch {}

  function persist() {
    const data = db.export();
    fs.writeFileSync(DB_FILE, Buffer.from(data));
  }

  // IMPORTANT: persist immediately after successful migrations so future boots are clean
  // (This prevents “no such column” on next run if the process exits early.)
  persist();

  return { db, persist };
}
