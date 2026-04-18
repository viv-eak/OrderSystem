import type { Request, Response } from "express";

export async function proxyJsonRequest(
  req: Request,
  res: Response,
  baseUrl: string,
  extraHeaders: Record<string, string> = {}
) {
  const targetUrl = new URL(req.originalUrl, `${baseUrl.replace(/\/$/, "")}/`);
  const method = req.method.toUpperCase();
  const hasBody = !["GET", "HEAD"].includes(method);
  const upstream = await fetch(targetUrl, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: req.headers.authorization ?? "",
      "x-correlation-id": String(req.headers["x-correlation-id"] ?? ""),
      ...extraHeaders
    },
    body: hasBody ? JSON.stringify(req.body ?? {}) : undefined
  });

  const text = await upstream.text();
  const contentType = upstream.headers.get("content-type");
  if (contentType) {
    res.setHeader("content-type", contentType);
  }

  res.status(upstream.status).send(text);
}
