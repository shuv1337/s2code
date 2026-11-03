import {
  sharedMcpServerHarnessName,
  type EnvironmentId,
  type McpServerConfig,
  type McpServerId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { McpServerTestStatus, type McpServerTestState } from "./McpServerTestStatus";
import {
  draftFromMcpServer,
  mcpServerFromDraft,
  mcpServerTestInputFromDraft,
  newMcpServerDraft,
  nextMcpServerToken,
  savedTokenDropped,
  type McpServerDraft,
  type McpServerTarget,
} from "./McpServersSettings.logic";
import { SecretInput } from "./SecretInput";

/** Mounted per open, so each open starts from a fresh draft. */
export function McpServerDialog({
  onClose,
  environmentId,
  environmentLabel,
  existingIds,
  existing,
}: {
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly existingIds: ReadonlySet<string>;
  readonly existing?: { readonly id: McpServerId; readonly config: McpServerConfig };
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const testMcpServer = useAtomCommand(serverEnvironment.testMcpServer, { reportFailure: false });
  const target: McpServerTarget = existing
    ? { mode: "edit", id: existing.id, config: existing.config }
    : { mode: "add" };
  const [draft, setDraft] = useState<McpServerDraft>(
    existing ? draftFromMcpServer(existing.id, existing.config) : newMcpServerDraft(),
  );
  const [submitted, setSubmitted] = useState(false);
  const [test, setTest] = useState<McpServerTestState | null>(null);
  const result = mcpServerFromDraft(draft, existingIds, target);
  const issues = Result.isFailure(result) ? result.failure : {};
  const idError = submitted ? issues.id : undefined;
  const urlError = submitted ? issues.url : undefined;
  const testInput = mcpServerTestInputFromDraft(draft, existingIds, target);
  const tokenDropped = savedTokenDropped(draft, target);
  const testKey = testInput === null ? null : JSON.stringify(testInput);
  const currentTest = test !== null && test.key === testKey ? test : null;

  const update = (patch: Partial<McpServerDraft>) => setDraft({ ...draft, ...patch });
  const save = () => {
    setSubmitted(true);
    if (Result.isFailure(result)) return;
    updateSettings({ mcpServers: { [result.success.id]: result.success.config } });
    onClose();
  };
  const runTest = async () => {
    if (testInput === null || testKey === null) return;
    setTest({ key: testKey, result: null });
    const response = await testMcpServer({ environmentId, input: testInput });
    setTest((previous) =>
      previous?.key === testKey && previous.result === null
        ? {
            key: testKey,
            result:
              response._tag === "Success"
                ? response.value
                : { _tag: "Failed", message: "The test could not run. Try reconnecting." },
          }
        : previous,
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing ? `Edit ${existing.config.label ?? existing.id}` : "Add an MCP server"}
          </DialogTitle>
          <DialogDescription>
            Agents in Full access threads on {environmentLabel} get this server's tools. The token
            stays on that environment; agents call the server through it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="mcp-server-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-server-id">Name</Label>
              <Input
                id="mcp-server-id"
                placeholder="executor"
                value={draft.id}
                onChange={(event) => update({ id: event.target.value })}
                disabled={existing !== undefined}
                maxLength={24}
                spellCheck={false}
                autoCapitalize="none"
                aria-invalid={idError !== undefined}
                aria-describedby="mcp-server-id-hint"
                autoFocus={existing === undefined}
              />
              {idError !== undefined ? (
                <p id="mcp-server-id-hint" role="alert" className="text-xs text-destructive">
                  {idError}
                </p>
              ) : (
                <p id="mcp-server-id-hint" className="text-xs text-muted-foreground">
                  {existing
                    ? `Agents see it as ${sharedMcpServerHarnessName(draft.id)}. The name can't be changed.`
                    : "Agents see it with a “shared-” prefix. Lowercase letters, digits, and hyphens; names starting with “t3” are reserved."}
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-server-label">Label (optional)</Label>
              <Input
                id="mcp-server-label"
                placeholder="Shown in settings instead of the name"
                value={draft.label}
                onChange={(event) => update({ label: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-server-url">URL</Label>
              <Input
                id="mcp-server-url"
                type="url"
                placeholder="https://mcp.example.com/mcp"
                value={draft.url}
                onChange={(event) => update({ url: event.target.value })}
                spellCheck={false}
                aria-invalid={urlError !== undefined}
                aria-describedby={urlError !== undefined ? "mcp-server-url-error" : undefined}
                autoFocus={existing !== undefined}
              />
              {urlError !== undefined ? (
                <p id="mcp-server-url-error" role="alert" className="text-xs text-destructive">
                  {urlError}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-server-token">Bearer token</Label>
              <div className="flex items-center gap-2">
                <SecretInput
                  id="mcp-server-token"
                  className="min-w-0 flex-1"
                  configured={draft.token.kind === "saved" && !tokenDropped}
                  value={draft.token.kind === "new" ? draft.token.value : ""}
                  placeholder="Optional"
                  onChange={(event) =>
                    update({ token: nextMcpServerToken(event.target.value, target) })
                  }
                />
                {draft.token.kind === "new" || (draft.token.kind === "saved" && !tokenDropped) ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost-destructive"
                    aria-label="Clear bearer token"
                    onClick={() => update({ token: { kind: "cleared" } })}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {tokenDropped
                  ? "The saved token never goes to a new URL, so saving removes it. Enter it again to keep using one."
                  : draft.token.kind === "cleared" && existing?.config.bearerToken
                    ? "The saved token is removed when you save."
                    : "Sent as Authorization: Bearer on every call."}
              </p>
            </div>
            <div className="grid gap-1.5">
              <div className="flex items-center gap-3">
                {currentTest ? <McpServerTestStatus test={currentTest} /> : null}
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="ms-auto shrink-0"
                  disabled={testInput === null || currentTest?.result === null}
                  onClick={() => void runTest()}
                >
                  Test
                </Button>
              </div>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="mcp-server-form"
            disabled={submitted && Result.isFailure(result)}
          >
            {existing ? "Save changes" : "Add server"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
