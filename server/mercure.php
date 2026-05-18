<?php
declare(strict_types=1);

require_once __DIR__ . '/utils.php';

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

// Mint a subscriber JWT scoped to specific topics. TTL bounded so a leaked
// JWT only buys access until expiry. Disband-time revocation works through
// the absence of further events on the topic (room rows go away) rather
// than per-JWT invalidation, which Mercure does not natively support.
function jwt_encode_subscriber(array $topics, int $ttl_seconds): string
{
    $key = getenv('MERCURE_SUBSCRIBER_JWT_KEY') ?: '!ChangeMe!';
    $now = time();
    return jwt_encode([
        'mercure' => ['subscribe' => $topics],
        'iat' => $now,
        'exp' => $now + $ttl_seconds,
    ], $key);
}

function publish_event(string $room_hash, string $type, array $body = [], ?string $from = null): void
{
    $topic = 'room:' . $room_hash;
    $now = time();
    $payload = [
        'v' => 0,
        'type' => $type,
        'room_hash' => $room_hash,
        'from' => $from,
        'ts' => $now,
        'body' => $body,
    ];

    $jwtKey = getenv('MERCURE_PUBLISHER_JWT_KEY') ?: '!ChangeMe!';
    $jwt = jwt_encode(['mercure' => ['publish' => [$topic]]], $jwtKey);

    // private=on gates this update to subscribers whose JWT lists $topic in
    // its subscribe claim. Combined with `anonymous` being OFF in the hub,
    // this means an unauthenticated client cannot read it.
    $postFields = http_build_query([
        'topic' => $topic,
        'data' => json_encode($payload, JSON_UNESCAPED_SLASHES),
        'type' => $type,
        'private' => 'on',
    ]);

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
