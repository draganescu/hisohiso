<?php
declare(strict_types=1);

// Per-IP fixed-window rate limiter backed by SQLite (issue #103).
//
// The unauthenticated write endpoints — /knock and room creation via
// /api/rooms POST — are cheap to send but expensive to absorb: a knock fans a
// `knock` event out to every member subscribed to the room's members topic,
// and every daemon that receives it runs a decrypt + ECDH (onKnock). Room
// creation writes a fresh rooms row. Caddy core ships no rate limiting and we
// deliberately don't run a custom Caddy build, so the throttle lives here.
//
// One row per (route|ip-tag) bucket; the window_start/count pair is updated in
// place so the table is bounded by distinct client IPs, not request volume.
// The IP is stored only as a secret-keyed one-way tag (see client_tag) — the
// table never holds a raw address.

// Secret that keys the IP hash so the rate_limits table never holds a raw IP.
// Generated once and stored OUTSIDE the SQLite DB (and therefore out of any DB
// backup/dump) with 0600 perms. A leaked DB alone then reveals only opaque
// tags — it can't even be brute-forced back to IPs without also stealing this
// file.
//
// Honest caveat (deliberate): IPv4 is a 32-bit space, so a party holding BOTH
// this secret and the DB can still brute-force the tag→IP mapping (HMAC is
// fast). Hashing is therefore NOT strong anonymization against the host
// operator — what it buys is removing the *easy* exposure paths: no raw IPs in
// the DB, in backups, or in error logs. That matches the goal here (rate-limit
// without retaining identifiable IPs), not defending against the box's owner.
function rate_limit_secret(): string
{
    static $secret = null;
    if ($secret !== null) {
        return $secret;
    }
    $dir = getenv('CHAT_DB_PATH') ? dirname((string) getenv('CHAT_DB_PATH')) : '/data';
    $path = $dir . '/.rl_secret';
    $raw = @file_get_contents($path);
    if ($raw === false || strlen($raw) < 32) {
        $candidate = random_bytes(32);
        // 'xb' = exclusive create: only one worker wins the race; the rest fail
        // the open and fall through to re-read the winner's file, so every
        // FrankenPHP worker converges on the same secret (and thus the same
        // buckets). Without this, two workers booting together could mint
        // different secrets and split the rate-limit state.
        $fh = @fopen($path, 'xb');
        if ($fh !== false) {
            fwrite($fh, $candidate);
            fclose($fh);
            @chmod($path, 0600);
        }
        $raw = @file_get_contents($path);
        if ($raw === false || strlen($raw) < 32) {
            $raw = $candidate; // last-resort: unreadable /data, key in-memory only
        }
    }
    return $secret = $raw;
}

// One-way, secret-keyed tag for the client IP — the raw IP is never stored or
// returned. REMOTE_ADDR is the real client: Caddy terminates TLS directly on
// the droplet (compose.prod.yaml publishes 80/443 straight to the container),
// so no forwarding proxy sits in front and we deliberately do NOT trust
// X-Forwarded-For, which a client could spoof to dodge the limit. Truncated to
// 128 bits — far beyond what's needed to avoid bucket collisions.
function client_tag(): string
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    $ip = is_string($ip) && $ip !== '' ? $ip : 'unknown';
    return substr(hash_hmac('sha256', $ip, rate_limit_secret()), 0, 32);
}

// Throttled cleanup of windows that can no longer be current, gated by a
// lockfile mtime so the DELETE runs at most once a minute server-wide (same
// pattern as presence_prune_stale). Without it the table accumulates one stale
// row per IP that ever hit a limited endpoint.
function rate_limit_prune_stale(): void
{
    $marker = (getenv('CHAT_DB_PATH') ? dirname((string) getenv('CHAT_DB_PATH')) : '/data') . '/.rate_limit_cleanup_at';
    $now = time();
    $last = @filemtime($marker);
    if ($last !== false && ($now - $last) < 60) {
        return;
    }
    @touch($marker, $now);
    // Anything older than an hour is well past any window we enforce.
    $cutoff = $now - 3600;
    sqlite_write_with_retry(function () use ($cutoff): void {
        db()->prepare('DELETE FROM rate_limits WHERE window_start < :cutoff')->execute([':cutoff' => $cutoff]);
    });
}

// Fixed-window counter. Atomically counts this request and returns the running
// count for the current window. The first request of a new window resets the
// counter to 1 (the CASE in the UPSERT). RETURNING avoids a read-after-write
// TOCTOU between concurrent same-IP requests.
function rate_limit_hit(string $route, int $window): int
{
    $now = time();
    $window_start = $now - ($now % $window);
    $key = $route . '|' . client_tag();

    return (int) sqlite_write_with_retry(function () use ($key, $window_start): int {
        $stmt = db()->prepare(
            'INSERT INTO rate_limits (bucket_key, window_start, count) VALUES (:k, :ws, 1)
             ON CONFLICT(bucket_key) DO UPDATE SET
               count = CASE WHEN rate_limits.window_start = excluded.window_start
                            THEN rate_limits.count + 1 ELSE 1 END,
               window_start = excluded.window_start
             RETURNING count'
        );
        $stmt->execute([':k' => $key, ':ws' => $window_start]);
        return (int) $stmt->fetchColumn();
    });
}

// Enforce a per-IP limit on the current request: at most $limit requests per
// $window seconds for $route. On breach, emit 429 with Retry-After and exit.
// Call this before the endpoint does any fan-out or DB writes.
function enforce_rate_limit(string $route, int $limit, int $window): void
{
    rate_limit_prune_stale();
    if (rate_limit_hit($route, $window) > $limit) {
        $now = time();
        $retry_after = $window - ($now % $window);
        header('Retry-After: ' . $retry_after);
        json_response(['error' => 'rate_limited', 'retry_after' => $retry_after], 429);
    }
}
