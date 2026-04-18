FROM node:24-alpine AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY prisma ./prisma
COPY packages ./packages
COPY services ./services

RUN pnpm install --no-frozen-lockfile
RUN pnpm prisma:generate

ARG SERVICE_PATH
ENV SERVICE_PATH=$SERVICE_PATH
RUN pnpm --filter @ordersystem/shared build
RUN pnpm --filter "./${SERVICE_PATH}" build

CMD ["sh", "-c", "pnpm --filter ./${SERVICE_PATH} start"]
