<?php
declare(strict_types=1);

require_once __DIR__ . '/utils.php';

// Fail-closed if Mercure JWT keys aren't configured. The previous fallback
// to '!ChangeMe!' (the literal default from compose.yaml) let any operator
// who forgot to set production envs silently ship a hub where anyone reading
// the public source could forge subscriber JWTs for any topic. We refuse to
// serve requests in that state — better a 500 than a quiet compromise.
function require_mercure_jwt_keys(): array
{
    $sub = getenv('MERCURE_SUBSCRIBER_JWT_KEY');
    $pub = getenv('MERCURE_PUBLISHER_JWT_KEY');
    foreach (['MERCURE_SUBSCRIBER_JWT_KEY' => $sub, 'MERCURE_PUBLISHER_JWT_KEY' => $pub] as $name => $value) {
        if (!is_string($value) || $value === '' || $value === '!ChangeMe!') {
            http_response_code(500);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['error' => 'server_misconfigured', 'detail' => $name . ' must be set to a non-default value']);
            exit;
        }
    }
    return ['subscriber' => $sub, 'publisher' => $pub];
}

function jwt_encode(array $payload, string $secret): string
{
    $header = ['alg' => 'HS256', 'typ' => 'JWT'];
    $segments = [
        base64url_encode(json_encode($header, JSON_UNESCAPED_SLASHES)),
        base64url_encode(json_encode($payload, JSON_UNESCAPED_SLASHES)),
    ];
    $signingInput = implode('.', $segments);
    $signature = hash_hmac('sha256', $signingInput, $secret, true);
    $segments[] = base64url_encode($signature);
    return implode('.', $segments);
}

function mercure_hub_url(): string
{
    $env = getenv('MERCURE_HUB_URL');
    if (is_string($env) && $env !== '') {
        return $env;
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    return $scheme . '://' . $host . '/.well-known/mercure';
}

// Topic naming: rooms are split between two Mercure topics so the lobby JWT
// (issued unauthenticated to any knocker) cannot read chat traffic.
//   room:<hash>       — "members" topic. Chats, settings, knocks, approve
//                       tombstones, destroy. Only approved participants hold
//                       a subscriber JWT scoped to this topic.
//   room:<hash>:lobby — "knockers" topic. Wrapped-token deliveries, rejects,
//                       destroy. Anyone who can POST /knock gets a 10-minute
//                       JWT scoped to JUST this topic.
function room_topic(string $room_hash): string
{
    return 'room:' . $room_hash;
}

function lobby_topic(string $room_hash): string
{
    return 'room:' . $room_hash . ':lobby';
}

// Mint a subscriber JWT scoped to specific topics. TTL bounded so a leaked
// JWT only buys access until expiry. Disband-time revocation works through
// the absence of further events on the topic (room rows go away) rather
// than per-JWT invalidation, which Mercure does not natively support.
function jwt_encode_subscriber(array $topics, int $ttl_seconds): string
{
    $keys = require_mercure_jwt_keys();
    $now = time();
    return jwt_encode([
        'mercure' => ['subscribe' => $topics],
        'iat' => $now,
        'exp' => $now + $ttl_seconds,
    ], $keys['subscriber']);
}

function publish_event_to(array $topics, string $room_hash, string $type, array $body = [], ?string $from = null): void
{
    if (count($topics) === 0) {
        return;
    }
    // Millisecond precision so two events fired in the same second (tap →
    // daemon ack → daemon ready) sort in the order they were emitted instead
    // of tying and falling back to insertion order on the client.
    $now_ms = (int)round(microtime(true) * 1000);
    $payload = [
        'v' => 0,
        'type' => $type,
        'room_hash' => $room_hash,
        'from' => $from,
        'ts' => $now_ms,
        'body' => $body,
    ];

    $keys = require_mercure_jwt_keys();
    $jwt_now = time();
    $jwt = jwt_encode([
        'mercure' => ['publish' => $topics],
        'iat' => $jwt_now,
        'exp' => $jwt_now + 60,
    ], $keys['publisher']);

    // Mercure accepts `topic` as a repeated form parameter — one event fans
    // out to every listed topic in a single hub call. private=on gates this
    // update to subscribers whose JWT lists the matching topic in its
    // subscribe claim. Combined with `anonymous` being OFF in the hub, this
    // means an unauthenticated client cannot read it.
    $pairs = [];
    foreach ($topics as $t) {
        $pairs[] = 'topic=' . urlencode($t);
    }
    $pairs[] = 'data=' . urlencode(json_encode($payload, JSON_UNESCAPED_SLASHES));
    $pairs[] = 'type=' . urlencode($type);
    $pairs[] = 'private=on';
    $postFields = implode('&', $pairs);

    $ch = curl_init(mercure_hub_url());
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $postFields);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: Bearer ' . $jwt,
        'Content-Type: application/x-www-form-urlencoded',
    ]);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 2);
    curl_exec($ch);
    curl_close($ch);
}

// Backwards-compatible wrapper — publishes to the members topic only.
function publish_event(string $room_hash, string $type, array $body = [], ?string $from = null): void
{
    publish_event_to([room_topic($room_hash)], $room_hash, $type, $body, $from);
}

function publish_lobby_event(string $room_hash, string $type, array $body = [], ?string $from = null): void
{
    publish_event_to([lobby_topic($room_hash)], $room_hash, $type, $body, $from);
}

function publish_room_and_lobby(string $room_hash, string $type, array $body = [], ?string $from = null): void
{
    publish_event_to([room_topic($room_hash), lobby_topic($room_hash)], $room_hash, $type, $body, $from);
}
