import { useGT } from "gt-react";
import { useEnvironment } from "../state/environments";
import { useAtomValue } from "@effect/atom-react";
import type { VoiceTarget } from "@t3tools/client-runtime/voice/controller";
import { MicIcon, PhoneIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { useEnvironmentQuery } from "../state/query";
import { useVoice, voiceEnvironment } from "./VoiceProvider";

export function VoiceControls({
  target,
  commitDictation,
}: {
  target: VoiceTarget;
  commitDictation: () => (text: string) => boolean;
}) {
  const gt = useGT();
  const voice = useVoice();
  const environment = useEnvironment(target.environmentId);
  const callTarget = {
    ...target,
    environmentLabel: environment?.label ?? gt("Current environment"),
  };
  const allowed = useAtomValue(voiceEnvironment.start.permissionAtom(target.environmentId));
  const configured = useEnvironmentQuery(
    voiceEnvironment.status({ environmentId: target.environmentId, input: {} }),
  ).data?.configured;
  const active = ["connecting", "live", "finishing"].includes(voice.state.phase);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={!allowed}
        aria-label={gt("Dictate into draft")}
        title={gt("Dictate into draft")}
        onClick={() => voice.startDictation(callTarget, commitDictation())}
      >
        <MicIcon className="size-4" />
      </Button>
      {configured || active ? (
        <Button
          type="button"
          size="xs"
          variant={active ? "secondary" : "ghost"}
          disabled={!allowed}
          aria-label={active ? gt("Open voice call") : gt("Start voice call")}
          title={active ? gt("Open voice call") : gt("Start voice call")}
          onClick={() => {
            voice.setOpen(true);
            if (!active) void voice.controller.start(callTarget);
          }}
        >
          <PhoneIcon className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}
