import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
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
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Two-way calls use GPT-Live. Dictation adds text to your draft. Audio is sent to OpenAI and
        billed to your API account.
      </p>
      <p className="text-sm">
        {status.data?.configured
          ? "An OpenAI key is configured on this environment."
          : "Add an OpenAI key with GPT-Live access to this environment."}
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save(key);
        }}
      >
        <label className="block space-y-2">
          <span className="text-sm font-medium">OpenAI API key</span>
          <Input
            type="password"
            autoComplete="off"
            value={key}
            disabled={!allowed || busy}
            placeholder={status.data?.configured ? "Replace saved key" : "Enter your API key"}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={!allowed || busy || !key.trim()}>
            Save key
          </Button>
          {status.data?.configured ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!allowed || busy}
              onClick={() => void save("")}
            >
              Remove saved key
            </Button>
          ) : null}
        </div>
      </form>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {!allowed ? (
        <p className="text-sm text-muted-foreground">
          Ask an environment administrator to configure voice.
        </p>
      ) : null}
    </div>
  );
}
