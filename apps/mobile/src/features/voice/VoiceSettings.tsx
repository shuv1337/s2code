import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext, useState } from "react";
import { TextInput, View } from "react-native";
import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { voiceEnvironment } from "./VoiceProvider";

export function VoiceSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const query = voiceEnvironment.status({ environmentId, input: {} });
  const status = useEnvironmentQuery(query);
  const allowed = useAtomValue(voiceEnvironment.configure.permissionAtom(environmentId));
  const configure = useAtomCommand(voiceEnvironment.configure, { reportFailure: false });
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (apiKey: string) => {
    setBusy(true);
    setMessage(null);
    const result = await configure({ environmentId, input: { apiKey } });
    setBusy(false);
    if (result._tag === "Success") {
      setKey("");
      registry.refresh(query);
      setMessage(
        apiKey
          ? "Key saved. You can start a call."
          : "Saved key removed. A server environment key, if set, still applies.",
      );
    } else setMessage("Could not save the key. Check your connection and permissions.");
  };
  return (
    <View className="gap-3 p-4">
      <Text>
        Audio is sent to OpenAI and billed to your API account. Dictation adds text to your draft
        without sending it.
      </Text>
      <Text>
        {status.data?.configured
          ? "An OpenAI key is configured."
          : "Add an OpenAI key with GPT-Live access."}
      </Text>
      <TextInput
        accessibilityLabel="OpenAI API key"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        value={key}
        onChangeText={setKey}
        placeholder="OpenAI API key"
        editable={allowed && !busy}
        className="rounded-lg border border-border p-3 text-foreground"
      />
      <Button
        label="Save key"
        disabled={!allowed || busy || !key.trim()}
        onPress={() => void save(key)}
      />
      {status.data?.configured ? (
        <Button
          label="Remove saved key"
          disabled={!allowed || busy}
          onPress={() => void save("")}
        />
      ) : null}
      {message ? <Text accessibilityLiveRegion="polite">{message}</Text> : null}
      {!allowed ? <Text>Ask an environment administrator to configure voice.</Text> : null}
    </View>
  );
}
