import type { AgentFeedbackKind, AgentFeedbackTrace, ClientOs } from "@t3tools/contracts";
import type { RelayAgentFeedbackSource } from "@t3tools/contracts/relay";
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, varchar } from "drizzle-orm/pg-core";

export type AgentFeedbackGithubIssueState =
  | "none"
  | "pending"
  | "creating"
  | "created"
  | "failed"
  | "unknown";

export const agentFeedback = pgTable(
  "agent_feedback",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    receivedAt: varchar("received_at", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    kind: varchar("kind", { length: 32 }).notNull().$type<typeof AgentFeedbackKind.Type>(),
    subject: varchar("subject", { length: 255 }).notNull(),
    expected: text("expected").notNull(),
    actual: text("actual").notNull(),
    workaround: text("workaround").notNull(),
    userRequested: boolean("user_requested").notNull(),
    source: varchar("source", { length: 16 }).notNull().$type<RelayAgentFeedbackSource>(),
    traceJson: jsonb("trace_json").$type<AgentFeedbackTrace | null>(),
    provider: varchar("provider", { length: 64 }),
    model: varchar("model", { length: 255 }),
    serverVersion: varchar("server_version", { length: 64 }),
    telemetryChannel: varchar("telemetry_channel", { length: 32 }),
    serverOs: varchar("server_os", { length: 32 }).$type<ClientOs>(),
    serverArch: varchar("server_arch", { length: 32 }),
    serverMode: varchar("server_mode", { length: 32 }),
    githubIssueState: varchar("github_issue_state", { length: 16 })
      .notNull()
      .default("none")
      .$type<AgentFeedbackGithubIssueState>(),
    githubIssueAttempts: integer("github_issue_attempts").notNull().default(0),
    githubIssueClaimedAt: varchar("github_issue_claimed_at", { length: 64 }),
    githubIssueNumber: integer("github_issue_number"),
    githubIssueUrl: text("github_issue_url"),
    githubIssueError: text("github_issue_error"),
  },
  (table) => [
    index("idx_agent_feedback_environment_received").on(table.environmentId, table.receivedAt),
    index("idx_agent_feedback_github_pending")
      .on(table.githubIssueState, table.receivedAt)
      .where(sql`${table.githubIssueState} IN ('pending', 'creating')`),
  ],
);
