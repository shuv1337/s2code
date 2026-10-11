import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";

const layer = CommandReceiptStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

it.effect(
  "receipt identity survives insert, lookup and upsert without changing project receipts",
  () =>
    Effect.gen(function* () {
      const store = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const acceptedAt = yield* DateTime.now;
      const receipt = {
        commandId: CommandId.make("thread-command"),
        threadId: ThreadId.make("thread"),
        commandType: "message.dispatch",
        acceptedAt,
        resultSequence: 1,
        status: "accepted" as const,
        error: null,
        payloadFingerprint: "fingerprint",
        principal: "watch-session",
        admissionAction: "send" as const,
      };
      assert.isTrue(yield* store.insertIfAbsent(receipt));
      assert.isFalse(
        yield* store.insertIfAbsent({
          ...receipt,
          payloadFingerprint: "other",
          principal: "other",
          admissionAction: "queue",
        }),
      );
      assert.deepEqual(yield* store.getByCommandId(receipt.commandId), Option.some(receipt));
      const updated = { ...receipt, resultSequence: 2 };
      yield* store.upsert(updated);
      assert.deepEqual(yield* store.getByCommandId(receipt.commandId), Option.some(updated));
      const rejected = {
        ...receipt,
        commandId: CommandId.make("rejected-command"),
        status: "rejected" as const,
        error: "admission:stale_target",
        admissionAction: "steer" as const,
      };
      yield* store.insertIfAbsent(rejected);
      assert.deepEqual(yield* store.getByCommandId(rejected.commandId), Option.some(rejected));

      const projectReceipt = {
        commandId: CommandId.make("project-command"),
        projectId: ProjectId.make("project"),
        commandType: "project.create",
        acceptedAt,
        resultSequence: 3,
        status: "accepted" as const,
        error: null,
      };
      assert.isTrue(yield* store.insertIfAbsent(projectReceipt));
      assert.deepEqual(
        yield* store.getProjectByCommandId(projectReceipt.commandId),
        Option.some(projectReceipt),
      );
      assert.isTrue(Option.isNone(yield* store.getByCommandId(projectReceipt.commandId)));
    }).pipe(Effect.provide(layer)),
);

it.effect("legacy SQL receipts decode nullable identity columns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
    INSERT INTO orchestration_command_receipts
      (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error)
    VALUES ('legacy', 'thread', 'thread', 'message.dispatch', ${now}, 1, 'accepted', NULL)
  `;
    const receipt = Option.getOrThrow(yield* store.getByCommandId(CommandId.make("legacy")));
    assert.isNull(receipt.payloadFingerprint);
    assert.isNull(receipt.principal);
    assert.isNull(receipt.admissionAction);
  }).pipe(Effect.provide(layer)),
);
