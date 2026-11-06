import { createFileRoute } from "@tanstack/react-router";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { VoiceSettings } from "../voice/VoiceSettings";
export const Route = createFileRoute("/_chat/settings/voice-calls")({
  component: VoiceCallSettingsPanel,
});
function VoiceCallSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection title="Voice calls">
        {environment ? (
          <VoiceSettings environmentId={environment.environmentId} />
        ) : (
          <p>Select a connected environment to configure voice calls.</p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
