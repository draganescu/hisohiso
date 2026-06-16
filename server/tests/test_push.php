<?php
declare(strict_types=1);

// Tests for server/push.php. Standalone — no PHPUnit / Composer.
//
// Run inside the running dev container so PHP version + extensions match
// production:
//
//   docker compose exec app php /app/public/api/tests/test_push.php
//
// Exits 0 on all-pass, 1 on the first failure. Covers the subscription store,
// VAPID config loading, the ES256 JWT shape, and the DER->raw signature
// conversion. It does NOT exercise notify_room()'s real network send (no push
// service to talk to) beyond the empty-room short-circuit.

$ROOT = dirname(__DIR__);

// Isolated tempdir + a freshly-minted dev VAPID keypair, set BEFORE any push.php
// function runs (vapid_config() memoizes on first call).
$tmp = sys_get_temp_dir() . '/hisohiso-push-test-' . bin2hex(random_bytes(4));
mkdir($tmp, 0775, true);
putenv('CHAT_DB_PATH=' . $tmp . '/test.sqlite');
register_shutdown_function(function () use ($tmp): void {
    foreach (glob($tmp . '/*') ?: [] as $f) { @unlink($f); }
    foreach (glob($tmp . '/.[!.]*') ?: [] as $f) { @unlink($f); }
    @rmdir($tmp);
});

// Mint a P-256 keypair with openssl and shape it the way scripts/gen-vapid.mjs
// does: public = base64url(uncompressed point), private = base64(PEM).
$pk = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
openssl_pkey_export($pk, $pem);
$details = openssl_pkey_get_details($pk);
$point = "\x04" . str_pad($details['ec']['x'], 32, "\x00", STR_PAD_LEFT) . str_pad($details['ec']['y'], 32, "\x00", STR_PAD_LEFT);
putenv('VAPID_PUBLIC_KEY=' . rtrim(strtr(base64_encode($point), '+/', '-_'), '='));
putenv('VAPID_PRIVATE_KEY=' . base64_encode($pem));
putenv('VAPID_SUBJECT=mailto:test@example.com');

require_once $ROOT . '/utils.php';
require_once $ROOT . '/db.php';
require_once $ROOT . '/rate_limit.php';
require_once $ROOT . '/push.php';

db();

$FAILED = 0;
$PASSED = 0;
function t(string $name, callable $fn): void {
    global $FAILED, $PASSED;
    try {
        $fn();
        echo "  ok    $name\n";
        $PASSED++;
    } catch (Throwable $e) {
        echo "  FAIL  $name\n        " . $e->getMessage() . "\n";
        $FAILED++;
    }
}
function eq($expected, $actual, string $msg = ''): void {
    if ($expected !== $actual) {
        throw new RuntimeException(($msg !== '' ? "$msg: " : '') . 'expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
    }
}
function truthy($v, string $msg = ''): void {
    if (!$v) throw new RuntimeException($msg !== '' ? $msg : 'expected truthy');
}

// A room row is required because push_subscriptions FK-references rooms.
function seed_room(string $hash): void {
    $stmt = db()->prepare('INSERT OR IGNORE INTO rooms (room_hash, created_at, last_activity_at) VALUES (:h, :t, :t)');
    $stmt->execute([':h' => $hash, ':t' => time()]);
}
function count_subs(string $hash): int {
    $stmt = db()->prepare('SELECT COUNT(*) FROM push_subscriptions WHERE room_hash = :h');
    $stmt->execute([':h' => $hash]);
    return (int) $stmt->fetchColumn();
}

echo "push.php tests\n";

$ROOM = str_repeat('a', 64);
seed_room($ROOM);

// ── config ───────────────────────────────────────────────────────────────────
t('vapid_config loads from env and push is enabled', function () {
    truthy(push_enabled(), 'push should be enabled with keys present');
    $cfg = vapid_config();
    truthy(is_array($cfg) && isset($cfg['public'], $cfg['pem'], $cfg['subject']));
    eq('mailto:test@example.com', $cfg['subject']);
});

// ── subscription store ───────────────────────────────────────────────────────
t('upsert inserts a new subscription', function () use ($ROOM) {
    push_subscription_upsert($ROOM, 'https://push.example.com/ep1', 'p256dh-1', 'auth-1');
    eq(1, count_subs($ROOM));
});

t('upsert on the same (room, endpoint) updates rather than duplicates', function () use ($ROOM) {
    push_subscription_upsert($ROOM, 'https://push.example.com/ep1', 'p256dh-2', 'auth-2');
    eq(1, count_subs($ROOM), 'still one row');
    $stmt = db()->prepare('SELECT p256dh FROM push_subscriptions WHERE room_hash = :h AND endpoint = :e');
    $stmt->execute([':h' => $ROOM, ':e' => 'https://push.example.com/ep1']);
    eq('p256dh-2', $stmt->fetchColumn(), 'keys were refreshed');
});

t('a second endpoint adds a second row', function () use ($ROOM) {
    push_subscription_upsert($ROOM, 'https://push.example.com/ep2', 'p256dh-3', 'auth-3');
    eq(2, count_subs($ROOM));
});

t('delete removes only the named endpoint', function () use ($ROOM) {
    push_subscription_delete($ROOM, 'https://push.example.com/ep1');
    eq(1, count_subs($ROOM));
});

t('disbanding a room cascades its subscriptions away', function () use ($ROOM) {
    db()->prepare('DELETE FROM rooms WHERE room_hash = :h')->execute([':h' => $ROOM]);
    eq(0, count_subs($ROOM), 'FK ON DELETE CASCADE cleared the rows');
    seed_room($ROOM); // restore for any later test
});

t('notify_room with no subscriptions sends nothing (no network)', function () use ($ROOM) {
    eq(0, notify_room($ROOM), 'zero sent, zero cURL calls');
});

t('notify_room excludes the sender endpoint (no network for the only device)', function () use ($ROOM) {
    // One subscription, excluded by the sender → the loop skips it entirely, so
    // there is no cURL call and nothing is sent. This is the self-notify fix:
    // the PWA passes its own endpoint and is never pinged for its own message.
    push_subscription_upsert($ROOM, 'https://push.example.com/self', 'p', 'a');
    eq(0, notify_room($ROOM, 'normal', 'https://push.example.com/self'), 'sender endpoint skipped, no send');
    push_subscription_delete($ROOM, 'https://push.example.com/self');
});

t('notify_room skips an endpoint foregrounded in the same room', function () use ($ROOM) {
    push_subscription_upsert($ROOM, 'https://push.example.com/foreground', 'p', 'a');
    push_subscription_mark_foreground($ROOM, 'https://push.example.com/foreground', true);
    eq(0, notify_room($ROOM), 'foreground endpoint skipped, no send');
    $stmt = db()->prepare('SELECT foreground_at FROM push_subscriptions WHERE room_hash = :h AND endpoint = :e');
    $stmt->execute([':h' => $ROOM, ':e' => 'https://push.example.com/foreground']);
    truthy((int) $stmt->fetchColumn() > 0, 'foreground marker was recorded');
    push_subscription_mark_foreground($ROOM, 'https://push.example.com/foreground', false);
    $stmt->execute([':h' => $ROOM, ':e' => 'https://push.example.com/foreground']);
    eq(0, (int) $stmt->fetchColumn(), 'foreground marker was cleared');
    push_subscription_delete($ROOM, 'https://push.example.com/foreground');
});

// ── VAPID JWT ────────────────────────────────────────────────────────────────
t('vapid_jwt produces a 3-part ES256 token bound to the audience', function () {
    $jwt = vapid_jwt('https://push.example.com');
    $parts = explode('.', $jwt);
    eq(3, count($parts), 'header.claims.signature');
    $header = json_decode(base64url_decode($parts[0]), true);
    eq('ES256', $header['alg']);
    eq('JWT', $header['typ']);
    $claims = json_decode(base64url_decode($parts[1]), true);
    eq('https://push.example.com', $claims['aud']);
    eq('mailto:test@example.com', $claims['sub']);
    truthy($claims['exp'] > time(), 'exp in the future');
    truthy($claims['exp'] <= time() + 24 * 3600, 'exp under the 24h spec cap');
});

t('vapid_jwt signature is a verifiable 64-byte raw ES256 signature', function () {
    $jwt = vapid_jwt('https://push.example.com');
    [$h, $c, $s] = explode('.', $jwt);
    $raw = base64url_decode($s);
    eq(64, strlen($raw), 'P-256 r||s is 64 bytes');
    // Round-trip verify: convert raw r||s back to DER and check with openssl
    // against the configured public key.
    $r = substr($raw, 0, 32);
    $sig = substr($raw, 32, 32);
    $der_int = function (string $i): string {
        $i = ltrim($i, "\x00");
        if ($i === '') $i = "\x00";
        if (ord($i[0]) & 0x80) $i = "\x00" . $i; // keep it positive
        return "\x02" . chr(strlen($i)) . $i;
    };
    $seq = $der_int($r) . $der_int($sig);
    $der = "\x30" . chr(strlen($seq)) . $seq;
    $pem = base64_decode(getenv('VAPID_PRIVATE_KEY'));
    $pub = openssl_pkey_get_details(openssl_pkey_get_private($pem))['key'];
    eq(1, openssl_verify($h . '.' . $c, $der, $pub, OPENSSL_ALGO_SHA256), 'openssl verifies the signature');
});

echo "\n  $PASSED passed, $FAILED failed\n";
exit($FAILED === 0 ? 0 : 1);
