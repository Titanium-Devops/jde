#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJdeServer } from "./create.ts";

/**
 * The `jde-mcp` command: JDE's tools over stdio, for an MCP client to spawn.
 *
 * stdout belongs to the protocol, so anything this process has to say goes to stderr.
 */
const server = createJdeServer();
await server.connect(new StdioServerTransport());
process.stderr.write("jde-mcp: ready on stdio\n");
