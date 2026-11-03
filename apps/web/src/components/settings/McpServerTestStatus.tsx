import type { McpServerTestResult } from "@t3tools/contracts";

import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { describeMcpServerTest } from "./McpServersSettings.logic";

/** A test answers for the request `key` names; `result` is null while it runs. */
export type McpServerTestState = {
  readonly key: string;
  readonly result: McpServerTestResult | null;
};

export function McpServerTestStatus({ test }: { readonly test: McpServerTestState }) {
  const described = test.result === null ? null : describeMcpServerTest(test.result);
  return (
    <span role="status" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <ConnectionStatusDot
        dotClassName={
          described === null ? "bg-warning" : described.ok ? "bg-success" : "bg-destructive"
        }
      />
      <span className="min-w-0 wrap-anywhere">{described?.label ?? "Testing…"}</span>
    </span>
  );
}
