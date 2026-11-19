import { useGT } from "gt-react";
import { createFileRoute } from "@tanstack/react-router";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { VoiceSettings } from "../voice/VoiceSettings";
export const Route = createFileRoute("/_chat/settings/voice-calls")({
  component: VoiceCallSettingsPanel,
});
function VoiceCallSettingsPanel() {
  const gt = useGT();
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection title={gt("Voice calls")}>
        {environment ? (
          <VoiceSettings environmentId={environment.environmentId} />
        ) : (
          <p>{gt("Select a connected environment to configure voice calls.")}</p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
