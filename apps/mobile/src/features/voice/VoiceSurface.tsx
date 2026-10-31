import { VoiceSettings } from "./VoiceSettings";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Modal, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { useVoice, voiceEnvironment } from "./VoiceProvider";

export function VoiceSurface() {
  const voice = useVoice();
  const { state, controller } = voice;
  const allowed = useAtomValue(
    voiceEnvironment.start.permissionAtom(state.target?.environmentId ?? null),
  );
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState(false);
  const active = ["live", "connecting", "finishing"].includes(state.phase);
  return (
    <>
      {!voice.open && active ? (
        <View className="absolute bottom-24 right-4">
          <Button
            label={`Voice · ${state.muted ? "muted" : state.phase}`}
            onPress={() => voice.setOpen(true)}
          />
        </View>
      ) : null}
      <Modal
        visible={voice.open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => voice.setOpen(false)}
      >
        <View
          className="flex-1 bg-screen"
          style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
        >
          <View className="flex-row items-center justify-between gap-3 border-b border-border px-5 py-3">
            <Text className="text-xl font-t3-bold">
              {state.mode === "dictation" ? "Dictate" : "Call"}
            </Text>
            <Button label="Minimize" tone="text" onPress={() => voice.setOpen(false)} />
          </View>
          <ScrollView
            contentContainerStyle={{ padding: 20, gap: 20 }}
            keyboardShouldPersistTaps="handled"
          >
            <Text>{state.target?.label}</Text>
            {state.target?.environmentLabel ? (
              <Text className="text-xs text-foreground-muted">{state.target.environmentLabel}</Text>
            ) : null}
            <Text accessibilityLiveRegion="polite">
              {state.phase === "live"
                ? state.muted
                  ? "Microphone muted"
                  : "Connected · microphone on"
                : state.phase === "connecting"
                  ? "Connecting microphone and speaker…"
                  : state.phase === "finishing"
                    ? "Finishing transcription…"
                    : "Voice ended"}
            </Text>
            {state.error ? <Text accessibilityRole="alert">{state.error}</Text> : null}
            {state.confirmation ? (
              <View className="gap-3">
                <Text>{state.confirmation.prompt}</Text>
                <View className="flex-row gap-2">
                  <Button label="Confirm" onPress={() => void controller.confirm(true)} />
                  <Button label="Cancel action" onPress={() => void controller.confirm(false)} />
                </View>
              </View>
            ) : null}
            <View className="gap-2">
              <Text className="font-t3-bold">You</Text>
              <Text selectable>{state.userText || "Your words will appear here."}</Text>
            </View>
            {state.mode === "call" ? (
              <View className="gap-2">
                <Text className="font-t3-bold">Assistant</Text>
                <Text selectable>
                  {state.assistantText || "Ask about your projects or threads."}
                </Text>
              </View>
            ) : null}
            {voice.draftMessage && state.mode === "dictation" ? (
              <Text>{voice.draftMessage}</Text>
            ) : null}
            {state.tools.map((tool) => (
              <View key={tool.callId} className="gap-1">
                <Text>
                  {tool.name.replace(/^t3_/, "").replaceAll("_", " ")} ·{" "}
                  {tool.status.replaceAll("_", " ")}
                </Text>
                <Text selectable numberOfLines={5} className="text-xs text-foreground-muted">
                  {tool.output}
                </Text>
              </View>
            ))}
            <Button
              label={settings ? "Hide voice settings" : "Voice settings"}
              tone="text"
              onPress={() => setSettings(!settings)}
            />
            {settings && state.target ? (
              <VoiceSettings environmentId={state.target.environmentId} />
            ) : null}
          </ScrollView>
          <View className="gap-3 border-t border-border p-4">
            <View className="flex-row flex-wrap gap-2">
              {active ? (
                <>
                  <Button
                    label={state.muted ? "Unmute" : "Mute"}
                    disabled={state.phase !== "live"}
                    onPress={() => controller.setMuted(!state.muted)}
                  />
                  {state.mode === "dictation" ? (
                    <Button
                      label="Use transcript"
                      disabled={state.phase !== "live"}
                      onPress={() => void voice.finishDictation()}
                    />
                  ) : null}
                  <Button
                    label={state.mode === "dictation" ? "Cancel" : "End"}
                    tone="danger"
                    onPress={() => void controller.end()}
                  />
                </>
              ) : state.target ? (
                <Button
                  label="Start call"
                  disabled={!allowed}
                  onPress={() => voice.startCall(state.target!)}
                />
              ) : null}
            </View>
            <Text className="text-xs text-foreground-muted">
              Ending voice leaves work already sent to agents running.
            </Text>
          </View>
        </View>
      </Modal>
    </>
  );
}
