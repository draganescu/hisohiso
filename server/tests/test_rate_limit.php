<?php
declare(strict_types=1);

// Tests for server/rate_limit.php. Standalone — no PHPUnit / Composer.
//
// Run inside the running dev container so PHP version + extensions match
// production:
//
//   docker compose exec app php /app/public/api/tests/test_rate_limit.php
//
// Exits 0 on all-pass, 1 on the first failure. Each test prints a single
// line, so the runner stays readable in CI later if we plug it in.

$ROOT = dirname(__DIR__);
require_once $ROOT . '/utils.php';
require_once $ROOT . '/db.php';
require_once $ROOT . '/rate_limit.php';

// Isolated tempdir so we never touch the real /data SQLite or .rl_secret.
// Each suite run gets its own dir; we clean it up on exit (success OR fail).
$tmp = sys_get_temp_dir() . '/hisohiso-rl-test-' . bin2hex(random_bytes(4));
mkdir($tmp, 0775, true);
putenv('CHAT_DB_PATH=' . $tmp . '/test.sqlite');
register_shutdown_function(function () use ($tmp): void {
    foreach (glob($tmp . '/*') ?: [] as $f) { @unlink($f); }
    foreach (glob($tmp . '/.[!.]*') ?: [] as $f) { @unlink($f); }
    @rmdir($tmp);
});

// Force the db() bootstrap to run now so the rate_limits table exists before
// any test touches it.
db();

// Tiny assertion harness. Each `t()` runs one named test; `eq` / `truthy` /
// `throws` are the only matchers we need.
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
        $e = var_export($expected, true);
        $a = var_export($actual, true);
        throw new RuntimeException(($msg !== '' ? "$msg: " : '') . "expected $e, got $a");
    }
}
function truthy($v, string $msg = ''): void {
    if (!$v) throw new RuntimeException($msg !== '' ? $msg : 'expected truthy');
}

// Helper: set REMOTE_ADDR for the next client_tag() call. rate_limit.php reads
// $_SERVER['REMOTE_ADDR'] directly so swapping it here is sufficient.
function as_ip(string $ip): void { $_SERVER['REMOTE_ADDR'] = $ip; }

// Helper: directly INSERT a bucket row with an arbitrary window_start, so we
// can test the window-reset path without mocking time(). Mirrors the schema
// in db.php and the bucket_key format from rate_limit_hit().
function seed_bucket(string $route, string $ip, int $window_start, int $count): void {
    $key = $route . '|' . substr(hash_hmac('sha256', $ip, rate_limit_secret()), 0, 32);
    $stmt = db()->prepare(
        'INSERT OR REPLACE INTO rate_limits (bucket_key, window_start, count)
         VALUES (:k, :ws, :c)'
    );
    $stmt->execute([':k' => $key, ':ws' => $window_start, ':c' => $count]);
}

echo "rate_limit.php tests\n";

// ── rate_limit_secret() ──────────────────────────────────────────────────────

t('secret is created on first call and memoized', function (): void {
    $s1 = rate_limit_secret();
    eq(32, strlen($s1), 'secret is 32 bytes');
    $s2 = rate_limit_secret();
    eq($s1, $s2, 'second call returns the same secret');
});

t('secret file has 0600 perms', function () use ($tmp): void {
    $path = $tmp . '/.rl_secret';
    truthy(file_exists($path), 'secret file exists');
    // POSIX perms come back in the low 9 bits; mask off the file-type bits.
    $mode = fileperms($path) & 0777;
    eq(0600, $mode, 'secret file perms');
});

// ── client_tag() ─────────────────────────────────────────────────────────────

t('client_tag is deterministic per IP', function (): void {
    as_ip('203.0.113.5');
    $a = client_tag();
    $b = client_tag();
    eq($a, $b, 'same IP → same tag');
    eq(32, strlen($a), 'tag is 32 hex chars (128 bits)');
});

t('client_tag differs across IPs', function (): void {
    as_ip('203.0.113.5');  $a = client_tag();
    as_ip('203.0.113.6');  $b = client_tag();
    truthy($a !== $b, 'distinct IPs produce distinct tags');
});

t('client_tag never returns a raw IP', function (): void {
    as_ip('203.0.113.5');
    $tag = client_tag();
    truthy(!str_contains($tag, '203'), 'tag does not contain IP octets');
    truthy(ctype_xdigit($tag), 'tag is pure hex');
});

t('client_tag falls back when REMOTE_ADDR is empty', function (): void {
    unset($_SERVER['REMOTE_ADDR']);
    $tag = client_tag();
    eq(32, strlen($tag), 'still returns a tag');
    // Same tag for two missing-IP requests — they all bucket together, which
    // is the conservative behaviour: shared bucket > silent bypass.
    $tag2 = client_tag();
    eq($tag, $tag2, 'missing-IP requests share one bucket');
});

// ── rate_limit_hit() ─────────────────────────────────────────────────────────

t('first hit in a fresh bucket returns 1', function (): void {
    as_ip('198.51.100.10');
    eq(1, rate_limit_hit('test_first', 60));
});

t('successive hits in the same window increment', function (): void {
    as_ip('198.51.100.11');
    eq(1, rate_limit_hit('test_incr', 60));
    eq(2, rate_limit_hit('test_incr', 60));
    eq(3, rate_limit_hit('test_incr', 60));
});

t('different routes do not share counters', function (): void {
    as_ip('198.51.100.12');
    eq(1, rate_limit_hit('test_route_a', 60));
    eq(1, rate_limit_hit('test_route_b', 60), 'route_b starts at 1 even though route_a is at 1');
    eq(2, rate_limit_hit('test_route_a', 60), 'route_a continues independently');
});

t('different IPs do not share counters', function (): void {
    as_ip('198.51.100.20');  eq(1, rate_limit_hit('test_per_ip', 60));
    as_ip('198.51.100.21');  eq(1, rate_limit_hit('test_per_ip', 60), 'second IP starts at 1');
    as_ip('198.51.100.20');  eq(2, rate_limit_hit('test_per_ip', 60), 'first IP continues at 2');
});

t('a new window resets the counter to 1', function (): void {
    as_ip('198.51.100.30');
    // Seed the bucket as if 5 hits landed an hour ago. The UPSERT's CASE-WHEN
    // should detect window_start has moved on and reset count to 1.
    $now = time();
    $window = 60;
    $stale_window_start = ($now - 3600) - (($now - 3600) % $window);
    seed_bucket('test_window_reset', '198.51.100.30', $stale_window_start, 5);
    eq(1, rate_limit_hit('test_window_reset', $window), 'fresh window starts over');
});

t('hit count is returned atomically (no read-after-write race shape)', function (): void {
    // We can't fork two PHP processes here, but we can at least confirm the
    // single-call shape: the count returned equals the count persisted.
    as_ip('198.51.100.40');
    $n = rate_limit_hit('test_atomic', 60);
    $stmt = db()->prepare('SELECT count FROM rate_limits WHERE bucket_key = :k');
    $stmt->execute([':k' => 'test_atomic|' . client_tag()]);
    $stored = (int) $stmt->fetchColumn();
    eq($stored, $n, 'returned count matches stored count');
});

// ── rate_limit_prune_stale() ─────────────────────────────────────────────────

t('prune removes rows whose window_start is older than 1h', function () use ($tmp): void {
    // Insert one stale row (2h old) and one fresh row.
    as_ip('198.51.100.50');
    $stale_ws = time() - 7200;
    seed_bucket('test_prune_stale', '198.51.100.50', $stale_ws, 99);
    seed_bucket('test_prune_fresh', '198.51.100.50', time(), 99);
    // Bypass the mtime gate so this prune actually runs.
    @unlink($tmp . '/.rate_limit_cleanup_at');

    rate_limit_prune_stale();

    $stmt = db()->prepare('SELECT COUNT(*) FROM rate_limits WHERE bucket_key LIKE :k');
    $stmt->execute([':k' => 'test_prune_stale|%']);
    eq(0, (int) $stmt->fetchColumn(), 'stale row is gone');
    $stmt->execute([':k' => 'test_prune_fresh|%']);
    eq(1, (int) $stmt->fetchColumn(), 'fresh row survived');
});

t('prune is rate-limited by the mtime marker', function () use ($tmp): void {
    // Seed another stale row, but freeze the marker mtime to now so the prune
    // should short-circuit and leave the row in place.
    as_ip('198.51.100.51');
    seed_bucket('test_prune_gated', '198.51.100.51', time() - 7200, 1);
    touch($tmp . '/.rate_limit_cleanup_at', time());

    rate_limit_prune_stale();

    $stmt = db()->prepare('SELECT COUNT(*) FROM rate_limits WHERE bucket_key LIKE :k');
    $stmt->execute([':k' => 'test_prune_gated|%']);
    eq(1, (int) $stmt->fetchColumn(), 'mtime-gated prune did not run');
});

echo "\n  $PASSED passed, $FAILED failed\n";
exit($FAILED === 0 ? 0 : 1);
