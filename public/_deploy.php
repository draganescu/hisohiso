<?php

/**
 * Push-webhook receiver for the static marketing site.
 *
 * The content pages (this `public/` directory) can be hosted at the apex domain
 * separately from the app container. This is meant for generic web hosting that
 * can serve PHP and run git over SSH, but cannot run a persistent listener.
 * Deploys are pull-based: GitHub POSTs here on every push, this script verifies
 * the HMAC signature and fast-forwards the on-disk checkout.
 *
 * Setup (one-time, over SSH on the marketing host) is documented in
 * docs/split-hosting.md. In short:
 *   - clone the repo somewhere outside the served web directory
 *   - point the domain's web directory at the repo's `public/` folder
 *   - write the shared secret to `.deploy-secret` in the REPO ROOT (one dir up
 *     from this file — outside the web directory, and .gitignored)
 *   - add a GitHub webhook → https://www.hisohiso.org/_deploy.php, content-type
 *     application/json, secret = the same value, events = "push"
 *
 * Security model: the endpoint is public (GitHub must reach it), so it does
 * nothing until it sees a valid X-Hub-Signature-256 over the raw body. Anything
 * unsigned/forged gets a flat 404 — no hint that a deploy hook lives here.
 */

declare(strict_types=1);

// The git checkout root is the parent of this web directory (docroot = public/).
$repoDir = realpath(__DIR__ . '/..');
$branch  = getenv('HISOHISO_DEPLOY_BRANCH') ?: 'main';
$logFile = $repoDir . '/.deploy.log';

// Secret: prefer an env var (e.g. SetEnv in .htaccess), else a file in the repo
// root that lives OUTSIDE the served docroot and is gitignored.
$secret = getenv('HISOHISO_DEPLOY_SECRET') ?: '';
if ($secret === '') {
    $secretFile = $repoDir . '/.deploy-secret';
    if (is_readable($secretFile)) {
        $secret = trim((string) file_get_contents($secretFile));
    }
}

/** Log a line and exit with an HTTP status. Never echoes the secret. */
function done(int $status, string $message, string $logFile): never
{
    http_response_code($status);
    $ts = gmdate('c');
    @file_put_contents($logFile, "[$ts] HTTP $status — $message\n", FILE_APPEND);
    // Deliberately terse to callers; detail goes to the log only.
    echo $status >= 200 && $status < 300 ? "ok\n" : "no\n";
    exit;
}

// Fail closed if the deploy isn't configured, but stay silent to the world.
if ($secret === '') {
    done(404, 'no secret configured', $logFile);
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    done(404, 'not a POST', $logFile);
}

$event = $_SERVER['HTTP_X_GITHUB_EVENT'] ?? '';
$body  = file_get_contents('php://input');
if ($body === false || $body === '') {
    done(404, 'empty body', $logFile);
}

// Verify HMAC-SHA256 (`sha256=<hex>`), constant-time.
$sigHeader = $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '';
$expected  = 'sha256=' . hash_hmac('sha256', $body, $secret);
if ($sigHeader === '' || !hash_equals($expected, $sigHeader)) {
    done(404, 'bad signature', $logFile);
}

// Signature is valid from here on.
if ($event === 'ping') {
    done(200, 'pong', $logFile);
}
if ($event !== 'push') {
    done(204, "ignored event: $event", $logFile);
}

$payload = json_decode($body, true);
$ref     = is_array($payload) ? ($payload['ref'] ?? '') : '';
if ($ref !== "refs/heads/$branch") {
    done(204, "ignored ref: $ref", $logFile);
}

// Some web hosts disable exec — fail loudly in the log if so.
if (!function_exists('shell_exec')) {
    done(500, 'shell_exec disabled — use the cron-poll fallback', $logFile);
}

// Fast-forward the checkout to the pushed commit. reset --hard also applies
// tracked-file deletions, so removed pages disappear. Untracked files are left
// alone (a content checkout shouldn't have any).
$git = 'git -C ' . escapeshellarg($repoDir);
$cmd = "$git fetch --prune origin " . escapeshellarg($branch) . ' 2>&1'
     . " && $git reset --hard " . escapeshellarg("origin/$branch") . ' 2>&1';
$output = shell_exec($cmd) ?? '';

@file_put_contents($logFile, "[" . gmdate('c') . "] deploy $branch:\n$output\n", FILE_APPEND);

if (!str_contains($output, 'HEAD is now at')) {
    done(500, 'git failed (see .deploy.log)', $logFile);
}

done(200, 'deployed', $logFile);
