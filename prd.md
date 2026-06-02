{
  "product": {
    "name": "Hisohiso",
    "version": "0.1.0",
    "description": "A minimal, URL-capability, encrypted chat system. No accounts. No cloud history. No tracking.",
    "core_principles": [
      "URL is the capability",
      "End-to-end encryption (Client-side)",
      "Server sees only hashed metadata",
      "Local-only message storage",
      "Room persistence tied to activity/existence",
      "Democratic approval and destruction"
    ]
  },
  "technical_architecture": {
    "stack": {
      "server_runtime": "FrankenPHP (PHP 8.3+)",
      "web_server": "Caddy (embedded in FrankenPHP)",
      "realtime_bus": "Mercure (embedded in FrankenPHP)",
      "database": "SQLite (with WAL mode)",
      "frontend_app": "React + Vite + TailwindCSS",
      "frontend_landing": "Plain HTML5 + CSS3",
      "cryptography": "Web Crypto API (AES-256-GCM, HKDF, SHA-256)"
    }
  },
  "protocol_implementation": {
    "cryptography_flow": {
      "creation": {
        "client_action": "Generate 32-byte random 'room_secret'. Derive 'room_hash' = SHA256('hisohiso.room_hash' + room_secret). Redirect to /room/{room_secret}.",
        "server_knowledge": "Receives 'room_hash' only. Does not see 'room_secret'."
      },
      "messaging": {
        "algorithm": "AES-256-GCM",
        "derivation": "k_msg = PBKDF2-HMAC-SHA256(password=pairing_code, salt=SHA-256('hisohiso.kdf.v1.k_msg' || 0x00 || room_secret), iterations=600000) (finding #93)",
        "payload": {
          "nonce": "12 bytes (unique)",
          "aad": "room_hash + msg_type + msg_id",
          "ciphertext": "AES encrypted body"
        }
      }
    },
    "authentication": {
      "mechanism": "Bearer Token (Participant Token)",
      "format": "32-byte random string",
      "server_storage": "SHA-256(participant_token)",
      "validation": "Request header 'X-Chat-Token' is hashed and compared to DB."
    }
  },
  "database_schema": {
    "engine": "SQLite",
    "tables": {
      "rooms": {
        "columns": [
          "room_hash (TEXT, PK)",
          "created_at (INTEGER)",
          "last_activity_at (INTEGER)"
        ]
      },
      "participants": {
        "columns": [
          "token_hash (TEXT, PK)",
          "room_hash (TEXT, FK)",
          "joined_at (INTEGER)"
        ]
      }
    }
  },
  "api_specification": {
    "base_path": "/api",
    "endpoints": [
      {
        "method": "POST",
        "path": "/rooms",
        "purpose": "Create or check room. room_hash must match /^[0-9a-f]{64}$/ (the SHA-256 hex output the client derives from the room secret). Anything else is rejected with 400 invalid_room_hash.",
        "body": { "room_hash": "string" },
        "response": { "status": "created|exists", "has_participants": "boolean", "participant_token": "string (on created)", "subscriber_jwt": "string (on created) — Mercure subscriber JWT scoped to room:{room_hash}, ~7d TTL" }
      },
      {
        "method": "POST",
        "path": "/rooms/{room_hash}/knock",
        "purpose": "Request entry to lobby. Knocker generates an ephemeral ECDH P-256 keypair, sends the SPKI-encoded public key as knock_pubkey, and retains the private key in memory to unwrap the participant token from the matching /token event.",
        "body": { "msg_id": "string", "encrypted_payload": "string", "knock_pubkey": "string (base64url SPKI ECDH P-256)" },
        "response": { "status": "ok", "lobby_jwt": "string — short-TTL (~10 min) Mercure subscriber JWT scoped to room:{room_hash}, used by the knocker to receive the wrapped /token event" },
        "mercure_event": "knock"
      },
      {
        "method": "POST",
        "path": "/rooms/{room_hash}/approve",
        "purpose": "Grant access. Mints a participant token and returns it (plus a fresh subscriber JWT) in the HTTPS response only. The published approve event has an empty body; the new token is delivered out-of-band via /token, wrapped as JSON {token, subscriber_jwt}.",
        "headers": { "X-Chat-Token": "required" },
        "response": { "new_participant_token": "string", "subscriber_jwt": "string — ~7d TTL Mercure subscriber JWT scoped to room:{room_hash}" },
        "mercure_event": "approve"
      },
      {
        "method": "POST",
        "path": "/rooms/{room_hash}/sub-token",
        "purpose": "Refresh a subscriber JWT for an existing participant whose previous JWT has expired (or was lost). Idempotent; does not mint a new participant.",
        "headers": { "X-Chat-Token": "required" },
        "response": { "subscriber_jwt": "string" }
      },
      {
        "method": "POST",
        "path": "/rooms/{room_hash}/token",
        "purpose": "Deliver a freshly-minted participant token to a specific knocker. Approver mints its own ephemeral ECDH P-256 keypair, derives a shared secret with the knocker's knock_pubkey (HKDF-SHA256, info='hisohiso.token_wrap'), AES-256-GCM encrypts the token, and posts the wrapped payload. Server publishes a `token` event carrying knock_msg_id + approver_pubkey + nonce + ct. Only the knocker (holding the matching private key) can derive the shared secret and decrypt.",
        "headers": { "X-Chat-Token": "required" },
        "body": { "knock_msg_id": "string", "approver_pubkey": "string", "nonce": "string", "ct": "string" },
        "mercure_event": "token"
      },
      {
        "method": "POST",
        "path": "/rooms/{room_hash}/message",
        "purpose": "Send chat payload",
        "headers": { "X-Chat-Token": "required" },
        "body": { "encrypted_payload": "json_string" },
        "mercure_event": "chat"
      },
      {
        "method": "POST",
        "path": "/rooms/{room_hash}/disband",
        "purpose": "Destroy room",
        "headers": { "X-Chat-Token": "required" },
        "mercure_event": "destroy"
      }
    ]
  },
  "frontend_application": {
    "routes": [
      { "path": "/", "component": "LandingPage" },
      { "path": "/new", "component": "RoomCreator" },
      { "path": "/:room_secret", "component": "RoomController" }
    ],
    "storage": {
      "technology": "IndexedDB (via Dexie.js)",
      "schema": "messages(id, room_hash, timestamp, content, type)"
    },
    "state_machine": {
      "states": ["INIT", "LOBBY_WAITING", "LOBBY_EMPTY", "PARTICIPANT", "DESTROYED"],
      "transitions": {
        "INIT": "Check DB for token ? PARTICIPANT : Check Server",
        "Check Server": "Room Exists ? (Participants ? LOBBY_WAITING : LOBBY_EMPTY) : CREATE_ROOM"
      }
    }
  },
  "landing_page_spec": {
    "tech": "Single HTML file + Inline CSS (Critical path) + External CSS",
    "sections": [
      {
        "id": "hero",
        "content": "Fuck your bubble color. Just chat. No accounts. No tracking. No feeds. No blue vs green.",
        "cta": "Start a room"
      },
      {
        "id": "concept",
        "content": "It’s just a room. You open a link. You share it. People knock. You approve. You talk. Anyone can disband the room."
      },
      {
        "id": "identity",
        "content": "Everyone same color. Messaging turned into identity. Blue vs green. We don’t care. Here, everyone is just text in the same room."
      },
      {
        "id": "privacy",
        "content": "Private by design. Messages are encrypted in your browser. The server only routes unreadable data. Lose the link, lose the room."
      },
      {
        "id": "manifesto",
        "content": "Not a platform. Not social media. Not enterprise chat. Just a shared space for people who already know each other."
      },
      {
        "id": "open",
        "content": "Open. Run your own server. Or just use it."
      }
    ]
  },
  "developer_experience": {
    "file_structure": {
      "root": [
        "app/ (React)",
        "public/ (Landing)",
        "server/ (PHP scripts)",
        "compose.yaml",
        "Caddyfile",
        "Dockerfile"
      ]
    },
    "commands": {
      "start": "docker compose up -d",
      "logs": "docker compose logs -f",
      "build": "docker compose build",
      "test": "cd server && php tests.php"
    }
  },
  "ops_configuration": {
    "dockerfile": "FROM dunglas/frankenphp:latest-php8.3\nRUN install-php-extensions pdo_sqlite\nCOPY ./server /app/server\nCOPY ./app/dist /app/public\nCOPY Caddyfile /etc/caddy/Caddyfile\nENV MERCURE_PUBLISHER_JWT_KEY='!ChangeMe!'\nENV MERCURE_SUBSCRIBER_JWT_KEY='!ChangeMe!'",
    "caddyfile": "{\n\tfrankenphp\n\torder mercure before php_server\n}\n\n:80 {\n\t# Serve Frontend App (React)\n\ttry_files {path} /index.html\n\troot * /app/public\n\n\t# Mercure Hub\n\tmercure {\n\t\tpublisher_jwt !ChangeMe!\n\t\tsubscriber_jwt !ChangeMe!\n\t}\n\n\t# PHP Backend API\n\troute /api/* {\n\t\troot * /app/server\n\t\tphp_server\n\t}\n}",
    "compose_yaml": "services:\n  app:\n    build: .\n    ports:\n      - '80:80'\n      - '443:443'\n    environment:\n      - SERVER_NAME=:80\n      - MERCURE_PUBLISHER_JWT_KEY=!ChangeMe!\n      - MERCURE_SUBSCRIBER_JWT_KEY=!ChangeMe!\n    volumes:\n      - ./data:/data\n      - ./server:/app/server"
  }
}
