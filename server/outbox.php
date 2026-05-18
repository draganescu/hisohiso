<?php
declare(strict_types=1);

require_once __DIR__ . '/utils.php';
require_once __DIR__ . '/db.php';

const OUTBOX_DEFAULT_DIR = '/data/rooms';
const OUTBOX_MAX_ROWS = 500;
const OUTBOX_TTL_SECONDS = 86400; // 24h

function outbox_root(): string
{
    $env = getenv('OUTBOX_DIR');
    return is_string($env) && $env !== '' ? $env : OUTBOX_DEFAULT_DIR;
}

// Defense in depth: the outbox file path is built by concatenating room_hash.
// Currently rooms.room_hash is constrained to ^[0-9a-f]{64}$ on INSERT via
// valid_room_hash() in utils.php, so traversal is structurally impossible —
// but any future endpoint that bypasses the rooms-table guard before opening
// an outbox would re-open the path. Validating here makes the file ops safe
// regardless of who calls us.
function outbox_path(string $room_hash): string
{
    if (!valid_room_hash($room_hash)) {
        throw new RuntimeException('outbox: invalid room_hash');
    }
    return outbox_root() . '/' . $room_hash . '.sqlite';
}

function outbox_ensure_dir(): void
{
    $dir = outbox_root();
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
    }
}

function outbox_open(string $room_hash): PDO
{
    outbox_ensure_dir();
    $pdo = new PDO('sqlite:' . outbox_path($room_hash), null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL;');
    // 5s busy_timeout makes BEGIN IMMEDIATE wait for the other side instead of
    // failing immediately when /message and /settings(off) collide on a busy
    // hub — see outbox_append + outbox_wipe for the serialization contract.
    $pdo->exec('PRAGMA busy_timeout = 5000;');
    $pdo->exec('CREATE TABLE IF NOT EXISTS messages (
        msg_id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        sender_hash TEXT,
        encrypted_payload TEXT NOT NULL
    );');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);');
    return $pdo;
}

// outbox_append and outbox_wipe both BEGIN IMMEDIATE on the same outbox file,
// so they cannot run concurrently. The re-check of room_catch_up_enabled
// HAPPENS INSIDE that transaction — which closes the publish→append TOCTOU
// window where /settings(catch_up=off) used to be able to wipe between a
// /message handler's check and its write. The full guarantee:
//
//   • /message reads catch_up=1 (stale or fresh — doesn't matter), publishes,
//     then calls outbox_append. outbox_append takes IMMEDIATE on the outbox.
//   • /settings(off) does UPDATE rooms.catch_up=0, then outbox_wipe — which
//     tries to take IMMEDIATE on the same outbox and blocks until /message's
//     transaction commits.
//   • Inside the lock, outbox_append RE-READS catch_up from chat.sqlite. If
//     /settings's UPDATE landed first, the re-read returns 0 and we abort the
//     INSERT — no orphan message. If /settings hadn't UPDATEd yet, we insert,
//     commit, and /settings then deletes our row.
//   • outbox_wipe uses DELETE FROM messages (not file unlink) precisely so
//     this lock is honored — unlinking the file would bypass SQLite's locks.
function outbox_append(string $room_hash, string $msg_id, string $encrypted_payload, ?string $sender_hash): void
{
    $pdo = outbox_open($room_hash);
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        // Re-read catch_up_enabled under the outbox lock so /settings(off)
        // cannot wipe between the read and the INSERT.
        $stmt = db()->prepare('SELECT catch_up_enabled FROM rooms WHERE room_hash = :room_hash');
        $stmt->execute([':room_hash' => $room_hash]);
        $enabled = (bool) $stmt->fetchColumn();
        if (!$enabled) {
            $pdo->exec('ROLLBACK');
            return;
        }

        $stmt = $pdo->prepare('INSERT OR IGNORE INTO messages (msg_id, ts, sender_hash, encrypted_payload)
            VALUES (:msg_id, :ts, :sender_hash, :encrypted_payload)');
        $stmt->execute([
            ':msg_id' => $msg_id,
            ':ts' => time(),
            ':sender_hash' => $sender_hash,
            ':encrypted_payload' => $encrypted_payload,
        ]);

        // TTL prune
        $ttl_cutoff = time() - OUTBOX_TTL_SECONDS;
        $pdo->prepare('DELETE FROM messages WHERE ts < :cutoff')->execute([':cutoff' => $ttl_cutoff]);

        // Count cap — delete everything past the newest OUTBOX_MAX_ROWS.
        $pdo->exec('DELETE FROM messages WHERE msg_id IN (
            SELECT msg_id FROM messages ORDER BY ts DESC LIMIT -1 OFFSET ' . OUTBOX_MAX_ROWS . '
        )');

        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

function outbox_fetch(string $room_hash, int $since_ts, int $limit = 500): array
{
    if (!file_exists(outbox_path($room_hash))) {
        return [];
    }
    $pdo = outbox_open($room_hash);

    // Lazy TTL prune on read.
    $ttl_cutoff = time() - OUTBOX_TTL_SECONDS;
    $pdo->prepare('DELETE FROM messages WHERE ts < :cutoff')->execute([':cutoff' => $ttl_cutoff]);

    $stmt = $pdo->prepare('SELECT msg_id, ts, sender_hash, encrypted_payload
        FROM messages WHERE ts > :since ORDER BY ts ASC LIMIT :limit');
    $stmt->bindValue(':since', max(0, $since_ts), PDO::PARAM_INT);
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->execute();
    return $stmt->fetchAll();
}

function outbox_wipe(string $room_hash): void
{
    $path = outbox_path($room_hash);
    if (!file_exists($path)) {
        return;
    }
    // DELETE inside an IMMEDIATE transaction so a concurrent outbox_append
    // either runs before us (we delete its row afterwards) or sees our
    // catch_up=0 inside its own IMMEDIATE re-read and aborts. Switching from
    // file unlink to row delete is what makes that serialization possible;
    // unlinking bypasses SQLite's locking and used to strand orphan rows.
    $pdo = outbox_open($room_hash);
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $pdo->exec('DELETE FROM messages');
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}
