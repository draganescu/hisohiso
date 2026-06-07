<?php
declare(strict_types=1);

// Web Push (RFC 8030) with VAPID (RFC 8292), restricted to payload-less
// "tickle" notifications.
//
// We deliberately send NO encrypted payload. The push carries only the VAPID
// JWT that proves it came from this server — zero bytes of agent content. The
// browser's service worker (app/public/sw.js) turns the bare wake-up into a
// generic "an agent needs you" and the tap opens the channel list, where the
// real, end-to-end-decrypted messages already live. So the push service
// (Apple / Google / Mozilla) and even this server stay as blind to what the
// agent said as the Mercure relay already is: they learn only that *some*
// room had activity at some time, which the relay traffic already reveals.
//
// Because there's no payload, we never touch the subscription's p256dh/auth
// keys here and don't implement RFC 8291 content encryption — that whole
// (fiddly, ECDH+HKDF+AES128GCM) layer is simply absent. Signing the VAPID
// JWT is pure OpenSSL; no Composer dependency is pulled in.

// VAPID config, read once from the environment:
//   VAPID_PUBLIC_KEY  — base64url of the 65-byte uncompressed P-256 point.
//                       Handed to the browser as applicationServerKey AND sent
//                       as the `k=` parameter of the Authorization header.
//   VAPID_PRIVATE_KEY — base64( PEM of the matching EC private key ). The PEM
//                       is base64-wrapped so its newlines survive a one-line
//                       env var. Mint both with scripts/gen-vapid.mjs.
//   VAPID_SUBJECT     — mailto:/https: contact, required so a push-service
//                       operator can reach the sender about abuse.
//
// Missing/blank public or private key => push is disabled. Endpoints degrade
// to 503 and notify_room() is a no-op; the rest of the server is unaffected.
function vapid_config(): ?array
{
    static $cfg = null;
    static $loaded = false;
    if ($loaded) {
        return $cfg;
    }
    $loaded = true;

    $pub = getenv('VAPID_PUBLIC_KEY');
    $priv_b64 = getenv('VAPID_PRIVATE_KEY');
    $subject = getenv('VAPID_SUBJECT');
    if (!is_string($subject) || $subject === '') {
        $subject = 'mailto:admin@localhost';
    }
    if (!is_string($pub) || $pub === '' || !is_string($priv_b64) || $priv_b64 === '') {
        return null;
    }
    $pem = base64_decode($priv_b64, true);
    if ($pem === false || $pem === '') {
        error_log('hisohiso push: VAPID_PRIVATE_KEY is not valid base64 — push disabled');
        return null;
    }
    $cfg = ['public' => $pub, 'pem' => $pem, 'subject' => $subject];
    return $cfg;
}

function push_enabled(): bool
{
    return vapid_config() !== null;
}

// OpenSSL emits an ECDSA signature as DER `SEQUENCE { INTEGER r, INTEGER s }`.
// JWS/ES256 wants the raw fixed-width pair r||s (32 bytes each for P-256).
// Strip DER framing and any INTEGER sign/leading-zero padding, then left-pad
// each component back to 32 bytes.
function ecdsa_der_to_raw(string $der): string
{
    $offset = 0;
    $len = strlen($der);
    if ($len < 8 || ord($der[$offset++]) !== 0x30) {
        throw new RuntimeException('vapid: malformed ECDSA signature (no SEQUENCE)');
    }
    $seq_len = ord($der[$offset++]);
    if ($seq_len & 0x80) {
        // Long-form length: the low 7 bits give how many length bytes follow.
        $offset += ($seq_len & 0x7f);
    }
    $read_int = static function () use ($der, &$offset): string {
        if (ord($der[$offset++]) !== 0x02) {
            throw new RuntimeException('vapid: malformed ECDSA signature (no INTEGER)');
        }
        $ilen = ord($der[$offset++]);
        $val = substr($der, $offset, $ilen);
        $offset += $ilen;
        $val = ltrim($val, "\x00");
        if (strlen($val) > 32) {
            throw new RuntimeException('vapid: ECDSA component too large');
        }
        return str_pad($val, 32, "\x00", STR_PAD_LEFT);
    };
    $r = $read_int();
    $s = $read_int();
    return $r . $s;
}

// Build a VAPID JWT bound to one push service's origin (its `aud`). Short-lived
// (12h, comfortably under the spec's 24h cap) and re-minted per send — cheap.
function vapid_jwt(string $audience): string
{
    $cfg = vapid_config();
    if ($cfg === null) {
        throw new RuntimeException('vapid: not configured');
    }
    $header = base64url_encode(json_encode(['typ' => 'JWT', 'alg' => 'ES256'], JSON_UNESCAPED_SLASHES));
    $claims = base64url_encode(json_encode([
        'aud' => $audience,
        'exp' => time() + 12 * 3600,
        'sub' => $cfg['subject'],
    ], JSON_UNESCAPED_SLASHES));
    $signing_input = $header . '.' . $claims;

    $pkey = openssl_pkey_get_private($cfg['pem']);
    if ($pkey === false) {
        throw new RuntimeException('vapid: could not load private key (' . openssl_error_string() . ')');
    }
    $der_sig = '';
    if (!openssl_sign($signing_input, $der_sig, $pkey, OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('vapid: openssl_sign failed');
    }
    return $signing_input . '.' . base64url_encode(ecdsa_der_to_raw($der_sig));
}

// Send one content-less push to a single subscription endpoint. Returns the
// HTTP status the push service gave us (0 on transport failure). 201 = queued;
// 404/410 = the subscription is dead and should be pruned by the caller.
function send_web_push(string $endpoint, string $urgency = 'normal'): int
{
    $cfg = vapid_config();
    if ($cfg === null) {
        return 0;
    }
    $parts = parse_url($endpoint);
    if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
        return 0;
    }
    $audience = $parts['scheme'] . '://' . $parts['host'];

    $headers = [
        'Authorization: vapid t=' . vapid_jwt($audience) . ', k=' . $cfg['public'],
        'TTL: 86400',
        'Urgency: ' . ($urgency === 'high' ? 'high' : 'normal'),
        'Content-Length: 0',
    ];

    $ch = curl_init($endpoint);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => '',
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 8,
    ]);
    curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return $status;
}

// --- Subscription store ---

function push_subscription_upsert(string $room_hash, string $endpoint, string $p256dh, string $auth): void
{
    $pdo = db();
    sqlite_write_with_retry(function () use ($pdo, $room_hash, $endpoint, $p256dh, $auth): void {
        $stmt = $pdo->prepare('INSERT INTO push_subscriptions (room_hash, endpoint, p256dh, auth, created_at)
            VALUES (:room_hash, :endpoint, :p256dh, :auth, :ts)
            ON CONFLICT(room_hash, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth');
        $stmt->execute([
            ':room_hash' => $room_hash,
            ':endpoint' => $endpoint,
            ':p256dh' => $p256dh,
            ':auth' => $auth,
            ':ts' => time(),
        ]);
    });
}

function push_subscription_delete(string $room_hash, string $endpoint): void
{
    $pdo = db();
    sqlite_write_with_retry(function () use ($pdo, $room_hash, $endpoint): void {
        $stmt = $pdo->prepare('DELETE FROM push_subscriptions WHERE room_hash = :room_hash AND endpoint = :endpoint');
        $stmt->execute([':room_hash' => $room_hash, ':endpoint' => $endpoint]);
    });
}

// Fan a content-less tickle out to every device subscribed to this room.
// Dead subscriptions (404/410) are pruned inline. Returns the number queued.
// Synchronous: a room rarely has more than one or two devices, so the daemon's
// fire-and-forget POST /push returns in well under a second.
function notify_room(string $room_hash, string $urgency = 'normal'): int
{
    if (!push_enabled()) {
        return 0;
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT endpoint FROM push_subscriptions WHERE room_hash = :room_hash');
    $stmt->execute([':room_hash' => $room_hash]);
    $endpoints = $stmt->fetchAll(PDO::FETCH_COLUMN);

    $sent = 0;
    foreach ($endpoints as $endpoint) {
        if (!is_string($endpoint)) {
            continue;
        }
        $status = send_web_push($endpoint, $urgency);
        if ($status === 404 || $status === 410) {
            push_subscription_delete($room_hash, $endpoint);
        } elseif ($status >= 200 && $status < 300) {
            $sent++;
        }
    }
    return $sent;
}
