import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type McpServerConfig,
  type ServerSettingsPatch,
  sharedMcpServerHarnessName,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { Pressable, TextInput as RNTextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import {
  describeMcpServerTest,
  mcpServerDraft,
  mcpSavedTokenKept,
  mcpServerHasToken,
  mcpServerHost,
  mcpServerTestInput,
  parseMcpServerDraft,
  removeMcpServerPatch,
  sortedMcpServers,
  upsertMcpServerPatch,
  type McpServerDraft,
} from "./mcp-servers";

const NO_SERVERS: Readonly<Record<string, McpServerConfig>> = {};

function useMcpServers(environmentId: EnvironmentId) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canManage = useAtomValue(serverEnvironment.testMcpServer.permissionAtom(environmentId));
  const servers: Readonly<Record<string, McpServerConfig>> =
    config?.settings.mcpServers ?? NO_SERVERS;
  return { loaded: config !== null, servers, canManage };
}

function useWriteMcpServers(environmentId: EnvironmentId) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "MCP server settings update",
    reportFailure: true,
  });
  return async (patch: ServerSettingsPatch) => {
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return false;
    const result = await updateSettings({ environmentId, input: { patch } });
    if (result._tag !== "Failure") return true;
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not save MCP server",
        error instanceof Error ? error.message : String(error),
      );
    }
    return false;
  };
}

export function SettingsMcpServersRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  const { environmentId } = route.params;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { loaded, servers, canManage } = useMcpServers(environmentId);
  const write = useWriteMcpServers(environmentId);
  const [toggling, setToggling] = useState<{ id: string; enabled: boolean } | null>(null);
  const entries = sortedMcpServers(servers);

  const setEnabled = async (id: string, config: McpServerConfig, enabled: boolean) => {
    if (toggling !== null) return;
    setToggling({ id, enabled });
    await write(upsertMcpServerPatch(id, { ...config, enabled }));
    setToggling(null);
  };

  return (
    <SettingsScreen title="MCP servers">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!loaded ? (
          <Text className="px-2 text-base text-foreground-muted">
            Connect this environment to manage its MCP servers.
          </Text>
        ) : (
          <>
            <SettingsSection
              title="Servers"
              footer="Every agent started in this environment gets the servers that are on. Turning one off stops its calls immediately. Agents pick up new servers in their next session."
            >
              {entries.length === 0 ? (
                <Text className="p-4 text-base text-foreground-muted">No MCP servers yet.</Text>
              ) : (
                entries.map(({ id, config }, index) => {
                  const name = config.label ?? id;
                  return (
                    <View
                      key={id}
                      className={
                        index === 0
                          ? "flex-row items-center gap-3 px-4 py-3"
                          : "flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
                      }
                    >
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${canManage ? "Edit" : "View"} ${name}`}
                        onPress={() =>
                          navigation.navigate("SettingsMcpServerEdit", {
                            environmentId,
                            serverId: id,
                          })
                        }
                        className="min-w-0 flex-1 gap-1 active:opacity-70"
                      >
                        <Text textRole="body" className="text-foreground" numberOfLines={1}>
                          {name}
                        </Text>
                        <Text
                          textRole="footnote"
                          className="text-foreground-muted"
                          numberOfLines={1}
                        >
                          {config.label ? `${id} · ` : ""}
                          {mcpServerHost(config.url)}
                        </Text>
                      </Pressable>
                      <ThemedSwitch
                        accessibilityLabel={`${name} enabled`}
                        disabled={!canManage || toggling !== null}
                        value={toggling?.id === id ? toggling.enabled : config.enabled}
                        onValueChange={(enabled) => void setEnabled(id, config, enabled)}
                      />
                    </View>
                  );
                })
              )}
              {canManage ? (
                <View className={entries.length > 0 ? "border-t border-border-subtle" : undefined}>
                  <ListActionRow
                    icon="plus"
                    label="Add MCP server"
                    onPress={() => navigation.navigate("SettingsMcpServerEdit", { environmentId })}
                  />
                </View>
              ) : null}
            </SettingsSection>
            {!canManage ? (
              <Text className="px-2 text-sm text-foreground-muted">
                This connection does not have permission to manage MCP servers.
              </Text>
            ) : null}
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function SettingsMcpServerEditRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId; readonly serverId?: string }>) {
  return (
    <McpServerEditor
      key={`${route.params.environmentId}:${route.params.serverId ?? ""}`}
      environmentId={route.params.environmentId}
      serverId={route.params.serverId ?? null}
    />
  );
}

function McpServerEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly serverId: string | null;
}) {
  const { environmentId, serverId } = props;
  const isNew = serverId === null;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { loaded, servers, canManage } = useMcpServers(environmentId);
  const saved = serverId === null ? undefined : servers[serverId];
  const write = useWriteMcpServers(environmentId);
  const testMcpServer = useAtomCommand(serverEnvironment.testMcpServer, {
    label: "MCP server test",
    reportFailure: false,
  });
  const [draft, setDraft] = useState(() => mcpServerDraft(serverId ?? "", saved));
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ReturnType<typeof describeMcpServerTest> | null>(null);
  const [pending, setPending] = useState<"save" | "test" | "remove" | null>(null);
  const readOnly = !canManage || pending !== null;
  const hasSavedToken = mcpServerHasToken(saved);

  const update = (patch: Partial<McpServerDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
    setTest(null);
  };

  const save = async () => {
    if (readOnly) return;
    const parsed = parseMcpServerDraft(draft, servers, isNew);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setPending("save");
    const ok = await write(upsertMcpServerPatch(parsed.value.id, parsed.value.config));
    setPending(null);
    if (ok) navigation.goBack();
  };

  const runTest = async () => {
    if (readOnly || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    const input = mcpServerTestInput(draft, servers, isNew);
    if (!input.ok) {
      setError(input.error);
      return;
    }
    setPending("test");
    setTest(null);
    const result = await testMcpServer({ environmentId, input: input.value });
    setPending(null);
    if (result._tag === "Success") {
      setTest(describeMcpServerTest(result.value));
    } else if (!isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      setTest({
        tone: "danger",
        message: cause instanceof Error ? cause.message : "Could not test the server.",
      });
    }
  };

  const confirmRemove = () => {
    if (readOnly || serverId === null) return;
    Dialog.alert(
      `Remove ${saved?.label ?? serverId}?`,
      "Agents lose access to its tools immediately.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () =>
            void (async () => {
              setPending("remove");
              const ok = await write(removeMcpServerPatch(serverId));
              setPending(null);
              if (ok) navigation.goBack();
            })(),
        },
      ],
    );
  };

  const urlChanged = saved !== undefined && draft.url.trim() !== saved.url;

  return (
    <SettingsScreen title={isNew ? "Add MCP server" : (saved?.label ?? serverId)}>
      <ScreenScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!loaded ? (
          <Text className="px-2 text-base text-foreground-muted">
            Connect this environment to manage its MCP servers.
          </Text>
        ) : !isNew && saved === undefined ? (
          <Text className="px-2 text-base text-foreground-muted">This server was removed.</Text>
        ) : (
          <>
            <SettingsSection
              title="Server"
              footer={
                isNew
                  ? "Agents see it with a “shared-” prefix. The name can't be changed later."
                  : `Agents see it as ${sharedMcpServerHarnessName(draft.id)}.`
              }
            >
              <FormField
                label="Name"
                value={draft.id}
                onChange={(id) => update({ id })}
                placeholder="executor"
                readOnly={readOnly || !isNew}
              />
              <FormField
                label="Label"
                value={draft.label}
                onChange={(label) => update({ label })}
                placeholder="Optional"
                readOnly={readOnly}
                borderTop
              />
              <FormField
                label="URL"
                value={draft.url}
                onChange={(url) => update({ url })}
                placeholder="https://example.com/mcp"
                keyboardType="url"
                readOnly={readOnly}
                borderTop
              />
            </SettingsSection>
            <SettingsSection
              title="Bearer token"
              footer={
                urlChanged && hasSavedToken && !draft.token.trim()
                  ? "The saved token never goes to a new URL, so saving removes it. Enter it again to keep using one."
                  : "Stays on this environment. Agents never see it."
              }
            >
              <FormField
                label="Token"
                value={draft.token}
                onChange={(token) => update({ token, clearToken: false })}
                placeholder={
                  mcpSavedTokenKept(draft, saved) ? "Saved. Type to replace." : "Optional"
                }
                readOnly={readOnly}
                secure
              />
              {canManage && hasSavedToken && !urlChanged ? (
                <View className="border-t border-border-subtle">
                  <ListActionRow
                    icon={draft.clearToken ? "arrow.uturn.backward" : "trash"}
                    tone={draft.clearToken ? "default" : "danger"}
                    label={draft.clearToken ? "Keep saved token" : "Remove saved token"}
                    description={
                      draft.clearToken ? "The saved token is removed when you save." : undefined
                    }
                    disabled={readOnly}
                    onPress={() => update({ token: "", clearToken: !draft.clearToken })}
                  />
                </View>
              ) : null}
            </SettingsSection>
            <SettingsSection>
              <SettingsSwitchRow
                icon="bolt.horizontal.circle"
                label="Enabled"
                subtitle="Turning a server off stops its calls immediately."
                value={draft.enabled}
                disabled={readOnly}
                onValueChange={(enabled) => update({ enabled })}
              />
            </SettingsSection>
            {canManage ? (
              <SettingsSection title="Connection">
                <ListActionRow
                  icon="checkmark.circle"
                  label="Test connection"
                  loading={pending === "test"}
                  disabled={readOnly}
                  onPress={() => void runTest()}
                />
                {test ? (
                  <View className="border-t border-border-subtle p-3">
                    <Notice message={test.message} tone={test.tone} />
                  </View>
                ) : null}
              </SettingsSection>
            ) : (
              <Text className="px-2 text-sm text-foreground-muted">
                This connection does not have permission to manage MCP servers.
              </Text>
            )}
            {error ? (
              <Text selectable className="px-2 text-sm text-danger-foreground">
                {error}
              </Text>
            ) : null}
            {canManage ? (
              <View className="gap-3">
                <Button
                  label={isNew ? "Add server" : "Save"}
                  tone="primary"
                  fullWidth
                  loading={pending === "save"}
                  disabled={readOnly}
                  onPress={() => void save()}
                />
                {!isNew ? (
                  <Button
                    label="Remove server"
                    tone="danger"
                    fullWidth
                    loading={pending === "remove"}
                    disabled={readOnly}
                    onPress={confirmRemove}
                  />
                ) : null}
              </View>
            ) : null}
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function FormField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly keyboardType?: "url";
  readonly secure?: boolean;
  readonly readOnly?: boolean;
  readonly borderTop?: boolean;
}) {
  return (
    <View
      className={
        props.borderTop ? "gap-2 border-t border-border-subtle px-4 py-3" : "gap-2 px-4 py-3"
      }
    >
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <RNTextInput
        accessibilityLabel={props.label}
        value={props.value}
        readOnly={props.readOnly}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        keyboardType={props.keyboardType}
        secureTextEntry={props.secure}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        textAlignVertical="center"
        placeholderTextColorClassName="accent-foreground-muted"
        className="min-h-8 font-sans text-base text-foreground"
      />
    </View>
  );
}
