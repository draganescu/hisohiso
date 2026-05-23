<?php
declare(strict_types=1);

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $path = getenv('CHAT_DB_PATH') ?: '/data/chat.sqlite';
    $dir = dirname($path);
    if (!is_dir($dir)) {
        mkdir($dir, 0775, true);
    }

    $pdo = new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);

    $pdo->exec('PRAGMA journal_mode = WAL;');
    // synchronous=NORMAL is SQLite's recommended pairing with WAL: it skips the
    // post-commit DB-header fsync (still fsyncs WAL at checkpoint time), which
    // dropped per-commit latency and eliminated the writer-lock pile-up that
    // produced "database is locked" 500s past the 60s busy_timeout. The cost
    // is that a power loss can lose the very latest committed transactions —
    // for chat presence (which is sampled, not authoritative) that's fine.
    // synchronous=FULL (the PDO_SQLite default) was double-fsyncing every
    // commit and stalling concurrent writers behind disk i/o.
    $pdo->exec('PRAGMA synchronous = NORMAL;');
    // Do NOT set PRAGMA busy_timeout here. PDO_SQLite's default is 60000ms;
    // a previous version of this file set 5000ms thinking the default was 0,
    // which actively REDUCED tolerance for writer contention and produced
    // hundreds of 'database is locked' 500s/day under normal load. The 60s
    // default is more than enough once synchronous=NORMAL drops commit latency.
    $pdo->exec('PRAGMA foreign_keys = ON;');

    $pdo->exec('CREATE TABLE IF NOT EXISTS rooms (
        room_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        catch_up_enabled INTEGER NOT NULL DEFAULT 0
    );');

    // Migrate existing rooms tables that pre-date catch_up_enabled.
    $has_catch_up = false;
    foreach ($pdo->query('PRAGMA table_info(rooms)') as $col) {
        if (($col['name'] ?? '') === 'catch_up_enabled') {
            $has_catch_up = true;
            break;
        }
    }
    if (!$has_catch_up) {
        $pdo->exec('ALTER TABLE rooms ADD COLUMN catch_up_enabled INTEGER NOT NULL DEFAULT 0');
    }

    $pdo->exec('CREATE TABLE IF NOT EXISTS participants (
        token_hash TEXT PRIMARY KEY,
        room_hash TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        pending INTEGER NOT NULL DEFAULT 0,
        claim_tag_hash TEXT,
        FOREIGN KEY(room_hash) REFERENCES rooms(room_hash) ON DELETE CASCADE
    );');

    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_hash);');

    // Migrate existing participants tables that pre-date the claim binding columns.
    // Existing rows default to pending=0 (already active), which is correct —
    // they were minted before this protection existed.
    $existing_cols = [];
    foreach ($pdo->query('PRAGMA table_info(participants)') as $col) {
        $existing_cols[(string) ($col['name'] ?? '')] = true;
    }
    if (!isset($existing_cols['pending'])) {
        $pdo->exec('ALTER TABLE participants ADD COLUMN pending INTEGER NOT NULL DEFAULT 0');
    }
    if (!isset($existing_cols['claim_tag_hash'])) {
        $pdo->exec('ALTER TABLE participants ADD COLUMN claim_tag_hash TEXT');
    }

    $pdo->exec('CREATE TABLE IF NOT EXISTS presence (
        token_hash TEXT PRIMARY KEY,
        room_hash TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        FOREIGN KEY(token_hash) REFERENCES participants(token_hash) ON DELETE CASCADE,
        FOREIGN KEY(room_hash) REFERENCES rooms(room_hash) ON DELETE CASCADE
    );');

    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_presence_room ON presence(room_hash);');

    return $pdo;
}
