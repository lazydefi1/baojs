import type { ServerWebSocket } from "bun";
import type { IHandler, IWebSocketData, IWebSocketHandlers } from "./bao";
import { Context, WebSocketContext } from "./context";
import { Middleware } from "./middleware";
import { BaoRouter } from "./router/router";

export class Router {
  #router = new BaoRouter();

  /**
   * The middleware used by this router
   */
  middleware = new Middleware();

  /**
   * Register a route with the router
   *
   * @param method The HTTP method
   * @param path The path of the route
   * @param handler The path handler function
   */
  register(method: TMethods, path: string, handler: IHandler): void {
    if (method == "ANY") {
      this.#router.any(path, handler);
    } else {
      this.#router.on(method, path, handler);
      // To avoid having to define an OPTIONS route manually for every GET, POST, DELETE, etc. request, we add it here
      this.#router.on("OPTIONS", path, ctx => ctx.sendText("ok"));
    }
  }

  /**
   * Register a WebSocket route with the router
   *
   * @param path The path of the WebSocket
   * @param handlers The WebSocket path handler function
   */
  registerWebSocket(path: string, handlers: IWebSocketHandlers) {
    // WebSocket handler function
    this.#router.ws(path, handlers);

    // Upgrade connection to WebSocket
    this.#router.on("GET", path, async (ctx) => {
      const wsCtx = new WebSocketContext(ctx);
      const data: IWebSocketData = {
        ctx: wsCtx,
      };

      // Run the optional before upgrade middleware
      if (handlers.upgrade != null)
        ctx = await Promise.resolve(handlers.upgrade(ctx));
      if (!ctx.isLocked()) {
        // Check the Upgrade header
        if (ctx.headers.get("upgrade").toLowerCase() != "websocket")
          return ctx
            .sendText("Upgrade header is invalid", { status: 400 })
            .forceSend();

        // Upgrade the HTTP connection to a WebSocket connection
        if (ctx.server.upgrade(ctx.req, { data }) === false)
          throw new Error(`Unable to upgrade request on path "${ctx.path}"`);
      }

      return ctx;
    });
  }

  /**
   * Handles WebSocket connections
   *
   * @param ws The WebSocket instance itself
   * @returns Methods to handle stages of the WebSocket lifecycle
   */
  handleWebSocket(ws: ServerWebSocket<IWebSocketData>) {
    const path = ws.data.ctx.path;
    const route = this.#router.find("WS", path);
    const handlers = route.handler as IWebSocketHandlers;

    return {
      open: () =>
        handlers.open != null ? Promise.resolve(handlers.open(ws)) : void null,
      close: () =>
        handlers.close != null
          ? Promise.resolve(handlers.close(ws))
          : void null,
      message: (msg: string | Uint8Array) =>
        handlers.message != null
          ? Promise.resolve(handlers.message(ws, msg))
          : void null,
    };
  }

  /**
   * Handles an incoming request
   *
   * @param ctx The Context object created by the request
   * @returns The Response generated by the path handler and middleware
   */
  async handle(ctx: Context): Promise<Response> {
    let method = ctx.method;
    if (method == "HEAD") method = "GET";
    if (method == "WS")
      throw new Error("WebSocket method called on HTTP route handler");

    const route = this.#router.find(method, ctx.path);

    // If route not found, send an empty 404
    if (route.handler == null) return new Response(null, { status: 404 });

    // Assign the route parameters
    ctx.params = route.params;

    // Run the Context through the middleware and route
    ctx = await this.middleware.before(ctx);
    const handler = route.handler as IHandler;
    if (!ctx.isLocked()) ctx = await Promise.resolve(handler(ctx));
    if (!ctx.isLocked()) ctx = await this.middleware.after(ctx);

    // Handle a HEAD request
    if (ctx.method == "HEAD") {
      ctx.res = new Response("", {
        status: (ctx.res as Response).status,
        statusText: (ctx.res as Response).statusText,
        headers: (ctx.res as Response).headers,
      });
    }

    return ctx.res;
  }
}

export type TMethods =
  | "ANY"
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "DELETE"
  | "CONNECT"
  | "OPTIONS"
  | "TRACE"
  | "PATCH";
