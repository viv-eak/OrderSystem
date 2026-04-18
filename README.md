# Real-Time Order System

A production-minded, event-driven food delivery backend built as a TypeScript monorepo with:

- Express services
- React frontend
- PostgreSQL with Prisma
- Apache Kafka
- Redis
- JWT auth with refresh rotation
- WebSocket notifications
- Docker Compose local orchestration

## Services

- `services/gateway`: public API gateway, auth enforcement, request rate limiting, WebSocket hub
- `services/auth-service`: signup, login, refresh, logout, RBAC claims
- `services/order-service`: order creation, reads, cancellation, transactional outbox publishing
- `services/processing-service`: order lifecycle progression, retries, DLQ handling, distributed locking
- `services/notification-service`: status notifications and WebSocket fanout via Redis pub/sub
- `services/frontend`: React control room for auth, order creation, order tracking, and live updates
- `packages/shared`: shared config, logger, auth, Kafka, Redis, and Prisma helpers

## Quick Start

1. Copy `.env.example` to `.env` and adjust secrets if needed.
2. Enable pnpm with `corepack enable`.
3. Install dependencies with `corepack pnpm install`.
4. Generate Prisma client with `corepack pnpm prisma:generate`.
5. Push the schema with `corepack pnpm prisma:push`.
6. Start everything with `docker compose up --build`.

The backend gateway will be available on `http://localhost:4000`, and the React frontend will be available on `http://localhost:4173`.
Browser access is allowed from `http://localhost:5173` and `http://localhost:4173` by default through the gateway's `CORS_ORIGINS` setting.

## Frontend Local Dev

If you want hot reload without rebuilding Docker, run the backend with Docker Compose and the frontend locally:

1. Start the backend stack:
   `docker compose up --build gateway auth-service order-service processing-service notification-service postgres redis kafka migrator`
2. In a second terminal:
   `corepack pnpm --filter @ordersystem/frontend dev`
3. Open `http://localhost:5173`

The Vite dev server proxies `/auth`, `/orders`, and `/ws` to the gateway on `localhost:4000`, so you do not need to configure CORS for local development.

## Architecture Notes

- Orders are written together with an outbox event in a single database transaction.
- The order service publishes pending outbox rows to Kafka.
- Processing and notification consumers are idempotent via the `processed_events` table.
- Redis is used for rate limiting, token blacklisting, order caching, socket fanout, and short-lived processing locks.
