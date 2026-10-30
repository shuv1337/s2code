import { useEnvironment } from "../state/environments";
import { useAtomValue } from "@effect/atom-react";
import type { VoiceTarget } from "@t3tools/client-runtime/voice/controller";
import { MicIcon, PhoneIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { useVoice, voiceEnvironment } from "./VoiceProvider";

export function VoiceControls({
  target,
  commitDictation,
}: {
  target: VoiceTarget;
  commitDictation: () => (text: string) => boolean;
}) {
  const voice = useVoice();
  const environment = useEnvironment(target.environmentId);
  const callTarget = { ...target, environmentLabel: environment?.label ?? "Current environment" };
  const allowed = useAtomValue(voiceEnvironment.start.permissionAtom(target.environmentId));
  const active = ["connecting", "live", "finishing"].includes(voice.state.phase);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={!allowed}
        aria-label="Dictate into draft"
        title="Dictate into draft"
        onClick={() => voice.startDictation(callTarget, commitDictation())}
      >
        <MicIcon className="size-4" />
      </Button>
      <Button
        type="button"
        size="xs"
        variant={active ? "secondary" : "ghost"}
        disabled={!allowed}
        onClick={() => {
          voice.setOpen(true);
          if (!active) void voice.controller.start(callTarget);
        }}
      >
        <PhoneIcon className="size-4" />
        {active ? "Voice" : "Call"}
      </Button>
    </div>
  );
}
