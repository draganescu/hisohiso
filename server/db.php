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
    // Without this, concurrent writers (e.g. /presence on room switch racing
    // the 20s presence interval, plus participant_count's DELETE in /api/rooms)
    // return SQLITE_BUSY immediately and the uncaught PDOException becomes a 500.
    // Matches the 5000ms used on the outbox SQLite in outbox.php.
    $pdo->exec('PRAGMA busy_timeout = 5000;');
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
