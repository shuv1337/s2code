import { createFileRoute } from "@tanstack/react-router";

import { McpServersSettingsPanel } from "../components/settings/McpServersSettings";

export const Route = createFileRoute("/_chat/settings/mcp-servers")({
  component: McpServersSettingsPanel,
});
