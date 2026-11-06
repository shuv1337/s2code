import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { PersistedConnectionTarget } from "@t3tools/client-runtime/connection";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import {
  CONNECTION_CATALOG_BACKUP_KEY,
  CONNECTION_CATALOG_KEY,
  LEGACY_CONNECTIONS_KEY,
  make,
} from "./catalog-store";
import * as MobileSecureStorage from "../persistence/mobile-secure-storage";

const decodeTarget = Schema.decodeUnknownSync(PersistedConnectionTarget);

function makeStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
  const deleted: Array<string> = [];
  const written: Array<string> = [];
  const storage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        written.push(key);
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        deleted.push(key);
        values.delete(key);
      }),
  });
  return { deleted, storage, values, written };
}

const bearerTarget = (environmentId: string) => ({
  _tag: "BearerConnectionTarget",
  environmentId,
  label: environmentId,
  connectionId: `bearer:${environmentId}`,
});

const bearerProfile = (environmentId: string) => ({
  _tag: "BearerConnectionProfile",
  connectionId: `bearer:${environmentId}`,
  environmentId,
  label: environmentId,
  httpBaseUrl: `https://${environmentId}.example.test`,
  wsBaseUrl: `wss://${environmentId}.example.test`,
});

const bearerCredential = (environmentId: string) => ({
  connectionId: `bearer:${environmentId}`,
  credential: { _tag: "BearerConnectionCredential", token: `${environmentId}-token` },
});

describe("mobile connection catalog storage", () => {
  it.effect("keeps a catalog written by an older or newer build without rewriting it", () =>
    Effect.gen(function* () {
      const raw = JSON.stringify({
        schemaVersion: 1,
        targets: [{ ...bearerTarget("nightly"), addedLater: true }, bearerTarget("laptop")],
        profiles: [bearerProfile("nightly"), bearerProfile("laptop")],
        credentials: [bearerCredential("nightly"), bearerCredential("laptop")],
        remoteDpopTokens: [],
        fieldFromANewerBuild: { anything: 1 },
      });
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: raw });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      const document = yield* catalog.read;
      expect(document.targets.map((target) => target.environmentId)).toEqual(["nightly", "laptop"]);
      expect(document.disabledEnvironmentIds).toEqual([]);
      expect(memory.written).toEqual([]);
      expect(memory.deleted).toEqual([]);
    }),
  );

  it.effect(
    "keeps readable environments and backs up the catalog when an entry is unreadable",
    () =>
      Effect.gen(function* () {
        const raw = JSON.stringify({
          schemaVersion: 1,
          targets: [
            bearerTarget("nightly"),
            { _tag: "FutureConnectionTarget", environmentId: "future", label: "Future" },
          ],
          profiles: [
            bearerProfile("nightly"),
            { ...bearerProfile("future"), network: "wireguard" },
          ],
          credentials: [bearerCredential("nightly")],
          remoteDpopTokens: "not-a-list",
          disabledEnvironmentIds: [],
        });
        const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: raw });
        const catalog = yield* make().pipe(
          Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
        );

        const document = yield* catalog.read;
        expect(document.targets.map((target) => target.environmentId)).toEqual(["nightly"]);
        expect(document.profiles.map((profile) => profile.environmentId)).toEqual(["nightly"]);
        expect(document.credentials).toHaveLength(1);
        expect(document.remoteDpopTokens).toEqual([]);
        expect(memory.values.get(CONNECTION_CATALOG_BACKUP_KEY)).toBe(raw);
        expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(raw);
        expect(memory.deleted).toEqual([]);

        const nextLaunch = yield* make().pipe(
          Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
        );
        yield* nextLaunch.read;
        expect(memory.written).toEqual([CONNECTION_CATALOG_BACKUP_KEY]);
      }),
  );

  it.effect("does not persist emptied targets while the stored targets are unreadable", () =>
    Effect.gen(function* () {
      const raw = JSON.stringify({
        schemaVersion: 1,
        targets: [{ _tag: "FutureConnectionTarget", environmentId: "nightly", label: "Nightly" }],
        profiles: [bearerProfile("nightly")],
        credentials: [bearerCredential("nightly")],
        remoteDpopTokens: [],
      });
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: raw });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      yield* catalog.update((document) => ({ ...document, githubRoutingPermissions: [] }));
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(raw);

      yield* catalog.update((document) => ({
        ...document,
        targets: [decodeTarget(bearerTarget("laptop"))],
      }));
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).not.toBe(raw);
      expect(memory.values.get(CONNECTION_CATALOG_BACKUP_KEY)).toBe(raw);
    }),
  );

  it.effect("reads past a failed backup but writes nothing until the backup succeeds", () =>
    Effect.gen(function* () {
      const raw = JSON.stringify({
        schemaVersion: 1,
        targets: [bearerTarget("nightly"), { _tag: "FutureConnectionTarget" }],
        profiles: [],
        credentials: [],
        remoteDpopTokens: [],
      });
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: raw });
      const storage = MobileSecureStorage.MobileSecureStorage.of({
        ...memory.storage,
        setItem: (key) =>
          Effect.fail(
            new MobileSecureStorage.MobileSecureStorageError({
              operation: "write",
              key,
              cause: new Error("errSecInteractionNotAllowed"),
            }),
          ),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, storage),
      );

      expect((yield* catalog.read).targets.map((target) => target.environmentId)).toEqual([
        "nightly",
      ]);
      const pairing = catalog.update((document) => ({
        ...document,
        targets: [...document.targets, decodeTarget(bearerTarget("laptop"))],
      }));
      expect(Exit.isFailure(yield* Effect.exit(pairing))).toBe(true);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(raw);
    }),
  );

  it.effect("backs up an unreadable catalog and never replaces it with an empty one", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      yield* catalog.update((document) => ({ ...document, githubRoutingPermissions: [] }));

      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe("{not-json");
      expect(memory.values.get(CONNECTION_CATALOG_BACKUP_KEY)).toBe("{not-json");
      expect(memory.deleted).toEqual([]);
    }),
  );

  it.effect("writes nothing when secure storage cannot be read", () =>
    Effect.gen(function* () {
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: "{}" });
      const storage = MobileSecureStorage.MobileSecureStorage.of({
        ...memory.storage,
        getItem: (key) =>
          Effect.fail(
            new MobileSecureStorage.MobileSecureStorageError({
              operation: "read",
              key,
              cause: new Error("errSecInteractionNotAllowed"),
            }),
          ),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, storage),
      );

      expect(Exit.isFailure(yield* Effect.exit(catalog.read))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(catalog.update((document) => document)))).toBe(true);
      expect(memory.written).toEqual([]);
      expect(memory.deleted).toEqual([]);
    }),
  );

  it.effect("replaces and removes a corrupt legacy catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({ connections: [{ invalid: true }] }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([LEGACY_CONNECTIONS_KEY]);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
    }),
  );
});
