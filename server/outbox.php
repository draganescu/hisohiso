<?php
declare(strict_types=1);

require_once __DIR__ . '/utils.php';
require_once __DIR__ . '/db.php';

const OUTBOX_DEFAULT_DIR = '/data/rooms';
const OUTBOX_MAX_ROWS = 500;
// Content lifetime: after 24h we strip a message's encrypted payload but KEEP
// the row as a "tombstone" (see outbox_expire_and_prune). A returning member
// then catches up on a "a message expired before you saw it" marker instead of
// a silent gap — the old behavior deleted the row outright, so an offline user
// past the window learned nothing had ever arrived.
const OUTBOX_TTL_MS = 86400 * 1000; // 24h, in ms (matches publish_event_to's ms ts)
// Tombstone lifetime: how long the content-stripped marker row survives after
// its payload is gone. Past this the row is hard-deleted for good, so tombstones
// can't accumulate without bound. Kept well above OUTBOX_TTL_MS so a member who
// was offline for a few days still sees that messages came and went.
const OUTBOX_TOMBSTONE_TTL_MS = 7 * 86400 * 1000; // 7d, in ms

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

// Age out the outbox in two stages, plus enforce the row cap. Called on every
// append (inside its IMMEDIATE transaction) and lazily on every fetch, so an
// idle room still ages out on the next read.
//
//   1. Soft-expire (> OUTBOX_TTL_MS): blank the encrypted_payload and drop the
//      sender_hash, leaving a tombstone row (empty payload). The message content
//      is unrecoverable, and we deliberately forget WHO sent it — the marker
//      only says "a message was here and expired", never from whom. The row's
//      ts is preserved so catch-up ordering and the since_ts cursor still work.
//   2. Hard-delete (> OUTBOX_TOMBSTONE_TTL_MS): remove the tombstone entirely.
//   3. Row cap: delete everything past the newest OUTBOX_MAX_ROWS (live rows and
//      tombstones counted together) so a flood can't grow the file unbounded.
//
// The `encrypted_payload <> ''` guard on step 1 keeps it idempotent — a row
// that is already a tombstone is not re-touched.
function outbox_expire_and_prune(PDO $pdo): void
{
    $now = (int)round(microtime(true) * 1000);

    $stmt = $pdo->prepare('UPDATE messages SET encrypted_payload = \'\', sender_hash = NULL
        WHERE ts < :cutoff AND encrypted_payload <> \'\'');
    $stmt->execute([':cutoff' => $now - OUTBOX_TTL_MS]);

    $pdo->prepare('DELETE FROM messages WHERE ts < :cutoff')
        ->execute([':cutoff' => $now - OUTBOX_TOMBSTONE_TTL_MS]);

    $pdo->exec('DELETE FROM messages WHERE msg_id IN (
        SELECT msg_id FROM messages ORDER BY ts DESC LIMIT -1 OFFSET ' . OUTBOX_MAX_ROWS . '
    )');
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
            ':ts' => (int)round(microtime(true) * 1000),
            ':sender_hash' => $sender_hash,
            ':encrypted_payload' => $encrypted_payload,
        ]);

        // Soft-expire old content to tombstones, hard-delete ancient tombstones,
        // and enforce the row cap — all inside this same IMMEDIATE transaction.
        outbox_expire_and_prune($pdo);

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

    // Lazy age-out on read: strip expired content to tombstones and drop the
    // ancient ones. An idle room ages out here even with no new appends.
    outbox_expire_and_prune($pdo);

    // `expired` lets the client render a tombstone marker without having to infer
    // it from an empty payload. Tombstones carry a null sender_hash and an empty
    // encrypted_payload — there is nothing left to decrypt.
    $stmt = $pdo->prepare('SELECT msg_id, ts, sender_hash, encrypted_payload,
        (encrypted_payload = \'\') AS expired
        FROM messages WHERE ts > :since ORDER BY ts ASC LIMIT :limit');
    $stmt->bindValue(':since', max(0, $since_ts), PDO::PARAM_INT);
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll();
    // Normalize the SQLite integer 0/1 into a real bool for the JSON contract.
    foreach ($rows as &$row) {
        $row['expired'] = (bool) $row['expired'];
    }
    unset($row);
    return $rows;
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
