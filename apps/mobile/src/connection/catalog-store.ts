import {
  ConnectionCatalogDocument,
  type ConnectionCatalogDocument as ConnectionCatalogDocumentType,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  StoredConnectionCredential,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  ConnectionProfile,
  ConnectionTransientError,
  PersistedConnectionTarget,
  StoredPullRequestRoutingPermission,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as MobileSecureStorage from "../persistence/mobile-secure-storage";
import { migrateLegacyConnectionCatalog } from "./migration";

export const CONNECTION_CATALOG_KEY = "t3code.connection-catalog.v1";
export const LEGACY_CONNECTIONS_KEY = "t3code.connections";

function catalogError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the local connection catalog: ${String(cause)}`,
  });
}

const ConnectionCatalogDocumentJson = Schema.fromJsonString(ConnectionCatalogDocument);
const encodeConnectionCatalogDocument = Schema.encodeEffect(ConnectionCatalogDocumentJson);
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const encodeCatalog = Effect.fn("mobile.connectionStorage.encodeCatalog")(function* (
  catalog: ConnectionCatalogDocumentType,
) {
  return yield* encodeConnectionCatalogDocument(catalog).pipe(
    Effect.mapError((cause) => catalogError("encode", cause)),
  );
});

/**
 * Builds from other branches or versions share this keychain item, so one record this build
 * cannot read must cost that record, never every saved environment.
 */
function decodeCatalogLeniently(raw: string) {
  const parsed = Option.getOrUndefined(parseJson(raw));
  const fields: Record<string, unknown> = Predicate.isObject(parsed) ? parsed : {};
  let lossless = Predicate.isObject(parsed);
  const entries = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, key: string) => {
    const value = fields[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      lossless = false;
      return [];
    }
    const decode = Schema.decodeUnknownOption(schema);
    const decoded = value.flatMap((entry) => Option.toArray(decode(entry)));
    if (decoded.length !== value.length) lossless = false;
    return decoded;
  };
  const githubRoutingPermissions =
    fields.githubRoutingPermissions === undefined
      ? undefined
      : entries(StoredPullRequestRoutingPermission, "githubRoutingPermissions");
  const catalog: ConnectionCatalogDocumentType = {
    schemaVersion: 1,
    targets: entries(PersistedConnectionTarget, "targets"),
    profiles: entries(ConnectionProfile, "profiles"),
    credentials: entries(StoredConnectionCredential, "credentials"),
    remoteDpopTokens: entries(TokenStore.RemoteDpopAccessToken, "remoteDpopTokens"),
    ...(githubRoutingPermissions === undefined ? {} : { githubRoutingPermissions }),
    disabledEnvironmentIds: entries(EnvironmentId, "disabledEnvironmentIds"),
  };
  return { catalog, lossless };
}

function isEmptyCatalog(catalog: ConnectionCatalogDocumentType) {
  return (
    catalog.targets.length === 0 &&
    catalog.profiles.length === 0 &&
    catalog.credentials.length === 0 &&
    catalog.remoteDpopTokens.length === 0 &&
    (catalog.githubRoutingPermissions ?? []).length === 0 &&
    catalog.disabledEnvironmentIds.length === 0
  );
}

interface LoadedCatalog {
  readonly catalog: ConnectionCatalogDocumentType;
  /** The stored value holds records this build could not read, so an empty catalog must not replace it. */
  readonly storedUnreadable: boolean;
}

interface CatalogStore {
  readonly read: Effect.Effect<ConnectionCatalogDocumentType, ConnectionTransientError>;
  readonly update: (
    transform: (catalog: ConnectionCatalogDocumentType) => ConnectionCatalogDocumentType,
  ) => Effect.Effect<void, ConnectionTransientError>;
}

export const make = Effect.fn("mobile.connectionStorage.makeCatalogStore")(function* () {
  const storage = yield* MobileSecureStorage.MobileSecureStorage;
  const getItem = (key: string) =>
    storage.getItem(key).pipe(Effect.mapError((cause) => catalogError("load", cause)));
  const setItem = (key: string, value: string) =>
    storage.setItem(key, value).pipe(Effect.mapError((cause) => catalogError("save", cause)));
  const deleteItem = (key: string) =>
    storage.removeItem(key).pipe(Effect.mapError((cause) => catalogError("delete", cause)));
  const state = yield* Ref.make<Option.Option<LoadedCatalog>>(Option.none());
  const lock = yield* Semaphore.make(1);

  const loadLegacyCatalog = Effect.fn("mobile.connectionStorage.loadLegacyCatalog")(function* () {
    const legacyRaw = yield* getItem(LEGACY_CONNECTIONS_KEY);
    const catalog =
      legacyRaw === null || legacyRaw.trim() === ""
        ? EMPTY_CONNECTION_CATALOG_DOCUMENT
        : yield* migrateLegacyConnectionCatalog(legacyRaw).pipe(
            Effect.mapError((cause) => catalogError("migrate", cause)),
            Effect.catch((error) =>
              Effect.logWarning("Discarding corrupt legacy mobile connections", error).pipe(
                Effect.as(EMPTY_CONNECTION_CATALOG_DOCUMENT),
              ),
            ),
          );
    if (legacyRaw !== null && legacyRaw.trim() !== "") {
      const encoded = yield* encodeCatalog(catalog);
      yield* setItem(CONNECTION_CATALOG_KEY, encoded);
      yield* deleteItem(LEGACY_CONNECTIONS_KEY);
    }
    return catalog;
  });

  const decodeStoredCatalog = Effect.fn("mobile.connectionStorage.decodeCatalog")(function* (
    raw: string,
  ) {
    const { catalog, lossless } = decodeCatalogLeniently(raw);
    if (lossless) {
      return { catalog, storedUnreadable: false } satisfies LoadedCatalog;
    }
    const backupKey = `${CONNECTION_CATALOG_KEY}.unreadable.${yield* Clock.currentTimeMillis}`;
    yield* setItem(backupKey, raw);
    yield* Effect.logWarning("Kept the readable part of the mobile connection catalog", {
      backupKey,
      environments: new Set(catalog.targets.map((target) => target.environmentId)).size,
    });
    return { catalog, storedUnreadable: isEmptyCatalog(catalog) } satisfies LoadedCatalog;
  });

  const loadUnlocked = Effect.fn("mobile.connectionStorage.loadCatalog")(function* () {
    const cached = yield* Ref.get(state);
    if (Option.isSome(cached)) {
      return cached.value;
    }
    const raw = yield* getItem(CONNECTION_CATALOG_KEY);
    const loaded: LoadedCatalog =
      raw !== null && raw.trim() !== ""
        ? yield* decodeStoredCatalog(raw)
        : { catalog: yield* loadLegacyCatalog(), storedUnreadable: false };
    yield* Ref.set(state, Option.some(loaded));
    return loaded;
  });

  const read = lock.withPermits(1)(loadUnlocked().pipe(Effect.map((loaded) => loaded.catalog)));
  const update: CatalogStore["update"] = Effect.fn("mobile.connectionStorage.updateCatalog")(
    function* (transform) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const loaded = yield* loadUnlocked();
          const next = transform(loaded.catalog);
          if (loaded.storedUnreadable && isEmptyCatalog(next)) {
            yield* Ref.set(state, Option.some({ catalog: next, storedUnreadable: true }));
            return;
          }
          const encoded = yield* encodeCatalog(next);
          yield* setItem(CONNECTION_CATALOG_KEY, encoded);
          yield* Ref.set(state, Option.some({ catalog: next, storedUnreadable: false }));
        }),
      );
    },
  );

  return { read, update } satisfies CatalogStore;
});
