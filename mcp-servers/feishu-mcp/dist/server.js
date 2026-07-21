const fs = require("node:fs");
const path = require("node:path");

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    console.error(`[feishu-mcp-wrapper] Failed to read JSON: ${filePath}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const appFile = process.env.FEISHU_APP_CLIENT_JSON;
if (!appFile) {
  console.error("[feishu-mcp-wrapper] Missing env FEISHU_APP_CLIENT_JSON");
  process.exit(1);
}

const appConfig = readJson(appFile);
const appId = appConfig.app_id || appConfig.appId || appConfig.APP_ID;
const appSecret =
  appConfig.app_secret || appConfig.appSecret || appConfig.APP_SECRET;

if (!appId || !appSecret) {
  console.error(
    "[feishu-mcp-wrapper] App config must contain app_id and app_secret",
  );
  process.exit(1);
}

const toolsEnv = process.env.FEISHU_TOOLS || "";
const toolsList = toolsEnv
  ? toolsEnv.split(",").map((t) => t.trim()).filter(Boolean)
  : [];
const tokenMode = process.env.FEISHU_TOKEN_MODE || "auto";
const enableOAuth = process.env.FEISHU_OAUTH === "true";

// ---------- programmatic MCP server ----------

const { initOAPIMcpServer } = require("@larksuiteoapi/lark-mcp/dist/mcp-server");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

async function main() {
  // 1. Auth handler (for OAuth auto-refresh)
  let authHandler;
  if (enableOAuth) {
    const express = require("express");
    const { LarkAuthHandlerLocal } = require("@larksuiteoapi/lark-mcp/dist/auth");
    const app = express();
    app.use(express.json());
    authHandler = new LarkAuthHandlerLocal(app, {
      appId,
      appSecret,
      oauth: true,
      domain: "https://open.feishu.cn",
      host: "localhost",
      port: "3000",
    });
    authHandler.setupRoutes();
  }

  // 2. Build userAccessToken value (mimic initStdioServer logic)
  const { authStore } = require("@larksuiteoapi/lark-mcp/dist/auth");
  const userAccessTokenValue = appId
    ? { getter: async () => await authStore.getLocalAccessToken(appId) }
    : undefined;

  // 3. Create MCP server + register official tools
  const { mcpServer, larkClient } = initOAPIMcpServer(
    {
      appId,
      appSecret,
      tools: toolsList,
      tokenMode,
      oauth: enableOAuth,
      language: "en",
      toolNameCase: "snake",
      userAccessToken: userAccessTokenValue,
    },
    authHandler,
  );

  // 4. Register custom tool: read spreadsheet cell values (v2 API)
  mcpServer.tool(
    "sheets_v2_spreadsheetSheetValues_read",
    "[Feishu/Lark]-Docs-Sheets-Data-Read a single range of cells from a spreadsheet. Returns the cell values as a 2D array.",
    {
      spreadsheetToken: z.string().describe("Spreadsheet token"),
      range: z.string().describe("Range in format sheetId!A1:Z100"),
      valueRenderOption: z
        .enum(["ToString", "Formula", "FormattedValue", "UnformattedValue"])
        .optional()
        .describe("How values should be rendered. Default: ToString"),
      dateTimeRenderOption: z
        .enum(["FormattedString"])
        .optional()
        .describe("How dates should be rendered"),
      useUAT: z
        .boolean()
        .optional()
        .describe("Use user access token (default true)"),
    },
    async (params) => {
      try {
        const { userAccessToken } = await larkClient.ensureGetUserAccessToken();
        if (!userAccessToken) {
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ error: "No valid user access token" }) }],
          };
        }

        const query = new URLSearchParams();
        if (params.valueRenderOption) query.set("valueRenderOption", params.valueRenderOption);
        if (params.dateTimeRenderOption) query.set("dateTimeRenderOption", params.dateTimeRenderOption);
        const qs = query.toString() ? `?${query.toString()}` : "";

        const url = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${params.spreadsheetToken}/values/${params.range}${qs}`;

        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${userAccessToken}` },
        });
        const data = await resp.json();

        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
        };
      }
    },
  );

  // 5. Connect stdio transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((err) => {
  console.error("[feishu-mcp-wrapper] Fatal:", err);
  process.exit(1);
});
