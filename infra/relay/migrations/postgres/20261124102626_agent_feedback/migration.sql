CREATE TABLE "agent_feedback" (
	"id" varchar(64) PRIMARY KEY,
	"environment_id" varchar(191) NOT NULL,
	"received_at" varchar(64) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"subject" varchar(255) NOT NULL,
	"expected" text NOT NULL,
	"actual" text NOT NULL,
	"workaround" text NOT NULL,
	"user_requested" boolean NOT NULL,
	"source" varchar(16) NOT NULL,
	"trace_json" jsonb,
	"provider" varchar(64),
	"model" varchar(255),
	"server_version" varchar(64),
	"telemetry_channel" varchar(32),
	"server_os" varchar(32),
	"server_arch" varchar(32),
	"server_mode" varchar(32),
	"github_issue_state" varchar(16) DEFAULT 'none' NOT NULL,
	"github_issue_attempts" integer DEFAULT 0 NOT NULL,
	"github_issue_claimed_at" varchar(64),
	"github_issue_number" integer,
	"github_issue_url" text,
	"github_issue_error" text
);
--> statement-breakpoint
CREATE INDEX "idx_agent_feedback_environment_received" ON "agent_feedback" ("environment_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_agent_feedback_github_pending" ON "agent_feedback" ("github_issue_state","received_at") WHERE "github_issue_state" IN ('pending', 'creating');--> statement-breakpoint
-- Keep follow-up GitHub issue state updates as Postgres HOT updates.
ALTER TABLE "agent_feedback" SET (fillfactor = 80);