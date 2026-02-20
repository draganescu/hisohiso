<?php
declare(strict_types=1);

require_once __DIR__ . '/utils.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/mercure.php';

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

if ($path === '/api/rooms' && $method === 'POST') {
    $body = read_json_body();
    $room_hash = $body['room_hash'] ?? null;
    if (!is_string($room_hash) || $room_hash === '') {
        json_response(['error' => 'invalid_room_hash'], 400);
    }

    $pdo = db();
    $exists = room_exists($room_hash);
    if (!$exists) {
        $now = time();
        $stmt = $pdo->prepare('INSERT INTO rooms (room_hash, created_at, last_activity_at) VALUES (:room_hash, :created_at, :last_activity_at)');
        $stmt->execute([
            ':room_hash' => $room_hash,
            ':created_at' => $now,
            ':last_activity_at' => $now,
        ]);
        $token = create_participant($room_hash);
        touch_presence($room_hash, $token);
        json_response([
            'status' => 'created',
            'has_participants' => true,
            'participant_token' => $token,
        ], 201);
    }

    $count = participant_count($room_hash);
    json_response([
        'status' => 'exists',
        'has_participants' => $count > 0,
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
    ]);
}

if (preg_match('#^/api/rooms/([^/]+)/knock$#', $path, $matches) && $method === 'POST') {
    $room_hash = $matches[1];
    if (!room_exists($room_hash)) {
        json_response(['error' => 'room_not_found'], 404);
    }
    $body = read_json_body();
    if (!isset($body['msg_id']) || !isset($body['encrypted_payload'])) {
        json_response(['error' => 'missing_knock_payload'], 400);
    }
    publish_event($room_hash, 'knock', [
        'msg_id' => $body['msg_id'],
        'encrypted_payload' => $body['encrypted_payload'],
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
    publish_event($room_hash, 'approve', [
        'new_participant_token' => $new_token,
    ], sha256_hex($approver));
    touch_room($room_hash);
    json_response(['new_participant_token' => $new_token]);
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
    publish_event($room_hash, 'chat', [
        'encrypted_payload' => $body['encrypted_payload'],
        'msg_id' => $body['msg_id'] ?? null,
    ], sha256_hex($sender));
    touch_presence($room_hash, $sender);
    touch_room($room_hash);
    json_response(['status' => 'ok']);
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
    publish_event($room_hash, 'destroy', [], sha256_hex($sender));
    json_response(['status' => 'ok']);
}

json_response(['error' => 'not_found'], 404);
