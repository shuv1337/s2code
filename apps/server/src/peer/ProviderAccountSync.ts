import {
  PROVIDER_ACCOUNT_SYNC_MAX_RECORDS,
  ProviderAccountSyncResult,
  ProviderAccountUsageLimitRecord,
  type PeerLink,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  applyRecord,
  type LocalTransition,
  localChangeTime,
  localSpentNotes,
  localTransitions,
  supersedes,
} from "../provider/accountUsageLimitSync.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/**
 * Keeps pooled provider accounts' quota states in step across linked environments, so an
 * account whose quota ran out on one machine is not picked on another. Records travel over the
 * link's own `/mcp` session; credentials and emails never do.
 */
export class ProviderAccountSync extends Context.Service<
  ProviderAccountSync,
  {
    /** Merges another environment's records, applies what changed here, and returns every record known here. */
    readonly exchange: (
      records: ReadonlyArray<ProviderAccountUsageLimitRecord>,
    ) => Effect.Effect<ReadonlyArray<ProviderAccountUsageLimitRecord>>;
    /** Exchanges records once with every linked environment that supports it. */
    readonly syncNow: Effect.Effect<void>;
  }
>()("t3/peer/ProviderAccountSync") {}

/** How often linked environments converge, so a peer's changes reach the side that links to it. */
const SYNC_INTERVAL = "60 seconds";
const SYNC_TOOL = "t3_provider_account_sync";
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_LABEL_LENGTH = 256;

interface UsageLimitRow {
  readonly account: string;
  readonly driver: string;
  readonly spent: number;
  readonly changed_at: string;
  readonly origin_environment_id: string;
  readonly origin_label: string;
  readonly message: string | null;
  readonly applied: number;
}

const decodeRecord = Schema.decodeUnknownOption(ProviderAccountUsageLimitRecord);

const recordOf = (row: UsageLimitRow) =>
  decodeRecord({
    account: row.account,
    driver: row.driver,
    spent: row.spent === 1,
    changedAt: row.changed_at,
    origin: { environmentId: row.origin_environment_id, label: row.origin_label },
    ...(row.message === null ? {} : { message: row.message }),
  });

/** Records must decode on every peer, so free text is cut to the contract's bounds. */
const clip = (text: string, max: number) => text.slice(0, max).trim();

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  // Merges, local records and applies each read a record before replacing it.
  const lock = yield* Semaphore.make(1);
  const syncRequested = yield* Queue.sliding<void>(1);
  // Instance and cleared-note pairs an apply turned back on, so the watcher does not take them
  // for the user's re-enable. Read and written under `lock`.
  const appliedEnables = new Set<string>();
  const enableKey = (instanceId: string, noteAt: string) => `${instanceId}\n${noteAt}`;

  const self = environment.getDescriptor.pipe(
    Effect.map((descriptor) => ({
      environmentId: descriptor.environmentId,
      label: clip(descriptor.label, MAX_LABEL_LENGTH) || descriptor.environmentId,
    })),
  );

  const readRows = (where: "all" | "pending") =>
    (where === "all"
      ? // A peer refuses more, and the oldest states have long converged.
        sql<UsageLimitRow>`
          SELECT * FROM (
            SELECT * FROM provider_account_usage_limits
            ORDER BY changed_at DESC LIMIT ${PROVIDER_ACCOUNT_SYNC_MAX_RECORDS}
          ) ORDER BY account
        `
      : sql<UsageLimitRow>`
          SELECT * FROM provider_account_usage_limits WHERE applied = 0 ORDER BY account
        `
    ).pipe(Effect.map((rows) => rows.flatMap((row) => Option.toArray(recordOf(row)))));

  const readOne = (account: string) =>
    sql<UsageLimitRow>`
      SELECT * FROM provider_account_usage_limits WHERE account = ${account}
    `.pipe(
      Effect.map((rows) =>
        rows[0] === undefined ? undefined : Option.getOrUndefined(recordOf(rows[0])),
      ),
    );

  /**
   * Stores `record` when it replaces what is known for its account. Callers hold `lock`.
   * Untraced: it runs per record inside the merge or record span that called it.
   */
  const store = Effect.fnUntraced(function* (
    record: ProviderAccountUsageLimitRecord,
    applied: boolean,
  ) {
    if (!supersedes(record, yield* readOne(record.account))) return false;
    yield* sql`
      INSERT INTO provider_account_usage_limits (
        account, driver, spent, changed_at, origin_environment_id, origin_label, message, applied
      ) VALUES (
        ${record.account}, ${record.driver}, ${record.spent ? 1 : 0}, ${record.changedAt},
        ${record.origin.environmentId}, ${record.origin.label}, ${record.message ?? null},
        ${applied ? 1 : 0}
      )
      ON CONFLICT (account) DO UPDATE SET
        driver = excluded.driver,
        spent = excluded.spent,
        changed_at = excluded.changed_at,
        origin_environment_id = excluded.origin_environment_id,
        origin_label = excluded.origin_label,
        message = excluded.message,
        applied = excluded.applied
    `;
    return true;
  });

  const merge = Effect.fn("ProviderAccountSync.merge")(function* (
    records: ReadonlyArray<ProviderAccountUsageLimitRecord>,
  ) {
    const here = (yield* self).environmentId;
    yield* lock.withPermits(1)(
      Effect.forEach(records, (record) => store(record, record.origin.environmentId === here), {
        discard: true,
      }),
    );
  });

  /** Brings settings in line with other environments' records not yet applied here. */
  const applyPending = Effect.fn("ProviderAccountSync.applyPending")(function* () {
    const here = (yield* self).environmentId;
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const pending = (yield* readRows("pending")).filter(
          (record) => record.origin.environmentId !== here,
        );
        for (const record of pending) {
          yield* Effect.gen(function* () {
            const current = yield* settings.getSettings;
            const providers = yield* registry.getProviders;
            const { writes, settled } = applyRecord({
              record,
              self: here,
              instances: current.providerInstances,
              providers,
            });
            for (const write of writes) {
              const cleared = current.providerInstances[write.instanceId]?.usageLimitDisabled;
              yield* settings.updateProviderInstance({ operation: "upsert", ...write });
              if (!record.spent && cleared !== undefined) {
                appliedEnables.add(enableKey(write.instanceId, cleared.at));
              }
            }
            if (!settled) return;
            // Only the record that was applied; a newer one merged since stays pending.
            yield* sql`
              UPDATE provider_account_usage_limits SET applied = 1
              WHERE account = ${record.account}
                AND changed_at = ${record.changedAt}
                AND origin_environment_id = ${record.origin.environmentId}
            `;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider-account-sync.apply-failed", { cause }),
            ),
          );
        }
      }),
    );
  });

  const applyPendingSafely = applyPending().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("provider-account-sync.apply-failed", { cause }),
    ),
  );

  /** Records what this environment saw happen to its own instances. */
  const recordLocal = Effect.fn("ProviderAccountSync.recordLocal")(function* (
    transitions: ReadonlyArray<LocalTransition>,
    startup: boolean,
  ) {
    const origin = yield* self;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const recorded = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        let recorded = false;
        for (const transition of transitions) {
          const current = yield* readOne(transition.account);
          let changedAt: string;
          if (transition.spent) {
            // A note from before this run is recorded as it was, unless something newer is known.
            if (
              startup &&
              current !== undefined &&
              Date.parse(current.changedAt) >= Date.parse(transition.at)
            ) {
              continue;
            }
            changedAt = startup
              ? transition.at
              : localChangeTime(Date.parse(transition.at), current);
          } else {
            // Only a user turning on what a quota turned off resets it; applied resets do not.
            if (appliedEnables.delete(enableKey(transition.instanceId, transition.at))) continue;
            if (current?.spent !== true) continue;
            changedAt = localChangeTime(nowMs, current);
          }
          const message =
            transition.spent && transition.message !== undefined
              ? clip(transition.message, MAX_MESSAGE_LENGTH)
              : "";
          const stored = yield* store(
            {
              account: transition.account,
              driver: transition.driver,
              spent: transition.spent,
              changedAt,
              origin,
              ...(message === "" ? {} : { message }),
            },
            true,
          );
          recorded = recorded || stored;
        }
        return recorded;
      }),
    );
    if (recorded) yield* Queue.offer(syncRequested, undefined);
  });

  const syncWith = Effect.fn("ProviderAccountSync.syncWith")(
    function* (link: PeerLink) {
      // An unreachable or older peer is skipped without a call, so its link shows no error.
      const resolved = yield* links.resolve(link.environmentId).pipe(Effect.option);
      if (Option.isNone(resolved) || resolved.value.capabilities.providerAccountSync !== true) {
        return;
      }
      const result = yield* peers.call({
        environmentId: link.environmentId,
        tool: SYNC_TOOL,
        arguments: { records: yield* readRows("all") },
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        success: ProviderAccountSyncResult,
      });
      if (result.environmentId !== link.environmentId) {
        return yield* Effect.logWarning("provider-account-sync.peer-mismatch", {
          environmentId: link.environmentId,
        });
      }
      yield* merge(result.records);
      yield* applyPending();
    },
    (effect, link) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider-account-sync.peer-failed", {
            environmentId: link.environmentId,
            cause,
          }),
        ),
      ),
  );

  const syncNow: ProviderAccountSync["Service"]["syncNow"] = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    if (!current.linkedEnvironmentsEnabled) return;
    // Without a pool or a state to pass on, an exchange could change nothing on either side.
    const pooled = Object.values(current.providerInstances).some(
      (instance) => instance.disableOnUsageLimit === true,
    );
    if (!pooled && (yield* sql`SELECT 1 FROM provider_account_usage_limits LIMIT 1`).length === 0) {
      return;
    }
    const now = yield* DateTime.now;
    const stored = yield* links.stored;
    yield* Effect.forEach(
      stored.filter((link) => DateTime.isGreaterThan(link.expiresAt, now)),
      syncWith,
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("provider-account-sync.sync-failed", { cause })),
    Effect.withSpan("ProviderAccountSync.syncNow"),
  );

  const exchange: ProviderAccountSync["Service"]["exchange"] = Effect.fn(
    "ProviderAccountSync.exchange",
  )(function* (records) {
    yield* merge(records);
    yield* applyPendingSafely;
    return yield* readRows("all");
  }, Effect.orDie);

  // Subscribed before the snapshot below is read, so no change falls between them.
  const changes = yield* settings.subscribeChanges;
  yield* forkParked(
    Effect.gen(function* () {
      let previous = (yield* settings.getSettings).providerInstances;
      yield* recordLocal(localSpentNotes(previous), true);
      yield* applyPendingSafely;
      yield* Stream.runForEach(changes, (next) => {
        const transitions = localTransitions(previous, next.providerInstances);
        previous = next.providerInstances;
        return transitions.length === 0
          ? Effect.void
          : recordLocal(transitions, false).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("provider-account-sync.record-failed", { cause }),
              ),
            );
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider-account-sync.watch-failed", { cause }),
      ),
    ),
  );
  // A sign-in probe finishing can settle an apply that was waiting on it.
  yield* forkParked(Stream.runForEach(registry.streamChanges, () => applyPendingSafely));
  yield* forkParked(Queue.take(syncRequested).pipe(Effect.andThen(syncNow), Effect.forever));
  yield* forkParked(
    Queue.offer(syncRequested, undefined).pipe(Effect.repeat(Schedule.spaced(SYNC_INTERVAL))),
  );

  return ProviderAccountSync.of({ exchange, syncNow });
});

export const layer = Layer.effect(ProviderAccountSync, make);
