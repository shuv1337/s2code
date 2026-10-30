import { MicIcon, MicOffIcon, PhoneOffIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Button } from "../components/ui/button";
import { useVoice, voiceEnvironment } from "./VoiceProvider";
import { VoiceSettings } from "./VoiceSettings";

export function VoiceSurface() {
  const voice = useVoice();
  const { state, controller } = voice;
  const allowed = useAtomValue(
    voiceEnvironment.start.permissionAtom(state.target?.environmentId ?? null),
  );
  const [settings, setSettings] = useState(false);
  const active = ["connecting", "live", "finishing"].includes(state.phase);
  if (!voice.open)
    return active ? (
      <div className="fixed bottom-4 right-4 z-40">
        <Button size="sm" variant="secondary" onClick={() => voice.setOpen(true)}>
          Voice · {state.muted ? "Muted" : state.phase === "live" ? "Live" : "Connecting"}
        </Button>
      </div>
    ) : null;
  return (
    <aside
      aria-label="Voice call"
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l bg-background shadow-lg max-sm:top-auto max-sm:max-h-[85dvh] max-sm:max-w-none max-sm:rounded-t-xl max-sm:border-t"
    >
      <header className="flex items-start justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="text-base font-semibold">
            {state.mode === "dictation" ? "Dictate" : "Call"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.target?.label ?? "Voice"}</p>
          {state.target?.environmentLabel ? (
            <p className="text-xs text-muted-foreground">{state.target.environmentLabel}</p>
          ) : null}
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Minimize voice panel"
          onClick={() => voice.setOpen(false)}
        >
          <XIcon className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        <p role="status" className="text-sm font-medium">
          {state.phase === "live"
            ? state.muted
              ? "Microphone muted"
              : state.mode === "dictation"
                ? "Listening · draft only"
                : "Connected · microphone on"
            : state.phase === "connecting"
              ? "Connecting microphone and speaker…"
              : state.phase === "finishing"
                ? "Finishing transcription…"
                : state.phase === "error"
                  ? "Could not continue"
                  : "Voice ended"}
        </p>
        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
        {voice.draftMessage && state.mode === "dictation" ? (
          <p role="status" className="text-sm">
            {voice.draftMessage}
          </p>
        ) : null}
        {state.confirmation ? (
          <section className="space-y-3 rounded-lg border p-3">
            <h3 className="text-sm font-medium">Confirm action</h3>
            <p className="break-words text-sm">{state.confirmation.prompt}</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void controller.confirm(true)}>
                Confirm
              </Button>
              <Button size="sm" variant="outline" onClick={() => void controller.confirm(false)}>
                Cancel action
              </Button>
            </div>
          </section>
        ) : null}
        <section className="space-y-2">
          <h3 className="text-sm font-medium">You</h3>
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {state.userText || "Your words will appear here."}
          </p>
        </section>
        {state.mode === "call" ? (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Assistant</h3>
            <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {state.assistantText || "Ask about your projects or threads."}
            </p>
          </section>
        ) : null}
        {state.tools.length ? (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Activity</h3>
            {state.tools.map((tool) => (
              <details key={tool.callId} className="text-sm">
                <summary className="cursor-pointer break-words">
                  {tool.name.replace(/^t3_/, "").replaceAll("_", " ")} ·{" "}
                  {tool.status.replaceAll("_", " ")}
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {tool.output}
                </pre>
              </details>
            ))}
          </section>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setSettings(!settings)}>
          {settings ? "Hide voice settings" : "Voice settings"}
        </Button>
        {settings && state.target ? (
          <VoiceSettings environmentId={state.target.environmentId} />
        ) : null}
      </div>
      <footer className="space-y-3 border-t p-4">
        <div className="flex flex-wrap gap-2">
          {active ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={state.phase !== "live"}
                onClick={() => controller.setMuted(!state.muted)}
              >
                {state.muted ? <MicOffIcon className="size-4" /> : <MicIcon className="size-4" />}
                {state.muted ? "Unmute" : "Mute"}
              </Button>
              {state.mode === "dictation" ? (
                <Button
                  size="sm"
                  disabled={state.phase !== "live"}
                  onClick={() => void voice.finishDictation()}
                >
                  Use transcript
                </Button>
              ) : null}
              <Button size="sm" variant="destructive" onClick={() => void controller.end()}>
                <PhoneOffIcon className="size-4" />
                {state.mode === "dictation" ? "Cancel" : "End"}
              </Button>
            </>
          ) : state.target ? (
            <Button
              size="sm"
              disabled={!allowed}
              onClick={() => void controller.start(state.target!, "call")}
            >
              Start call
            </Button>
          ) : null}
        </div>
        {state.mode === "call" ? (
          <p className="text-xs text-muted-foreground">
            Ending voice leaves work already sent to agents running.
          </p>
        ) : null}
      </footer>
    </aside>
  );
}
