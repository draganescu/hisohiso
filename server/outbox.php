<?php
declare(strict_types=1);

const OUTBOX_DEFAULT_DIR = '/data/rooms';
const OUTBOX_MAX_ROWS = 500;
const OUTBOX_TTL_SECONDS = 86400; // 24h

function outbox_root(): string
{
    $env = getenv('OUTBOX_DIR');
    return is_string($env) && $env !== '' ? $env : OUTBOX_DEFAULT_DIR;
}

function outbox_path(string $room_hash): string
{
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
    $pdo->exec('CREATE TABLE IF NOT EXISTS messages (
        msg_id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        sender_hash TEXT,
        encrypted_payload TEXT NOT NULL
    );');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);');
    return $pdo;
}

function outbox_append(string $room_hash, string $msg_id, string $encrypted_payload, ?string $sender_hash): void
{
    $pdo = outbox_open($room_hash);
    $pdo->beginTransaction();
    try {
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

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
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
    $stmt->bindValue(':since', $since_ts, PDO::PARAM_INT);
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->execute();
    return $stmt->fetchAll();
}

function outbox_wipe(string $room_hash): void
{
    $path = outbox_path($room_hash);
    @unlink($path);
    @unlink($path . '-wal');
    @unlink($path . '-shm');
    @unlink($path . '-journal');
}
