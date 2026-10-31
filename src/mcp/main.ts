#!/usr/bin/env node
/** Standalone MCP entry point (same server as `fritzkit mcp`). */
import { startStdioServer } from "./server.js";

await startStdioServer({ env: process.env });
