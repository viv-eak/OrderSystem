# Deployment Guide

This project uses a split deployment strategy:
- **Frontend** → Vercel
- **Backend services + infrastructure** → Railway

---

## Architecture Overview

| Service | Platform | URL (after deploy) |
|---|---|---|
| Frontend | Vercel | `https://your-app.vercel.app` |
| Gateway | Railway | `https://gateway.railway.app` |
| Auth Service | Railway | internal |
| Order Service | Railway | internal |
| Processing Service | Railway | internal |
| Notification Service | Railway | internal |
| Postgres | Railway | internal |
| Redis | Railway | internal |
| Kafka | Confluent Cloud | external |
| Dozzle (logs) | Railway | `https://dozzle.railway.app` |

---

## Step 1 — Set up Kafka (Confluent Cloud)

Kafka cannot run well on Railway, so use Confluent Cloud's free tier.

1. Sign up at [confluent.io](https://confluent.io) and create a free cluster
2. Create a topic: `orders`
3. Go to **API Keys** → create a key → save the **API Key** and **API Secret**
4. Copy the **Bootstrap Server URL** (looks like `pkc-xxx.region.aws.confluent.cloud:9092`)

You will need these three values later:
```
KAFKA_BROKER=pkc-xxx.region.aws.confluent.cloud:9092
KAFKA_API_KEY=your-api-key
KAFKA_API_SECRET=your-api-secret
```

---

## Step 2 — Set up Railway

1. Sign up at [railway.app](https://railway.app)
2. Create a new **Project**
3. Add a **Postgres** service → Railway provisions it automatically → copy the `DATABASE_URL`
4. Add a **Redis** service → Railway provisions it automatically → copy the `REDIS_URL`

---

## Step 3 — Deploy Backend Services on Railway

Deploy each service as a separate Railway service from the same GitHub repo.

For each service (`gateway`, `auth-service`, `order-service`, `processing-service`, `notification-service`):

1. Click **New Service** → **GitHub Repo**
2. Select this repository
3. Set the **Dockerfile path** to `docker/Dockerfile`
4. Add build argument: `SERVICE_PATH=services/<service-name>`
5. Set the environment variables (see Step 4)
6. Deploy

### Deploy the Migrator (run once)

1. Click **New Service** → **GitHub Repo**
2. Set **Dockerfile path** to `docker/Migrator.Dockerfile`
3. Add the same environment variables
4. Deploy — it will run `prisma db push` and exit
5. You can delete this service after the first successful run

---

## Step 4 — Environment Variables

Set these variables on **every backend Railway service**:

```env
DATABASE_URL=postgresql://...         # from Railway Postgres
REDIS_URL=redis://...                 # from Railway Redis

KAFKA_BROKER=pkc-xxx...confluent.cloud:9092
KAFKA_API_KEY=your-confluent-api-key
KAFKA_API_SECRET=your-confluent-api-secret

JWT_SECRET=your-random-secret-string

NODE_ENV=production
```

Set these on the **gateway service only**:
```env
PORT=4000
AUTH_SERVICE_URL=https://auth-service.railway.internal
ORDER_SERVICE_URL=https://order-service.railway.internal
```

> Railway services in the same project can communicate over private internal URLs — use `.railway.internal` hostnames to avoid public network costs.

---

## Step 5 — Deploy Frontend on Vercel

1. Sign up at [vercel.com](https://vercel.com)
2. Click **Add New Project** → import this GitHub repository
3. Set **Root Directory** to `services/frontend`
4. Set **Framework Preset** to `Vite`
5. Add environment variable:
   ```
   VITE_API_BASE_URL=https://gateway.up.railway.app
   ```
   (use the public URL of your Railway gateway service)
6. Click **Deploy**

---

## Step 6 — Verify Deployment

Run through these checks after everything is deployed:

- [ ] Visit the Vercel frontend URL — app loads
- [ ] Register a new user — auth service is reachable
- [ ] Place an order — order service and Kafka are working
- [ ] Check order status updates — processing service consuming from Kafka
- [ ] Check notification arrives — notification service working

---

## Redeployment

- **Code changes** → push to `main` branch → Railway and Vercel auto-redeploy
- **Schema changes** → redeploy the migrator service manually after pushing

---

## Environment Summary

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Railway Postgres service → Variables tab |
| `REDIS_URL` | Railway Redis service → Variables tab |
| `KAFKA_BROKER` | Confluent Cloud → Cluster Settings |
| `KAFKA_API_KEY` | Confluent Cloud → API Keys |
| `KAFKA_API_SECRET` | Confluent Cloud → API Keys |
| `JWT_SECRET` | Generate with: `openssl rand -base64 32` |
| `VITE_API_BASE_URL` | Railway gateway public URL |
