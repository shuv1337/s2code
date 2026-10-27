/**
 * OAuth-style device authorization for the Watch: it polls with its device code while the owner
 * approves the user code elsewhere, minting a one-time `watch.` credential for `/oauth/token`.
 * Approvals may come from another process, so reads go to SQLite and expiry is applied lazily.
 */
import {
  WATCH_PAIRING_DEFAULT_CLIENT_LABEL,
  type WatchPairingTokenResponse,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as PairingGrantStore from "./PairingGrantStore.ts";
import { WatchRestriction } from "./WatchAuth.ts";

export class WatchPairingError extends Schema.TaggedError<WatchPairingError>()(
  "WatchPairingError",
  {
    code: Schema.Literals(["pairing_rate_limited", "pairing_not_found"]),
  },
) {
  override get message(): string {
    return this.code === "pairing_rate_limited"
      ? "Too many Watch pairing requests are pending."
      : "Unknown or already used Watch pairing request.";
  }
}

export class WatchPairingApprovalError extends Schema.TaggedError<WatchPairingApprovalError>()(
  "WatchPairingApprovalError",
  {
    userCode: Schema.String,
    reason: Schema.Literals(["unknown", "expired", "not_pending"]),
  },
) {
  override get message(): string {
    return this.reason === "unknown"
      ? `No Watch pairing request has the code '${this.userCode}'.`
      : this.reason === "expired"
        ? `The Watch pairing request '${this.userCode}' has expired. Start pairing again on the Watch.`
        : `The Watch pairing request '${this.userCode}' was already approved or denied.`;
  }
}

export class WatchPairingStorageError extends Schema.TaggedError<WatchPairingStorageError>()(
  "WatchPairingStorageError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Unable to access Watch pairing state.";
  }
}

export interface WatchPairingStarted {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresAt: DateTime.Utc;
  readonly interval: number;
}

export interface WatchPairingPendingRequest {
  readonly userCode: string;
  readonly clientLabel: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}

export interface WatchPairingApproval {
  readonly userCode: string;
  readonly clientLabel: string;
  readonly restriction: WatchRestriction;
  readonly expiresAt: DateTime.Utc;
}

export class WatchPairingStore extends Context.Service<
  WatchPairingStore,
  {
    readonly start: (input: {
      readonly clientLabel?: string;
    }) => Effect.Effect<WatchPairingStarted, WatchPairingError | WatchPairingStorageError>;
    readonly poll: (input: {
      readonly deviceCode: string;
    }) => Effect.Effect<WatchPairingTokenResponse, WatchPairingError | WatchPairingStorageError>;
    /** Accepts the user code case-insensitively, with or without its hyphen. */
    readonly approve: (input: {
      readonly userCode: string;
      readonly restriction: WatchRestriction;
      readonly label?: string;
    }) => Effect.Effect<
      WatchPairingApproval,
      | WatchPairingApprovalError
      | WatchPairingStorageError
      | PairingGrantStore.BootstrapCredentialInternalError
    >;
    readonly deny: (input: {
      readonly userCode: string;
    }) => Effect.Effect<
      { readonly userCode: string },
      WatchPairingApprovalError | WatchPairingStorageError
    >;
    readonly listPending: () => Effect.Effect<
      ReadonlyArray<WatchPairingPendingRequest>,
      WatchPairingStorageError
    >;
    readonly expireStale: () => Effect.Effect<void, WatchPairingStorageError>;
  }
>()("t3/auth/WatchPairingStore") {}

const POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_STEP_SECONDS = 5;
const REQUEST_TTL = Duration.minutes(10);
const CREDENTIAL_TTL = Duration.minutes(15);
const MAX_PENDING_REQUESTS = 20;
const TERMINAL_ROW_RETENTION = Duration.days(1);
const USER_CODE_ATTEMPTS = 5;
// 32 symbols divide 256 evenly, so `byte % 32` is unbiased.
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const USER_CODE_LENGTH = 8;

type RequestStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

const storageError = (cause: unknown) => new WatchPairingStorageError({ cause });
const encodeRestrictionJson = Schema.encodeEffect(Schema.fromJsonString(WatchRestriction));

/** `abcd-efgh`, `ABCDEFGH`, and `ABCD-EFGH` all become `ABCD-EFGH`; anything else is undefined. */
const normalizeWatchPairingUserCode = (input: string): string | undefined => {
  const compact = input.replace(/[\s-]/g, "").toUpperCase();
  if (
    compact.length !== USER_CODE_LENGTH ||
    ![...compact].every((char) => USER_CODE_ALPHABET.includes(char))
  ) {
    return undefined;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const pairingGrants = yield* PairingGrantStore.PairingGrantStore;

  const randomBytes = (size: number) =>
    crypto.randomBytes(size).pipe(Effect.mapError(storageError));
  // Only the hash is stored, so a database read never yields a pollable device code.
  const hashDeviceCode = (deviceCode: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(deviceCode)).pipe(
      Effect.map((digest) => Buffer.from(digest).toString("hex")),
      Effect.mapError(storageError),
    );

  const generateUserCode = randomBytes(USER_CODE_LENGTH).pipe(
    Effect.map((bytes) => {
      const chars = [...bytes].map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
      return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
    }),
  );

  const expireStaleAt = (now: DateTime.Utc) => {
    const nowIso = DateTime.formatIso(now);
    const cutoffIso = DateTime.formatIso(
      DateTime.subtract(now, { milliseconds: Duration.toMillis(TERMINAL_ROW_RETENTION) }),
    );
    return Effect.gen(function* () {
      yield* sql`
        UPDATE auth_watch_pairing_requests
        SET status = 'expired', credential = NULL
        WHERE (status = 'pending' AND expires_at <= ${nowIso})
           OR (status = 'approved' AND credential_expires_at <= ${nowIso})
      `;
      yield* sql`
        DELETE FROM auth_watch_pairing_requests
        WHERE status IN ('denied', 'consumed', 'expired') AND expires_at <= ${cutoffIso}
      `;
    }).pipe(Effect.mapError(storageError));
  };

  const findByUserCode = Effect.fn("WatchPairingStore.findByUserCode")(function* (
    userCode: string,
  ) {
    const rows = yield* sql<{
      readonly deviceCodeHash: string;
      readonly clientLabel: string | null;
      readonly status: RequestStatus;
    }>`
      SELECT device_code_hash AS "deviceCodeHash", client_label AS "clientLabel", status
      FROM auth_watch_pairing_requests
      WHERE user_code = ${userCode}
      ORDER BY status = 'pending' DESC, created_at DESC
      LIMIT 1
    `.pipe(Effect.mapError(storageError));
    const row = rows[0];
    if (row === undefined) {
      return yield* new WatchPairingApprovalError({ userCode, reason: "unknown" });
    }
    if (row.status === "expired") {
      return yield* new WatchPairingApprovalError({ userCode, reason: "expired" });
    }
    if (row.status !== "pending") {
      return yield* new WatchPairingApprovalError({ userCode, reason: "not_pending" });
    }
    return row;
  });

  const requireUserCode = (input: string) => {
    const userCode = normalizeWatchPairingUserCode(input);
    return userCode === undefined
      ? Effect.fail(new WatchPairingApprovalError({ userCode: input.trim(), reason: "unknown" }))
      : Effect.succeed(userCode);
  };

  const start: WatchPairingStore["Service"]["start"] = Effect.fn("WatchPairingStore.start")(
    function* (input) {
      const now = yield* DateTime.now;
      yield* expireStaleAt(now);
      const clientLabel = input.clientLabel?.trim() || WATCH_PAIRING_DEFAULT_CLIENT_LABEL;
      const expiresAt = DateTime.add(now, { milliseconds: Duration.toMillis(REQUEST_TTL) });
      const deviceCode = Buffer.from(yield* randomBytes(32)).toString("base64url");
      const deviceCodeHash = yield* hashDeviceCode(deviceCode);
      for (let attempt = 0; attempt < USER_CODE_ATTEMPTS; attempt += 1) {
        const userCode = yield* generateUserCode;
        const inserted = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const [pending] = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count FROM auth_watch_pairing_requests WHERE status = 'pending'
              `;
              if ((pending?.count ?? 0) >= MAX_PENDING_REQUESTS) {
                return yield* new WatchPairingError({ code: "pairing_rate_limited" });
              }
              // The partial unique index rejects a user code another pending request holds.
              const rows = yield* sql`
                INSERT OR IGNORE INTO auth_watch_pairing_requests (
                  device_code_hash, user_code, client_label, status, created_at, expires_at,
                  poll_interval_seconds
                )
                VALUES (
                  ${deviceCodeHash}, ${userCode}, ${clientLabel}, 'pending',
                  ${DateTime.formatIso(now)}, ${DateTime.formatIso(expiresAt)},
                  ${POLL_INTERVAL_SECONDS}
                )
                RETURNING device_code_hash
              `;
              return rows.length > 0;
            }),
          )
          .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
        if (inserted) {
          return { deviceCode, userCode, expiresAt, interval: POLL_INTERVAL_SECONDS };
        }
      }
      return yield* storageError(new Error("Could not allocate a unique Watch pairing user code."));
    },
  );

  const poll: WatchPairingStore["Service"]["poll"] = Effect.fn("WatchPairingStore.poll")(
    function* (input) {
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      yield* expireStaleAt(now);
      const deviceCodeHash = yield* hashDeviceCode(input.deviceCode);
      const rows = yield* sql<{
        readonly status: RequestStatus;
        readonly credential: string | null;
        readonly credentialExpiresAt: string | null;
        readonly lastPolledAt: string | null;
        readonly interval: number;
      }>`
        SELECT
          status,
          credential,
          credential_expires_at AS "credentialExpiresAt",
          last_polled_at AS "lastPolledAt",
          poll_interval_seconds AS "interval"
        FROM auth_watch_pairing_requests
        WHERE device_code_hash = ${deviceCodeHash}
      `.pipe(Effect.mapError(storageError));
      const row = rows[0];
      if (row === undefined || row.status === "consumed") {
        return yield* new WatchPairingError({ code: "pairing_not_found" });
      }
      switch (row.status) {
        case "denied":
          return { status: "denied" } as const;
        case "expired":
          return { status: "expired" } as const;
        case "approved": {
          // Only the poll whose status CAS wins receives the credential.
          const consumed = yield* sql`
            UPDATE auth_watch_pairing_requests
            SET status = 'consumed', credential = NULL
            WHERE device_code_hash = ${deviceCodeHash} AND status = 'approved'
            RETURNING device_code_hash
          `.pipe(Effect.mapError(storageError));
          if (
            consumed.length === 0 ||
            row.credential === null ||
            row.credentialExpiresAt === null
          ) {
            return yield* new WatchPairingError({ code: "pairing_not_found" });
          }
          return {
            status: "approved",
            credential: row.credential,
            expiresAt: DateTime.makeUnsafe(row.credentialExpiresAt),
          } as const;
        }
        case "pending": {
          const tooSoon =
            row.lastPolledAt !== null &&
            now.epochMilliseconds - Date.parse(row.lastPolledAt) < row.interval * 1_000;
          if (tooSoon) {
            const [updated] = yield* sql<{ readonly interval: number }>`
              UPDATE auth_watch_pairing_requests
              SET poll_interval_seconds = poll_interval_seconds + ${SLOW_DOWN_STEP_SECONDS},
                  last_polled_at = ${nowIso}
              WHERE device_code_hash = ${deviceCodeHash} AND status = 'pending'
              RETURNING poll_interval_seconds AS "interval"
            `.pipe(Effect.mapError(storageError));
            if (updated !== undefined) {
              return { status: "slow_down", interval: updated.interval } as const;
            }
            return { status: "pending" } as const;
          }
          yield* sql`
            UPDATE auth_watch_pairing_requests
            SET last_polled_at = ${nowIso}
            WHERE device_code_hash = ${deviceCodeHash} AND status = 'pending'
          `.pipe(Effect.mapError(storageError));
          return { status: "pending" } as const;
        }
      }
    },
  );

  const approve: WatchPairingStore["Service"]["approve"] = Effect.fn("WatchPairingStore.approve")(
    function* (input) {
      const userCode = yield* requireUserCode(input.userCode);
      const now = yield* DateTime.now;
      yield* expireStaleAt(now);
      const request = yield* findByUserCode(userCode);
      const clientLabel = request.clientLabel ?? WATCH_PAIRING_DEFAULT_CLIENT_LABEL;
      const restrictionJson = yield* encodeRestrictionJson(input.restriction).pipe(
        Effect.mapError(storageError),
      );
      const issued = yield* pairingGrants.issueOneTimeToken({
        purpose: "watch",
        watchRestriction: input.restriction,
        label: input.label ?? clientLabel,
        ttl: CREDENTIAL_TTL,
      });
      const updated = yield* sql`
        UPDATE auth_watch_pairing_requests
        SET status = 'approved',
            credential = ${issued.credential},
            credential_expires_at = ${DateTime.formatIso(issued.expiresAt)},
            restriction_json = ${restrictionJson}
        WHERE device_code_hash = ${request.deviceCodeHash}
          AND status = 'pending'
          AND expires_at > ${DateTime.formatIso(now)}
        RETURNING device_code_hash
      `.pipe(Effect.mapError(storageError));
      if (updated.length === 0) {
        yield* pairingGrants.revoke(issued.id);
        return yield* new WatchPairingApprovalError({ userCode, reason: "not_pending" });
      }
      return { userCode, clientLabel, restriction: input.restriction, expiresAt: issued.expiresAt };
    },
  );

  const deny: WatchPairingStore["Service"]["deny"] = Effect.fn("WatchPairingStore.deny")(
    function* (input) {
      const userCode = yield* requireUserCode(input.userCode);
      const now = yield* DateTime.now;
      yield* expireStaleAt(now);
      const request = yield* findByUserCode(userCode);
      const updated = yield* sql`
        UPDATE auth_watch_pairing_requests
        SET status = 'denied'
        WHERE device_code_hash = ${request.deviceCodeHash}
          AND status = 'pending'
          AND expires_at > ${DateTime.formatIso(now)}
        RETURNING device_code_hash
      `.pipe(Effect.mapError(storageError));
      if (updated.length === 0) {
        return yield* new WatchPairingApprovalError({ userCode, reason: "not_pending" });
      }
      return { userCode };
    },
  );

  const listPending: WatchPairingStore["Service"]["listPending"] = Effect.fn(
    "WatchPairingStore.listPending",
  )(function* () {
    yield* expireStaleAt(yield* DateTime.now);
    const rows = yield* sql<{
      readonly userCode: string;
      readonly clientLabel: string | null;
      readonly createdAt: string;
      readonly expiresAt: string;
    }>`
      SELECT
        user_code AS "userCode",
        client_label AS "clientLabel",
        created_at AS "createdAt",
        expires_at AS "expiresAt"
      FROM auth_watch_pairing_requests
      WHERE status = 'pending'
      ORDER BY created_at ASC, user_code ASC
    `.pipe(Effect.mapError(storageError));
    return rows.map((row) => ({
      userCode: row.userCode,
      clientLabel: row.clientLabel ?? WATCH_PAIRING_DEFAULT_CLIENT_LABEL,
      createdAt: DateTime.makeUnsafe(row.createdAt),
      expiresAt: DateTime.makeUnsafe(row.expiresAt),
    }));
  });

  return WatchPairingStore.of({
    start,
    poll,
    approve,
    deny,
    listPending,
    expireStale: Effect.fn("WatchPairingStore.expireStale")(function* () {
      return yield* expireStaleAt(yield* DateTime.now);
    }),
  });
});

export const layer = Layer.effect(WatchPairingStore, make);
