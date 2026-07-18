<?php
declare(strict_types=1);

// Tests for server/outbox.php — the offline catch-up store and its two-stage
// age-out (content -> tombstone -> gone). Standalone, no PHPUnit / Composer.
//
// Run inside the running dev container so PHP version + extensions match
// production:
//
//   docker compose exec app php /app/public/api/tests/test_outbox.php
//
// Exits 0 on all-pass, 1 on the first failure.

$ROOT = dirname(__DIR__);
require_once $ROOT . '/utils.php';
require_once $ROOT . '/db.php';
require_once $ROOT . '/outbox.php';

// Isolated tempdirs so we never touch the real /data SQLite or /data/rooms.
$tmp = sys_get_temp_dir() . '/hisohiso-outbox-test-' . bin2hex(random_bytes(4));
mkdir($tmp, 0775, true);
putenv('CHAT_DB_PATH=' . $tmp . '/chat.sqlite');
putenv('OUTBOX_DIR=' . $tmp . '/rooms');
register_shutdown_function(function () use ($tmp): void {
    foreach (glob($tmp . '/rooms/*') ?: [] as $f) { @unlink($f); }
    @rmdir($tmp . '/rooms');
    foreach (glob($tmp . '/*') ?: [] as $f) { @unlink($f); }
    foreach (glob($tmp . '/.[!.]*') ?: [] as $f) { @unlink($f); }
    @rmdir($tmp);
});

db(); // materialize the rooms table before any append re-reads catch_up_enabled

$ROOM = str_repeat('a', 64); // valid ^[0-9a-f]{64}$ room hash
$NOW  = (int) round(microtime(true) * 1000);

// Insert a row straight into the outbox with an explicit ts — outbox_append
// stamps `now`, so we can't age a message through it; go under it for control.
function seed(string $room, string $msg_id, int $ts, string $payload, ?string $sender): void {
    $pdo = outbox_open($room);
    $stmt = $pdo->prepare('INSERT OR REPLACE INTO messages (msg_id, ts, sender_hash, encrypted_payload)
        VALUES (:id, :ts, :sender, :payload)');
    $stmt->execute([':id' => $msg_id, ':ts' => $ts, ':sender' => $sender, ':payload' => $payload]);
}

$FAILED = 0; $PASSED = 0;
function t(string $name, callable $fn): void {
    global $FAILED, $PASSED;
    try { $fn(); $PASSED++; echo "ok   - $name\n"; }
    catch (Throwable $e) { $FAILED++; echo "FAIL - $name: " . $e->getMessage() . "\n"; }
}
function eq($a, $b, string $m = ''): void {
    if ($a !== $b) { throw new RuntimeException($m . " (got " . var_export($a, true) . ", want " . var_export($b, true) . ")"); }
}

t('fresh message is returned intact', function () use ($ROOM, $NOW) {
    seed($ROOM, 'fresh', $NOW - 1000, '{"ct":"live"}', 'sender-fresh');
    $rows = outbox_fetch($ROOM, 0);
    $fresh = array_values(array_filter($rows, fn($r) => $r['msg_id'] === 'fresh'));
    eq(count($fresh), 1, 'fresh row present');
    eq($fresh[0]['encrypted_payload'], '{"ct":"live"}', 'payload intact');
    eq($fresh[0]['sender_hash'], 'sender-fresh', 'sender intact');
    eq($fresh[0]['expired'], false, 'not expired');
});

t('message past TTL becomes a content-free tombstone', function () use ($ROOM, $NOW) {
    seed($ROOM, 'stale', $NOW - (OUTBOX_TTL_MS + 3600_000), '{"ct":"secret"}', 'sender-stale');
    $rows = outbox_fetch($ROOM, 0);
    $stale = array_values(array_filter($rows, fn($r) => $r['msg_id'] === 'stale'));
    eq(count($stale), 1, 'tombstone row still present');
    eq($stale[0]['expired'], true, 'flagged expired');
    eq($stale[0]['encrypted_payload'], '', 'payload stripped');
    eq($stale[0]['sender_hash'], null, 'sender forgotten');
});

t('tombstone past its own TTL is hard-deleted', function () use ($ROOM, $NOW) {
    seed($ROOM, 'ancient', $NOW - (OUTBOX_TOMBSTONE_TTL_MS + 3600_000), '', null);
    $rows = outbox_fetch($ROOM, 0);
    $ancient = array_filter($rows, fn($r) => $r['msg_id'] === 'ancient');
    eq(count($ancient), 0, 'ancient tombstone gone');
});

t('append ages out a pre-existing stale row and inserts the new one', function () use ($ROOM, $NOW) {
    // catch_up must be enabled or append re-reads 0 and refuses to insert.
    db()->prepare('INSERT OR REPLACE INTO rooms (room_hash, created_at, last_activity_at, catch_up_enabled)
        VALUES (:h, :t, :t, 1)')->execute([':h' => $ROOM, ':t' => $NOW]);
    seed($ROOM, 'stale2', $NOW - (OUTBOX_TTL_MS + 3600_000), '{"ct":"old"}', 'who');
    outbox_append($ROOM, 'brand-new', '{"ct":"new"}', 'sender-new');
    $rows = outbox_fetch($ROOM, 0);
    $byId = [];
    foreach ($rows as $r) { $byId[$r['msg_id']] = $r; }
    eq(isset($byId['brand-new']), true, 'new message stored');
    eq($byId['brand-new']['expired'], false, 'new message live');
    eq($byId['stale2']['expired'], true, 'stale row tombstoned by append');
    eq($byId['stale2']['encrypted_payload'], '', 'stale payload stripped by append');
});

t('since_ts cursor still filters tombstones by ts', function () use ($ROOM, $NOW) {
    // A client whose newest local message is AFTER the tombstone must not
    // re-receive it — the tombstone's original ts drives the cursor.
    $rows = outbox_fetch($ROOM, $NOW); // since = now, nothing older qualifies
    eq(count(array_filter($rows, fn($r) => $r['expired'])), 0, 'no stale tombstone past cursor');
});

echo "\n$PASSED passed, $FAILED failed\n";
exit($FAILED === 0 ? 0 : 1);
