import http from "node:http";
import { URL } from "node:url";
import type Redis from "ioredis";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { isTokenBlacklisted, verifyAccessToken } from "@ordersystem/shared";
import type { GatewayEnv } from "./env";

type SocketMap = Map<string, Set<WebSocket>>;

function addSocket(store: SocketMap, userId: string, socket: WebSocket) {
  const current = store.get(userId) ?? new Set<WebSocket>();
  current.add(socket);
  store.set(userId, current);
}

function removeSocket(store: SocketMap, userId: string, socket: WebSocket) {
  const current = store.get(userId);
  if (!current) {
    return;
  }

  current.delete(socket);
  if (current.size === 0) {
    store.delete(userId);
  }
}

export function createSocketHub(server: http.Server, redis: Redis, env: GatewayEnv, logger: Logger) {
  const socketsByUser = new Map<string, Set<WebSocket>>();
  const subscriber = redis.duplicate();
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (request, socket, head) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (!["/ws", "/ws/"].includes(requestUrl.pathname)) {
        logger.warn({ pathname: requestUrl.pathname }, "Rejected websocket upgrade due to unexpected path");
        socket.destroy();
        return;
      }

      const headerToken = request.headers.authorization?.startsWith("Bearer ")
        ? request.headers.authorization.slice("Bearer ".length)
        : null;
      const queryToken = requestUrl.searchParams.get("token");
      const token = headerToken ?? queryToken;

      if (!token) {
        logger.warn("Rejected websocket upgrade due to missing access token");
        socket.destroy();
        return;
      }

      const payload = verifyAccessToken(token, env.ACCESS_TOKEN_SECRET);
      const blacklisted = await isTokenBlacklisted(redis, payload.jti);
      if (blacklisted) {
        logger.warn({ userId: payload.sub, jti: payload.jti }, "Rejected websocket upgrade for blacklisted token");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("error", (error) => {
          logger.warn({ error, userId: payload.sub }, "Websocket connection error");
        });
        ws.on("close", () => removeSocket(socketsByUser, payload.sub, ws));
        addSocket(socketsByUser, payload.sub, ws);
        logger.info({ userId: payload.sub }, "Websocket connection established");
        ws.send(
          JSON.stringify({
            event: "socket.connected",
            data: {
              userId: payload.sub
            }
          })
        );
      });
    } catch (error) {
      logger.warn({ error }, "Rejected websocket upgrade");
      socket.destroy();
    }
  });

  void subscriber.subscribe(env.SOCKET_EVENTS_CHANNEL).catch((error) => {
    logger.error({ error, channel: env.SOCKET_EVENTS_CHANNEL }, "Failed to subscribe redis websocket channel");
  });
  subscriber.on("message", (_channel: string, rawMessage: string) => {
    try {
      const message = JSON.parse(rawMessage) as {
        userId: string;
        event: string;
        data: unknown;
      };

      const sockets = socketsByUser.get(message.userId);
      if (!sockets) {
        return;
      }

      const payload = JSON.stringify({
        event: message.event,
        data: message.data
      });

      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payload);
        }
      }
    } catch (error) {
      logger.warn({ error }, "Failed to fan out socket message");
    }
  });

  return {
    close: async () => {
      await subscriber.quit();
      wss.close();
    }
  };
}
