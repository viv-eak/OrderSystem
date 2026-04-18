FROM node:24-alpine
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY services/frontend ./services/frontend

RUN pnpm install --no-frozen-lockfile

ARG VITE_API_BASE_URL=http://localhost:4000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN pnpm --filter @ordersystem/frontend build

CMD ["sh", "-c", "pnpm --filter @ordersystem/frontend preview"]
