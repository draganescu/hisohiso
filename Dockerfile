FROM node:20-alpine AS frontend
WORKDIR /build/app
COPY ./app/package.json ./app/package-lock.json* ./
RUN npm install
COPY ./app/ .
RUN npm run build

# `1-php8.3` follows the latest FrankenPHP 1.x with PHP 8.3.x — `latest-php8.3`
# is a stale alias frozen on FrankenPHP 1.1.5 / PHP 8.3.7 (May 2024). The
# Caddyfile @api handler uses an explicit `try_files {path} /index.php` + `php`
# so the routing is robust against php_server's evolving shorthand semantics
# between Caddy 2.7 → 2.11. Combined with `build --pull` in scripts/deploy.sh,
# every deploy picks up the current FrankenPHP + Caddy + PHP patch.
FROM dunglas/frankenphp:1-php8.3

# Refuse to build an image whose PHP is older than the last security release
# we know about (8.3.36 fixes PHP2Shell, CVE-2026-109618/109619). FrankenPHP
# can lag PHP releases by hours, and a stale image would otherwise deploy
# silently. Bump this when the next one lands. Ask frankenphp's embedded PHP
# rather than trusting `frankenphp version`: that line shows the PHP the
# binary was compiled against, not the libphp.so it actually runs.
RUN frankenphp php-cli -r 'exit(version_compare(PHP_VERSION, "8.3.36", ">=") ? 0 : 1);' \
 || { echo "PHP $(frankenphp php-cli -r 'echo PHP_VERSION;') is older than 8.3.36 (PHP2Shell)" >&2; exit 1; }

RUN install-php-extensions pdo_sqlite

# Production PHP settings: never leak errors to clients, log them server-side
# to a path inside the writable bind mount, and strip the X-Powered-By header.
# Use --pull on the deploy build (see scripts/deploy.sh) to refresh the base
# image's PHP/Caddy/FrankenPHP versions periodically.
RUN { \
      echo 'display_errors=Off'; \
      echo 'display_startup_errors=Off'; \
      echo 'log_errors=On'; \
      echo 'error_log=/data/php-errors.log'; \
      echo 'expose_php=Off'; \
    } > /usr/local/etc/php/conf.d/zz-prod.ini

COPY --from=frontend /build/app/dist /app/public
# PHP API lives under /app/public/api so FrankenPHP's worker root (/app/public)
# can resolve it. Per-handle `root *` in Caddy doesn't propagate to FrankenPHP's
# `php` directive — the worker always uses its global root — so the API must
# live inside that root rather than at a sibling path like /app/server.
COPY ./server /app/public/api
# Remove FrankenPHP's default phpinfo() welcome page so a stray /index.php
# request (or a misrouted /api/*) can't leak our PHP build info.
RUN rm -f /app/public/index.php
# FrankenPHP 1.x reads its Caddyfile from /etc/frankenphp/Caddyfile (the
# /etc/caddy/Caddyfile path the older Caddy/FrankenPHP image used is silently
# ignored). Copy to both so the image is robust to either lookup path.
COPY Caddyfile /etc/frankenphp/Caddyfile
COPY Caddyfile /etc/caddy/Caddyfile
ENV MERCURE_PUBLISHER_JWT_KEY='!ChangeMe!'
ENV MERCURE_SUBSCRIBER_JWT_KEY='!ChangeMe!'
