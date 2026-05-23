<?php
declare(strict_types=1);

function json_response(array $data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}

function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function base64url_encode(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function base64url_decode(string $data): string
{
    $padded = strtr($data, '-_', '+/');
    $padLen = 4 - (strlen($padded) % 4);
    if ($padLen < 4) {
        $padded .= str_repeat('=', $padLen);
    }
    return base64_decode($padded);
}

function sha256_hex(string $data): string
{
    return hash('sha256', $data);
}

function random_token(int $bytes = 32): string
{
    return base64url_encode(random_bytes($bytes));
}

function require_method(string $method): void
{
    if ($_SERVER['REQUEST_METHOD'] !== $method) {
        json_response(['error' => 'method_not_allowed'], 405);
    }
}

function get_header_value(string $name): ?string
{
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    $value = $_SERVER[$key] ?? null;
    return is_string($value) && $value !== '' ? $value : null;
}

// room_hash is SHA-256 hex of "hisohiso.room_hash" || room_secret on the client.
// Anything else is either a client bug, a typo, or someone squatting custom names —
// reject before the rooms table accepts it as a primary key.
function valid_room_hash(mixed $value): bool
{
    return is_string($value) && preg_match('/^[0-9a-f]{64}$/', $value) === 1;
}

// PDO_SQLite's builtin busy_timeout (60s default) handles most lock contention,
// but a "BUSY chain" — where the holder of the writer lock itself blocks waiting
// for something else — can still surface SQLITE_BUSY past the timeout. Wrapping
// a write in this helper retries on that error with short backoff. Anything
// other than a busy/locked PDOException propagates unchanged.
//
// Use only around individual write operations, not around large transactions
// (a long-held writer lock that bounces is worse than failing fast).
function sqlite_write_with_retry(callable $op, int $attempts = 4)
{
    $backoff_ms = [50, 150, 400];
    for ($i = 0; $i < $attempts; $i++) {
        try {
            return $op();
        } catch (PDOException $e) {
            $msg = $e->getMessage();
            $is_busy = str_contains($msg, 'database is locked')
                || str_contains($msg, 'database table is locked')
                || str_contains($msg, 'database schema has changed');
            if (!$is_busy || $i === $attempts - 1) {
                throw $e;
            }
            $sleep_ms = $backoff_ms[$i] ?? end($backoff_ms);
            usleep($sleep_ms * 1000);
        }
    }
}
