<?php
declare(strict_types=1);

require_once __DIR__ . '/utils.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/mercure.php';
require_once __DIR__ . '/outbox.php';
require_once __DIR__ . '/rate_limit.php';
require_once __DIR__ . '/push.php';

// Without this, an uncaught PDOException (SQLite busy past the 5s busy_timeout
// under heavy room-switch contention) or any other Throwable from a handler
// produces a bare 500 with no JSON body and no server-side breadcrumb. Log the
// trace and emit a structured envelope the PWA can surface.
set_exception_handler(function (Throwable $e): void {
    error_log('hisohiso unhandled: ' . $e);
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['error' => 'internal_error']);
    }
});

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if (!is_string($path) || strpos($path, '/api/') !== 0) {
    json_response(['error' => 'not_found'], 404);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Long enough that an active session doesn't need to refresh mid-use; short
// enough that a leaked JWT has a bounded lifetime even if revocation fails.
const PARTICIPANT_JWT_TTL = 7 * 24 * 3600;
// Lobby JWT only needs to live long enough for the approver to wrap and post
// the participant token. 10 minutes is generous; abandoned knocks expire
// silently and are harmless (no events ever publish for them).
const LOBBY_JWT_TTL = 10 * 60;
// Pending participant rows (pending=1, minted by /approve) are claimable only
// while the knocker's lobby JWT lives. Once that expires the row can never be
// legitimately claimed, so we GC pending rows older than this. Matches
// LOBBY_JWT_TTL with a small grace margin for clock skew / in-flight claims.
const PENDING_PARTICIPANT_TTL = LOBBY_JWT_TTL + 60; // 11 minutes

function touch_room(string $room_hash): void
{
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE rooms SET last_activity_at = :ts WHERE room_hash = :room_hash');
    $stmt->execute([':ts' => time(), ':room_hash' => $room_hash]);
}

function room_exists(string $room_hash): bool
{
    $pdo = db();
    $stmt = $pdo->prepare('SELECT room_hash FROM rooms WHERE room_hash = :room_hash');
    $stmt->execute([':room_hash' => $room_hash]);
    return (bool) $stmt->fetchColumn();
}

// Throttled — only runs the DELETE at most once every PRESENCE_CLEANUP_INTERVAL
// seconds across the whole server, gated by the mtime of a lockfile in /data.
// Previously the DELETE ran on every /presence and /api/rooms call, which
// generated a steady stream of writer contention with touch_presence's UPSERT.
function presence_prune_stale(): void
{
    $marker = (getenv('CHAT_DB_PATH') ? dirname((string) getenv('CHAT_DB_PATH')) : '/data') . '/.presence_cleanup_at';
    $now = time();
    $last = @filemtime($marker);
    if ($last !== false && ($now - $last) < 30) {
        return;
    }
    @touch($marker, $now);
    $cutoff = $now - 45;
    sqlite_write_with_retry(function () use ($cutoff): void {
        db()->prepare('DELETE FROM presence WHERE last_seen < :cutoff')->execute([':cutoff' => $cutoff]);
    });
}

// Throttled GC of pending participant rows that were minted by /approve but
// never claimed via /presence. Such rows are immortal otherwise (only a
// claim/failed-claim deletes them) and any participant can mint unlimited ones.
// Same lockfile-mtime throttle pattern as presence_prune_stale(); own marker so
// the two pruners don't share a clock. Only pending=1 rows are touched, so an
// active participant (pending=0) is never affected regardless of joined_at age.
// The DELETE is a full scan of the participants table (no index on pending /
// joined_at; idx_participants_room covers room_hash only) — fine because the
// table is bounded by rooms*members and this runs at most once / 60s server-wide.
function pending_participant_prune_stale(): void
{
    $marker = (getenv('CHAT_DB_PATH') ? dirname((string) getenv('CHAT_DB_PATH')) : '/data') . '/.pending_cleanup_at';
    $now = time();
    $last = @filemtime($marker);
    if ($last !== false && ($now - $last) < 60) {
        return;
    }
    @touch($marker, $now);
    $cutoff = $now - PENDING_PARTICIPANT_TTL;
    sqlite_write_with_retry(function () use ($cutoff): void {
        db()->prepare('DELETE FROM participants WHERE pending = 1 AND joined_at < :cutoff')->execute([':cutoff' => $cutoff]);
    });
}

function participant_count(string $room_hash): int
{
    $pdo = db();
    presence_prune_stale();
    pending_participant_prune_stale();
    $cutoff = time() - 45;
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM presence WHERE room_hash = :room_hash AND last_seen >= :cutoff');
    $stmt->execute([':room_hash' => $room_hash, ':cutoff' => $cutoff]);
    return (int)$stmt->fetchColumn();
}

// Active = the token has been claimed via /presence (or was minted by /api/rooms,
// which has no knocker to bind to). Pending tokens — issued by /approve but not
// yet claimed — are accepted ONLY by the claim path in /presence. Every other
// endpoint must reject them; otherwise a sniffer who racing the legit joiner
// could /message before the joiner ever sees their token.
function require_participant_token(string $room_hash): string
{
    return require_participant_token_internal($room_hash, false);
}

function require_participant_token_internal(string $room_hash, bool $allow_pending): string
{
    $token = get_header_value('X-Chat-Token');
    if ($token === null) {
        json_response(['error' => 'missing_token'], 401);
    }
    $token_hash = sha256_hex($token);
    $pdo = db();
    $stmt = $pdo->prepare('SELECT pending FROM participants WHERE token_hash = :token_hash AND room_hash = :room_hash');
    $stmt->execute([':token_hash' => $token_hash, ':room_hash' => $room_hash]);
    $row = $stmt->fetch();
    if (!$row) {
        json_response(['error' => 'invalid_token'], 403);
    }
    if ((int) $row['pending'] === 1 && !$allow_pending) {
        json_response(['error' => 'token_unclaimed'], 403);
    }
    return $token;
}

function create_participant(string $room_hash): string
{
    $token = random_token(32);
    $token_hash = sha256_hex($token);
    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO participants (token_hash, room_hash, joined_at, pending, claim_tag_hash)
        VALUES (:token_hash, :room_hash, :joined_at, 0, NULL)');
    $stmt->execute([
        ':token_hash' => $token_hash,
        ':room_hash' => $room_hash,
        ':joined_at' => time(),
    ]);
    return $token;
}

// Tokens minted via /approve start pending=1 and carry the SHA-256 of the
// claim_tag the approver derived from the ECDH shared secret with the knocker.
// First /presence must reveal the matching claim_tag or the row is deleted.
function create_pending_participant(string $room_hash, string $claim_tag_hash): string
{
    $token = random_token(32);
    $token_hash = sha256_hex($token);
    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO participants (token_hash, room_hash, joined_at, pending, claim_tag_hash)
        VALUES (:token_hash, :room_hash, :joined_at, 1, :claim_tag_hash)');
    $stmt->execute([
        ':token_hash' => $token_hash,
        ':room_hash' => $room_hash,
        ':joined_at' => time(),
        ':claim_tag_hash' => $claim_tag_hash,
    ]);
    return $token;
}

function delete_participant(string $room_hash, string $token_hash): void
{
    $pdo = db();
    $stmt = $pdo->prepare('DELETE FROM participants WHERE token_hash = :token_hash AND room_hash = :room_hash');
    $stmt->execute([':token_hash' => $token_hash, ':room_hash' => $room_hash]);
}

function room_catch_up_enabled(string $room_hash): bool
{
    $pdo = db();
    $stmt = $pdo->prepare('SELECT catch_up_enabled FROM rooms WHERE room_hash = :room_hash');
    $stmt->execute([':room_hash' => $room_hash]);
    return (bool) $stmt->fetchColumn();
}

// Skips the write entirely when the row already exists and was touched less
// than PRESENCE_TOUCH_FRESHNESS seconds ago. SELECT takes only a shared lock
// (cheap in WAL); the UPSERT (which contends with participant_count's prune
// and with parallel touches) only runs when the row is genuinely stale. With
// the PWA pinging /presence every 20s this drops the write rate to ~1 per
// 20s per token instead of ~1 per request.
function touch_presence(string $room_hash, string $token): void
{
    $pdo = db();
    $token_hash = sha256_hex($token);
    $now = time();

    $check = $pdo->prepare('SELECT last_seen FROM presence WHERE token_hash = :token_hash');
    $check->execute([':token_hash' => $token_hash]);
    $row = $check->fetch();
    // Release the read cursor before the UPSERT. PDO_SQLite keeps the implicit
    // read transaction (and its snapshot) open while $check has an unfinalized
    // cursor — and a single-row fetch() leaves it unfinalized. The INSERT below
    // then has to upgrade that now-stale snapshot to a write, which SQLite
    // refuses with an *immediate* SQLITE_BUSY ("database is locked") that the
    // 60s busy_timeout deliberately does NOT wait on (it's a deadlock-avoidance
    // path, not lock contention). sqlite_write_with_retry can't recover either:
    // the snapshot stays pinned across all 4 attempts, so the request 500s.
    // Closing the cursor drops the snapshot so the write takes the lock normally.
    $check->closeCursor();
    if ($row !== false && ($now - (int) $row['last_seen']) < 10) {
        return;
    }

    sqlite_write_with_retry(function () use ($pdo, $token_hash, $room_hash, $now): void {
        $stmt = $pdo->prepare('INSERT INTO presence (token_hash, room_hash, last_seen) VALUES (:token_hash, :room_hash, :last_seen)
            ON CONFLICT(token_hash) DO UPDATE SET last_seen = :last_seen_update');
        $stmt->execute([
            ':token_hash' => $token_hash,
            ':room_hash' => $room_hash,
            ':last_seen' => $now,
            ':last_seen_update' => $now,
        ]);
    });
}

if ($path === '/api/stats' && $method === 'GET') {
    $pdo = db();
    presence_prune_stale();
    $cutoff = time() - 45;

    $total_rooms = (int) $pdo->query('SELECT COUNT(*) FROM rooms')->fetchColumn();

    $stmt = $pdo->prepare('SELECT COUNT(DISTINCT room_hash) FROM presence WHERE last_seen >= :cutoff');
    $stmt->execute([':cutoff' => $cutoff]);
    $active_rooms = (int) $stmt->fetchColumn();

    $stmt = $pdo->prepare('SELECT COUNT(*) FROM presence WHERE last_seen >= :cutoff');
    $stmt->execute([':cutoff' => $cutoff]);
    $active_people = (int) $stmt->fetchColumn();

    json_response([
        'total_rooms' => $total_rooms,
        'active_rooms' => $active_rooms,
        'active_people' => $active_people,
    ]);
}

if ($path === '/api/rooms' && $method === 'POST') {
    $body = read_json_body();
    $room_hash = $body['room_hash'] ?? null;
    if (!valid_room_hash($room_hash)) {
        json_response(['error' => 'invalid_room_hash'], 400);
    }
    $catch_up = !empty($body['catch_up']) ? 1 : 0;

    $pdo = db();
    $exists = room_exists($room_hash);
    if (!$exists) {
        // Only the creation branch is rate-limited — clients hit this endpoint
        // on every room open to probe existence (the $exists path below), which
        // is legitimately frequent and must not be throttled. Capping creation
        // blunts mass room-squatting that bloats the rooms/participants tables.
        enforce_rate_limit('rooms_create', 30, 60);
        $now = time();
        $stmt = $pdo->prepare('INSERT INTO rooms (room_hash, created_at, last_activity_at, catch_up_enabled)
            VALUES (:room_hash, :created_at, :last_activity_at, :catch_up)');
        $stmt->execute([
            ':room_hash' => $room_hash,
            ':created_at' => $now,
            ':last_activity_at' => $now,
            ':catch_up' => $catch_up,
        ]);
        $token = create_participant($room_hash);
        touch_presence($room_hash, $token);
        $sub_jwt = jwt_encode_subscriber([room_topic($room_hash)], PARTICIPANT_JWT_TTL);
        json_response([
            'status' => 'created',
            'has_participants' => true,
            'participant_token' => $token,
            'subscriber_jwt' => $sub_jwt,
            'catch_up_enabled' => (bool) $catch_up,
        ], 201);
    }

    $count = participant_count($room_hash);
    json_response([
        'status' => 'exists',
        'has_participants' => $count > 0,
        'catch_up_enabled' => room_catch_up_enabled($room_hash),
    ]);
}

if (preg_match('#^/api/rooms/([^/]+)$#', $path, $matches) && $method === 'GET') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    $count = participant_count($room_hash);
    json_response([
        'status' => 'exists',
        'has_participants' => $count > 0,
        'catch_up_enabled' => room_catch_up_enabled($room_hash),
    ]);
}

if (preg_match('#^/api/rooms/([^/]+)/knock$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    // /knock is unauthenticated and fans out to every member (+ an ECDH on each
    // receiving daemon), so cap per-IP volume. 20/min is far above any human
    // knock-then-retry pattern while still defusing a flood; counted after the
    // room_exists check so probes against non-existent rooms don't consume it.
    enforce_rate_limit('knock', 20, 60);
    $body = read_json_body();
    if (!isset($body['msg_id']) || !isset($body['encrypted_payload']) || !isset($body['knock_pubkey'])) {
        json_response(['error' => 'missing_knock_payload'], 400);
    }
    if (!is_string($body['knock_pubkey']) || $body['knock_pubkey'] === '') {
        json_response(['error' => 'invalid_knock_pubkey'], 400);
    }
    // Knock event goes to the MEMBERS topic only — the existing participants
    // need to see it to approve. Lobby subscribers (other knockers) don't.
    publish_event($room_hash, 'knock', [
        'msg_id' => $body['msg_id'],
        'encrypted_payload' => $body['encrypted_payload'],
        'knock_pubkey' => $body['knock_pubkey'],
    ]);
    touch_room($room_hash);
    // Lobby JWT is scoped to the :lobby sub-topic ONLY. It lets the knocker
    // receive the wrapped-token delivery and reject tombstones — but NOT
    // chat/settings traffic that flows on the members topic. This closes the
    // 10-minute read window where a knocker could siphon ciphertext after a
    // single unauthenticated /knock.
    $lobby_jwt = jwt_encode_subscriber([lobby_topic($room_hash)], LOBBY_JWT_TTL);
    json_response(['status' => 'ok', 'lobby_jwt' => $lobby_jwt]);
}

if (preg_match('#^/api/rooms/([^/]+)/approve$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    $approver = require_participant_token($room_hash);
    $body = read_json_body();
    // claim_tag_hash binds the new token to the knocker's ephemeral keypair: the
    // approver commits to a hash now, the knocker reveals the matching tag on
    // first /presence (it can only derive the tag from the ECDH shared secret).
    // Without this, a sniffer of the plaintext token could race the legit joiner.
    $claim_tag_hash = $body['claim_tag_hash'] ?? null;
    if (!is_string($claim_tag_hash) || preg_match('/^[0-9a-f]{64}$/', $claim_tag_hash) !== 1) {
        json_response(['error' => 'invalid_claim_tag_hash'], 400);
    }
    touch_presence($room_hash, $approver);
    $new_token = create_pending_participant($room_hash, $claim_tag_hash);
    // Token is NOT included in the published event body — the approver is
    // expected to wrap it (together with the subscriber_jwt) to the knocker's
    // ephemeral pubkey and post it via /token. The approve event is kept as
    // a tombstone for UI/state.
    publish_event($room_hash, 'approve', [], sha256_hex($approver));
    touch_room($room_hash);
    $sub_jwt = jwt_encode_subscriber([room_topic($room_hash)], PARTICIPANT_JWT_TTL);
    json_response([
        'new_participant_token' => $new_token,
        'subscriber_jwt' => $sub_jwt,
    ]);
}

if (preg_match('#^/api/rooms/([^/]+)/sub-token$#', $path, $matches) && $method === 'POST') {
    // Refresh a subscriber JWT for a participant whose previous one has
    // expired (or whose local copy was lost). Gated by the participant token;
    // does not mint a new participant, just a fresh JWT for the existing one.
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    $participant = require_participant_token($room_hash);
    touch_presence($room_hash, $participant);
    $sub_jwt = jwt_encode_subscriber([room_topic($room_hash)], PARTICIPANT_JWT_TTL);
    json_response(['subscriber_jwt' => $sub_jwt]);
}

if (preg_match('#^/api/rooms/([^/]+)/token$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    $approver = require_participant_token($room_hash);
    $body = read_json_body();
    foreach (['knock_msg_id', 'approver_pubkey', 'nonce', 'ct'] as $field) {
        if (!isset($body[$field]) || !is_string($body[$field]) || $body[$field] === '') {
            json_response(['error' => 'missing_' . $field], 400);
        }
    }
    // Token-wrap delivery only matters to the knocker, who subscribes via the
    // lobby JWT. Members don't need to see other people's wrap blobs.
    publish_lobby_event($room_hash, 'token', [
        'knock_msg_id' => $body['knock_msg_id'],
        'approver_pubkey' => $body['approver_pubkey'],
        'nonce' => $body['nonce'],
        'ct' => $body['ct'],
    ], sha256_hex($approver));
    touch_presence($room_hash, $approver);
    touch_room($room_hash);
    json_response(['status' => 'ok']);
}

if (preg_match('#^/api/rooms/([^/]+)/message$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    $sender = require_participant_token($room_hash);
    $body = read_json_body();
    if (!isset($body['encrypted_payload'])) {
        json_response(['error' => 'missing_payload'], 400);
    }
    $sender_hash = sha256_hex($sender);
    // Ephemeral status (e.g. an agent's live "working…" indicator) is transient:
    // publish it as a `status` event and DO NOT append it to the outbox, so it
    // never persists or replays on catch-up. Everything else is a chat message.
    //
    // Trust model: a `status` event is authenticated only as "from a room
    // participant" (require_participant_token above), exactly like `chat`. In the
    // flat room model the relay cannot tell the agent's daemon apart from a phone,
    // so any member could publish a forged status (spoof a fake "working"/"stuck"
    // bubble) just as any member can already forge a chat message — this is the
    // same boundary, not a new one. The ephemeral flag only skips outbox
    // persistence; since `status` is rendered as a transient indicator and never
    // as chat history, it cannot be used to inject hidden/persistent content.
    // Per-agent authenticity would require participant roles (out of scope here).
    $ephemeral = isset($body['ephemeral']) && $body['ephemeral'] === true;
    if ($ephemeral) {
        publish_event($room_hash, 'status', [
            'encrypted_payload' => $body['encrypted_payload'],
            'msg_id' => $body['msg_id'] ?? null,
        ], $sender_hash);
    } else {
        publish_event($room_hash, 'chat', [
            'encrypted_payload' => $body['encrypted_payload'],
            'msg_id' => $body['msg_id'] ?? null,
        ], $sender_hash);
        // catch_up is re-checked INSIDE outbox_append under a BEGIN IMMEDIATE
        // transaction that serializes against outbox_wipe — this is the close-
        // over of the publish→append TOCTOU window where a concurrent /settings
        // (off) used to strand one orphan message past the operator's disable.
        if (isset($body['msg_id']) && is_string($body['msg_id']) && $body['msg_id'] !== ''
            && is_string($body['encrypted_payload'])) {
            outbox_append($room_hash, $body['msg_id'], $body['encrypted_payload'], $sender_hash);
        }
    }
    touch_presence($room_hash, $sender);
    touch_room($room_hash);
    json_response(['status' => 'ok']);
}

if (preg_match('#^/api/rooms/([^/]+)/outbox$#', $path, $matches) && $method === 'GET') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    require_participant_token($room_hash);
    if (!room_catch_up_enabled($room_hash)) {
        json_response(['messages' => []]);
    }
    $since_raw = $_GET['since_ts'] ?? '0';
    $since_ts = is_numeric($since_raw) ? (int) $since_raw : 0;
    json_response(['messages' => outbox_fetch($room_hash, $since_ts)]);
}

if (preg_match('#^/api/rooms/([^/]+)/settings$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    $sender = require_participant_token($room_hash);
    $body = read_json_body();
    if (!array_key_exists('catch_up_enabled', $body)) {
        json_response(['error' => 'missing_catch_up_enabled'], 400);
    }
    $next = !empty($body['catch_up_enabled']) ? 1 : 0;
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE rooms SET catch_up_enabled = :v WHERE room_hash = :room_hash');
    $stmt->execute([':v' => $next, ':room_hash' => $room_hash]);

    // Disabling wipes the stored ciphertext so the toggle's meaning is honest.
    if (!$next) {
        outbox_wipe($room_hash);
    }

    publish_event($room_hash, 'settings', [
        'catch_up_enabled' => (bool) $next,
    ], sha256_hex($sender));
    touch_presence($room_hash, $sender);
    touch_room($room_hash);
    json_response(['status' => 'ok', 'catch_up_enabled' => (bool) $next]);
}

if (preg_match('#^/api/rooms/([^/]+)/reject$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    $sender = require_participant_token($room_hash);
    // Reject is content-free: the previous design forwarded body.message
    // verbatim, which (a) wasn't encrypted with k_msg/k_knock, and (b) used
    // to land on the members topic — both of which let any lobby subscriber
    // read the reason. The knocker now learns "you were rejected" and
    // nothing more. Goes to the lobby topic so the knocker (subscribed via
    // lobby JWT) sees it; members don't need a reject notification.
    publish_lobby_event($room_hash, 'reject', [], sha256_hex($sender));
    touch_presence($room_hash, $sender);
    touch_room($room_hash);
    json_response(['status' => 'ok']);
}

if (preg_match('#^/api/rooms/([^/]+)/presence$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    // /presence is the claim path: pending tokens are accepted here ONLY long
    // enough to verify the X-Chat-Claim-Tag header. Any wrong or missing tag
    // deletes the participant — the legitimate joiner can re-knock, but the
    // token a sniffer raced with is burned. Active tokens skip the claim check.
    $token = require_participant_token_internal($room_hash, true);
    $token_hash = sha256_hex($token);
    $pdo = db();
    $stmt = $pdo->prepare('SELECT pending, claim_tag_hash FROM participants WHERE token_hash = :token_hash AND room_hash = :room_hash');
    $stmt->execute([':token_hash' => $token_hash, ':room_hash' => $room_hash]);
    $row = $stmt->fetch();
    // Same read-snapshot release as in touch_presence(): this $stmt stays in
    // scope through the activation UPDATE, delete_participant() and
    // touch_presence() below — all writes on this same connection. Leaving its
    // cursor open pins a snapshot and turns those writes into the un-retryable
    // "database is locked" upgrade error. This is the request the client fires
    // when switching into a room, so it was the dominant source of the 500s.
    $stmt->closeCursor();
    if (!$row) {
        json_response(['error' => 'invalid_token'], 403);
    }
    if ((int) $row['pending'] === 1) {
        $claim_tag = get_header_value('X-Chat-Claim-Tag');
        $expected_hash = is_string($row['claim_tag_hash']) ? $row['claim_tag_hash'] : '';
        if ($claim_tag === null || $expected_hash === '' || !hash_equals($expected_hash, sha256_hex($claim_tag))) {
            // Burn the token on any failed claim — protects against race-and-invalidate.
            delete_participant($room_hash, $token_hash);
            json_response(['error' => 'invalid_claim'], 403);
        }
        // Atomic activation: clear pending only if it's still 1 (defensive against
        // a parallel /presence racing the same legitimate joiner across tabs).
        $upd = $pdo->prepare('UPDATE participants SET pending = 0, claim_tag_hash = NULL
            WHERE token_hash = :token_hash AND room_hash = :room_hash AND pending = 1');
        $upd->execute([':token_hash' => $token_hash, ':room_hash' => $room_hash]);
    }
    touch_presence($room_hash, $token);
    $count = participant_count($room_hash);
    json_response(['status' => 'ok', 'active_participants' => $count]);
}

if (preg_match('#^/api/rooms/([^/]+)/leave$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    $token = require_participant_token($room_hash);
    $token_hash = sha256_hex($token);
    // Leaving removes only this participant. Unlike /disband — which deletes the
    // whole room — the room, its outbox, and every other member stay intact. We
    // drop the participant token (revoking /message and any future JWT mint) and
    // the presence row, so the live participant count falls immediately instead
    // of waiting out the 45s presence timeout.
    sqlite_write_with_retry(function () use ($room_hash, $token_hash): void {
        $pdo = db();
        $pdo->prepare('DELETE FROM participants WHERE token_hash = :token_hash AND room_hash = :room_hash')
            ->execute([':token_hash' => $token_hash, ':room_hash' => $room_hash]);
        $pdo->prepare('DELETE FROM presence WHERE token_hash = :token_hash')
            ->execute([':token_hash' => $token_hash]);
    });
    touch_room($room_hash);
    json_response(['status' => 'ok']);
}

if (preg_match('#^/api/rooms/([^/]+)/disband$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    $sender = require_participant_token($room_hash);
    $pdo = db();
    $stmt = $pdo->prepare('DELETE FROM rooms WHERE room_hash = :room_hash');
    $stmt->execute([':room_hash' => $room_hash]);
    // Wipe per-room outbox before clients hear the destroy event.
    outbox_wipe($room_hash);
    // Destroy fans out to BOTH topics so any in-flight knocker (subscribed
    // only to the lobby topic) also tears down their lobby waiting UI.
    publish_room_and_lobby($room_hash, 'destroy', [], sha256_hex($sender));
    json_response(['status' => 'ok']);
}

// --- Web push (content-less "tickle" notifications) ---
// See server/push.php for the privacy model: the server fans out a payload-less
// wake-up, never any agent content.

// Public: the browser needs the VAPID application server key to subscribe.
if ($path === '/api/push/vapid-public-key' && $method === 'GET') {
    enforce_rate_limit('vapid_key', 120, 60);
    $cfg = vapid_config();
    if ($cfg === null) {
        json_response(['error' => 'push_disabled'], 503);
    }
    json_response(['key' => $cfg['public']]);
}

// A device opts into notifications for this room. Participant-token gated so
// only a paired member can register an endpoint against the room.
if (preg_match('#^/api/rooms/([^/]+)/push-subscribe$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    require_participant_token($room_hash);
    enforce_rate_limit('push_subscribe', 30, 60);
    if (!push_enabled()) {
        json_response(['error' => 'push_disabled'], 503);
    }
    $body = read_json_body();
    $sub = $body['subscription'] ?? null;
    $endpoint = is_array($sub) ? ($sub['endpoint'] ?? null) : null;
    $keys = is_array($sub) ? ($sub['keys'] ?? null) : null;
    $p256dh = is_array($keys) ? ($keys['p256dh'] ?? null) : null;
    $auth = is_array($keys) ? ($keys['auth'] ?? null) : null;
    if (!is_string($endpoint) || strncmp($endpoint, 'https://', 8) !== 0
        || !is_string($p256dh) || !is_string($auth)) {
        json_response(['error' => 'invalid_subscription'], 400);
    }
    push_subscription_upsert($room_hash, $endpoint, $p256dh, $auth);
    json_response(['status' => 'ok']);
}

// A device opts back out. Idempotent — deleting a row that isn't there is fine.
if (preg_match('#^/api/rooms/([^/]+)/push-unsubscribe$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    require_participant_token($room_hash);
    enforce_rate_limit('push_unsubscribe', 30, 60);
    $body = read_json_body();
    $endpoint = $body['endpoint'] ?? null;
    if (!is_string($endpoint) || $endpoint === '') {
        json_response(['error' => 'missing_endpoint'], 400);
    }
    push_subscription_delete($room_hash, $endpoint);
    json_response(['status' => 'ok']);
}

// The PWA calls this while a subscribed room is visible on this device, and
// clears it when hidden/unmounted. notify_room() uses the short-lived marker to
// avoid redundant OS notifications for the exact channel already open on-screen.
if (preg_match('#^/api/rooms/([^/]+)/push-foreground$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    require_participant_token($room_hash);
    enforce_rate_limit('push_foreground', 120, 60);
    $body = read_json_body();
    $endpoint = $body['endpoint'] ?? null;
    if (!is_string($endpoint) || $endpoint === '') {
        json_response(['error' => 'missing_endpoint'], 400);
    }
    $foreground = (bool) ($body['foreground'] ?? false);
    push_subscription_mark_foreground($room_hash, $endpoint, $foreground);
    json_response(['status' => 'ok']);
}

// Fan a content-less push out to the room's subscribed devices. Two callers:
// the CLI daemon (when an agent finishes a turn or needs attention) and the PWA
// (after sending a chat message, so a backgrounded peer gets pinged). Both hold
// a room participant token, which gates this route so a stranger can't spam a
// room's devices. Fan-out is best-effort; we always 200.
if (preg_match('#^/api/rooms/([^/]+)/push$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    require_participant_token($room_hash);
    enforce_rate_limit('push_send', 120, 60);
    $body = read_json_body();
    $urgency = (($body['urgency'] ?? '') === 'high') ? 'high' : 'normal';
    // The PWA passes its own endpoint so the sender isn't notified of their own
    // message; the daemon omits it (it has no push endpoint).
    $exclude = $body['exclude_endpoint'] ?? null;
    $exclude = is_string($exclude) && $exclude !== '' ? $exclude : null;
    $sent = push_enabled() ? notify_room($room_hash, $urgency, $exclude) : 0;
    json_response(['status' => 'ok', 'sent' => $sent]);
}

json_response(['error' => 'not_found'], 404);
