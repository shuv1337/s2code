import { useAtomValue } from "@effect/atom-react";
import {
  sharedMcpServerHarnessName,
  type McpServerConfig,
  type McpServerId,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { McpServerDialog } from "./McpServerDialog";
import { McpServerTestStatus, type McpServerTestState } from "./McpServerTestStatus";
import { mcpServerHost } from "./McpServersSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function McpServersSettingsPanel() {
  const { scope, environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.sharedMcpServers !== true ? (
        <SettingsSection {...searchableSetting("mcp-servers")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Update S2Code on {environment.label} to add MCP servers for its agents.
          </p>
        </SettingsSection>
      ) : environment?.connection.phase === "connected" ? (
        <EnvironmentMcpServers
          key={environment.environmentId}
          environment={environment}
          projectScoped={scope.kind === "project" || scope.kind === "checkout"}
        />
      ) : (
        <SettingsSection {...searchableSetting("mcp-servers")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect an environment to manage the MCP servers its agents can use.
          </p>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentMcpServers({
  environment,
  projectScoped,
}: {
  readonly environment: EnvironmentPresentation;
  readonly projectScoped: boolean;
}) {
  const environmentId = environment.environmentId;
  const canManage = useAtomValue(serverEnvironment.testMcpServer.permissionAtom(environmentId));
  const readOnly = !canManage || projectScoped;
  const servers = useEnvironmentSettings(environmentId, (settings) => settings.mcpServers);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const testMcpServer = useAtomCommand(serverEnvironment.testMcpServer, { reportFailure: false });
  const [dialog, setDialog] = useState<
    null | { readonly mode: "add" } | { readonly mode: "edit"; readonly id: McpServerId }
  >(null);
  const [tests, setTests] = useState<Partial<Record<string, McpServerTestState>>>({});
  const entries = Object.entries(servers) as Array<[McpServerId, McpServerConfig]>;
  const editingConfig = dialog?.mode === "edit" ? servers[dialog.id] : undefined;
  const editing =
    dialog?.mode === "edit" && editingConfig !== undefined
      ? { id: dialog.id, config: editingConfig }
      : undefined;

  const runTest = async (id: McpServerId, url: string) => {
    const key = JSON.stringify({ id, url });
    setTests((previous) => ({ ...previous, [id]: { key, result: null } }));
    const response = await testMcpServer({ environmentId, input: { id, url } });
    setTests((previous) =>
      previous[id]?.key === key && previous[id].result === null
        ? {
            ...previous,
            [id]: {
              key,
              result:
                response._tag === "Success"
                  ? response.value
                  : { _tag: "Failed", message: "The test could not run. Try reconnecting." },
            },
          }
        : previous,
    );
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("mcp-servers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setDialog({ mode: "add" })}>
              <PlusIcon className="size-3" aria-hidden />
              Add server
            </Button>
          ) : null
        }
      >
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          Remote MCP servers that agents in Full access threads on this environment can use. Tokens
          stay on this environment.
          {projectScoped
            ? " Environment-wide setting. Select an environment to change it."
            : !canManage
              ? ` This connection lacks permission to manage MCP servers on ${environment.label}.`
              : ""}
        </p>
        {entries.length === 0 ? (
          <SettingsRow title="No MCP servers configured." />
        ) : (
          entries.map(([id, config]) => {
            const name = config.label ?? id;
            const test = tests[id];
            const currentTest = test?.key === JSON.stringify({ id, url: config.url }) ? test : null;
            return (
              <SettingsRow
                key={id}
                title={<span className="min-w-0 wrap-anywhere">{name}</span>}
                description={
                  <span className="grid gap-1">
                    <span className="wrap-anywhere">
                      Agents see <code className="font-mono">{sharedMcpServerHarnessName(id)}</code>{" "}
                      · {mcpServerHost(config.url)}
                    </span>
                    {currentTest ? <McpServerTestStatus test={currentTest} /> : null}
                  </span>
                }
                control={
                  <div className="flex items-center gap-1">
                    {!readOnly ? (
                      <>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={currentTest?.result === null}
                          onClick={() => void runTest(id, config.url)}
                        >
                          Test
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setDialog({ mode: "edit", id })}
                        >
                          Edit
                        </Button>
                        <RemoveMcpServerButton
                          name={name}
                          environmentLabel={environment.label}
                          onConfirm={() => updateSettings({ mcpServers: { [id]: null } })}
                        />
                      </>
                    ) : null}
                    <Switch
                      aria-label={`Enable ${name}`}
                      checked={config.enabled}
                      disabled={readOnly}
                      onCheckedChange={(enabled) =>
                        updateSettings({ mcpServers: { [id]: { ...config, enabled } } })
                      }
                    />
                  </div>
                }
              />
            );
          })
        )}
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Turning a server off or removing it stops its calls right away. Agents pick up new servers
          and tool changes when their next session starts.
        </p>
      </SettingsSection>
      {dialog !== null && !readOnly && (dialog.mode === "add" || editing !== undefined) ? (
        <McpServerDialog
          onClose={() => setDialog(null)}
          environmentId={environmentId}
          environmentLabel={environment.label}
          existingIds={new Set(Object.keys(servers))}
          {...(editing === undefined ? {} : { existing: editing })}
        />
      ) : null}
    </>
  );
}

function RemoveMcpServerButton({
  name,
  environmentLabel,
  onConfirm,
}: {
  readonly name: string;
  readonly environmentLabel: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents on {environmentLabel} stop reaching its tools right away, and its token is
              deleted from that environment. The server itself is untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Remove server
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
