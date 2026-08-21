#!/usr/bin/env node
import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./mcpServer.js";

async function runStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OSRS Companion MCP server running on stdio");
}

// Stateless Streamable HTTP: no session/auth handling here by design. In
// this mode the server is meant to sit behind a sidecar OAuth proxy (see
// docker-compose.yml) that terminates OAuth 2.1 + PKCE for MCP clients and
// only forwards requests from already-authorized callers. A fresh
// McpServer/transport pair per request keeps things simple and avoids
// needing sticky sessions across the proxy.
function runHttp() {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. This server is stateless and only supports POST." },
      id: null,
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. This server is stateless and only supports POST." },
      id: null,
    });
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).send("ok");
  });

  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, () => {
    console.error(`OSRS Companion MCP server listening on http://0.0.0.0:${port}/mcp`);
  });
}

async function main() {
  if (process.env.MCP_TRANSPORT === "http") {
    runHttp();
  } else {
    await runStdio();
  }
}

main().catch((error) => {
  console.error("Fatal error starting OSRS Companion MCP server:", error);
  process.exit(1);
});
