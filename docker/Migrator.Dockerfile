FROM node:24-alpine
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY prisma ./prisma
COPY packages ./packages
COPY services ./services

RUN pnpm install --no-frozen-lockfile

CMD ["sh", "-c", "pnpm prisma:generate && pnpm prisma db push"]
