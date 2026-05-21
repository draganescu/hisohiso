FROM node:20-alpine AS frontend
WORKDIR /build/app
COPY ./app/package.json ./app/package-lock.json* ./
RUN npm install
COPY ./app/ .
RUN npm run build

# `1-php8.3` follows the latest FrankenPHP 1.x with PHP 8.3.x — `latest-php8.3`
# is a stale alias frozen on FrankenPHP 1.1.5 / PHP 8.3.7 (May 2024). Combined
# with `build --pull` in scripts/deploy.sh, every deploy picks up the current
# FrankenPHP + Caddy + PHP patch. The Caddyfile @api handler uses an explicit
# `try_files {path} /index.php` + `php` so the routing is robust against
# php_server's evolving shorthand semantics between Caddy 2.7 → 2.11.
FROM dunglas/frankenphp:1-php8.3
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

COPY ./server /app/server
COPY ./public /app/landing
COPY --from=frontend /build/app/dist /app/public
COPY Caddyfile /etc/caddy/Caddyfile
ENV MERCURE_PUBLISHER_JWT_KEY='!ChangeMe!'
ENV MERCURE_SUBSCRIBER_JWT_KEY='!ChangeMe!'
