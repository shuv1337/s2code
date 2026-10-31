import { createFileRoute } from "@tanstack/react-router";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { VoiceSettings } from "../voice/VoiceSettings";
export const Route = createFileRoute("/_chat/settings/voice")({ component: VoiceSettingsPanel });
function VoiceSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection title="Voice">
        {environment ? (
          <VoiceSettings environmentId={environment.environmentId} />
        ) : (
          <p>Select a connected environment to configure voice.</p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
