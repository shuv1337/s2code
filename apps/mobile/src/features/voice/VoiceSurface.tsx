import { useGT } from "gt-react-native";
import { VoiceSettings } from "./VoiceSettings";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Modal, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { useVoice, voiceEnvironment } from "./VoiceProvider";

export function VoiceSurface() {
  const gt = useGT();
  const voice = useVoice();
  const { state, controller } = voice;
  const allowed = useAtomValue(
    voiceEnvironment.start.permissionAtom(state.target?.environmentId ?? null),
  );
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const active = ["live", "connecting", "finishing"].includes(state.phase);
  return (
    <>
      {!voice.open && active ? (
        <View className="absolute bottom-24 right-4">
          <Button
            label={gt("Voice · {status}", {
              status: state.muted
                ? gt("Muted")
                : state.phase === "live"
                  ? gt("Live")
                  : state.phase === "finishing"
                    ? gt("Finishing transcription…")
                    : gt("Connecting"),
            })}
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
              {state.mode === "dictation" ? gt("Dictate") : gt("Call")}
            </Text>
            <Button label={gt("Minimize")} tone="text" onPress={() => voice.setOpen(false)} />
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
                  ? gt("Microphone muted")
                  : gt("Connected · microphone on")
                : state.phase === "connecting"
                  ? gt("Connecting microphone and speaker…")
                  : state.phase === "finishing"
                    ? gt("Finishing transcription…")
                    : gt("Voice ended")}
            </Text>
            {state.error ? <Text accessibilityRole="alert">{state.error}</Text> : null}
            {state.confirmation ? (
              <View className="gap-3">
                <Text>{state.confirmation.prompt}</Text>
                <View className="flex-row gap-2">
                  <Button label={gt("Confirm")} onPress={() => void controller.confirm(true)} />
                  <Button
                    label={gt("Cancel action")}
                    onPress={() => void controller.confirm(false)}
                  />
                </View>
              </View>
            ) : null}
            <View className="gap-2">
              <Text className="font-t3-bold">{gt("You")}</Text>
              <Text selectable>{state.userText || gt("Your words will appear here.")}</Text>
            </View>
            {state.mode === "call" ? (
              <View className="gap-2">
                <Text className="font-t3-bold">{gt("Assistant")}</Text>
                <Text selectable>
                  {state.assistantText || gt("Ask about your projects or threads.")}
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
            {state.events.length ? (
              <View className="gap-1">
                <Button
                  label={
                    eventsOpen
                      ? gt("Hide events")
                      : gt("Events ({count})", { count: state.events.length })
                  }
                  tone="text"
                  onPress={() => setEventsOpen(!eventsOpen)}
                />
                {eventsOpen
                  ? state.events.map((entry) => (
                      <Text key={entry.id} selectable className="text-xs text-foreground-muted">
                        +{entry.seconds.toFixed(1)}s {entry.type}
                        {entry.detail ? `: ${entry.detail}` : ""}
                      </Text>
                    ))
                  : null}
              </View>
            ) : null}
            <Button
              label={settings ? gt("Hide voice settings") : gt("Voice settings")}
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
                    label={state.muted ? gt("Unmute") : gt("Mute")}
                    disabled={state.phase !== "live"}
                    onPress={() => controller.setMuted(!state.muted)}
                  />
                  {state.mode === "dictation" ? (
                    <Button
                      label={gt("Use transcript")}
                      disabled={state.phase !== "live"}
                      onPress={() => void voice.finishDictation()}
                    />
                  ) : null}
                  <Button
                    label={
                      state.mode === "dictation"
                        ? gt("Cancel")
                        : gt("End", { $context: "verb, ends a voice call" })
                    }
                    tone="danger"
                    onPress={() => void controller.end()}
                  />
                </>
              ) : state.target ? (
                <Button
                  label={gt("Start call")}
                  disabled={!allowed}
                  onPress={() => voice.startCall(state.target!)}
                />
              ) : null}
            </View>
            <Text className="text-xs text-foreground-muted">
              {gt("Ending voice leaves work already sent to agents running.")}
            </Text>
          </View>
        </View>
      </Modal>
    </>
  );
}
