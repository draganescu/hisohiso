<?php
declare(strict_types=1);

require_once __DIR__ . '/utils.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/mercure.php';
require_once __DIR__ . '/outbox.php';

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if (!is_string($path) || strpos($path, '/api/') !== 0) {
    json_response(['error' => 'not_found'], 404);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

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

function participant_count(string $room_hash): int
{
    $pdo = db();
    $cutoff = time() - 45;
    $pdo->prepare('DELETE FROM presence WHERE last_seen < :cutoff')->execute([':cutoff' => $cutoff]);
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM presence WHERE room_hash = :room_hash AND last_seen >= :cutoff');
    $stmt->execute([':room_hash' => $room_hash, ':cutoff' => $cutoff]);
    return (int)$stmt->fetchColumn();
}

function require_participant_token(string $room_hash): string
{
    $token = get_header_value('X-Chat-Token');
    if ($token === null) {
        json_response(['error' => 'missing_token'], 401);
    }
    $token_hash = sha256_hex($token);
    $pdo = db();
    $stmt = $pdo->prepare('SELECT token_hash FROM participants WHERE token_hash = :token_hash AND room_hash = :room_hash');
    $stmt->execute([':token_hash' => $token_hash, ':room_hash' => $room_hash]);
    $found = $stmt->fetchColumn();
    if (!$found) {
        json_response(['error' => 'invalid_token'], 403);
    }
    return $token;
}

function create_participant(string $room_hash): string
{
    $token = random_token(32);
    $token_hash = sha256_hex($token);
    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO participants (token_hash, room_hash, joined_at) VALUES (:token_hash, :room_hash, :joined_at)');
    $stmt->execute([
        ':token_hash' => $token_hash,
        ':room_hash' => $room_hash,
        ':joined_at' => time(),
    ]);
    return $token;
}

function room_catch_up_enabled(string $room_hash): bool
{
    $pdo = db();
    $stmt = $pdo->prepare('SELECT catch_up_enabled FROM rooms WHERE room_hash = :room_hash');
    $stmt->execute([':room_hash' => $room_hash]);
    return (bool) $stmt->fetchColumn();
}

function touch_presence(string $room_hash, string $token): void
{
    $pdo = db();
    $token_hash = sha256_hex($token);
    $stmt = $pdo->prepare('INSERT INTO presence (token_hash, room_hash, last_seen) VALUES (:token_hash, :room_hash, :last_seen)
        ON CONFLICT(token_hash) DO UPDATE SET last_seen = :last_seen_update');
    $now = time();
    $stmt->execute([
        ':token_hash' => $token_hash,
        ':room_hash' => $room_hash,
        ':last_seen' => $now,
        ':last_seen_update' => $now,
    ]);
}

if ($path === '/api/stats' && $method === 'GET') {
    $pdo = db();
    $cutoff = time() - 45;
    $pdo->prepare('DELETE FROM presence WHERE last_seen < :cutoff')->execute([':cutoff' => $cutoff]);

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
    if (!is_string($room_hash) || $room_hash === '') {
        json_response(['error' => 'invalid_room_hash'], 400);
    }
    $catch_up = !empty($body['catch_up']) ? 1 : 0;

    $pdo = db();
    $exists = room_exists($room_hash);
    if (!$exists) {
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
        json_response([
            'status' => 'created',
            'has_participants' => true,
            'participant_token' => $token,
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
    $body = read_json_body();
    if (!isset($body['msg_id']) || !isset($body['encrypted_payload']) || !isset($body['knock_pubkey'])) {
        json_response(['error' => 'missing_knock_payload'], 400);
    }
    if (!is_string($body['knock_pubkey']) || $body['knock_pubkey'] === '') {
        json_response(['error' => 'invalid_knock_pubkey'], 400);
    }
    publish_event($room_hash, 'knock', [
        'msg_id' => $body['msg_id'],
        'encrypted_payload' => $body['encrypted_payload'],
        'knock_pubkey' => $body['knock_pubkey'],
    ]);
    touch_room($room_hash);
    json_response(['status' => 'ok']);
}

if (preg_match('#^/api/rooms/([^/]+)/approve$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    $approver = require_participant_token($room_hash);
    touch_presence($room_hash, $approver);
    $new_token = create_participant($room_hash);
    // Token is NOT included in the published event body — the approver is
    // expected to wrap it to the knocker's ephemeral pubkey and post it via
    // /token. The approve event is kept as a tombstone for UI/state.
    publish_event($room_hash, 'approve', [], sha256_hex($approver));
    touch_room($room_hash);
    json_response(['new_participant_token' => $new_token]);
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
    publish_event($room_hash, 'token', [
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
    publish_event($room_hash, 'chat', [
        'encrypted_payload' => $body['encrypted_payload'],
        'msg_id' => $body['msg_id'] ?? null,
    ], $sender_hash);
    if (isset($body['msg_id']) && is_string($body['msg_id']) && $body['msg_id'] !== ''
        && is_string($body['encrypted_payload'])
        && room_catch_up_enabled($room_hash)) {
        outbox_append($room_hash, $body['msg_id'], $body['encrypted_payload'], $sender_hash);
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
    $body = read_json_body();
    publish_event($room_hash, 'reject', [
        'message' => $body['message'] ?? null,
    ], sha256_hex($sender));
    touch_presence($room_hash, $sender);
    touch_room($room_hash);
    json_response(['status' => 'ok']);
}

if (preg_match('#^/api/rooms/([^/]+)/presence$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    $token = require_participant_token($room_hash);
    touch_presence($room_hash, $token);
    $count = participant_count($room_hash);
    json_response(['status' => 'ok', 'active_participants' => $count]);
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
    publish_event($room_hash, 'destroy', [], sha256_hex($sender));
    json_response(['status' => 'ok']);
}

json_response(['error' => 'not_found'], 404);
