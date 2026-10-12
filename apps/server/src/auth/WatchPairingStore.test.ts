import {
  EnvironmentAuthenticatedAuth,
  EnvironmentHttpApi,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WatchPairingStartResponse,
  WatchPairingTokenResponse,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import * as HttpServer from "effect/http/HttpServer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WatchHttp from "../watch/http.ts";
import * as WatchService from "../watch/WatchService.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as WatchPairingStore from "./WatchPairingStore.ts";

const layerStore = WatchPairingStore.layer.pipe(
  Layer.provideMerge(PairingGrantStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-watch-pairing-test-" })),
  Layer.merge(TestClock.layer()),
);

const environmentId = EnvironmentId.make("watch-pairing-test");
const layerHttp = WatchHttp.layer.pipe(
  Layer.provide(Layer.mock(WatchService.WatchService)({})),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({
        environmentId,
        label: "Studio Mac",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "test",
        capabilities: { repositoryIdentity: true },
      } as const),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(EnvironmentAuthenticatedAuth, () =>
      Effect.die("Pairing routes must not authenticate"),
    ),
  ),
  Layer.provide(HttpServer.layerServices),
  Layer.provideMerge(layerStore),
);

const encodeStart = Schema.encodeSync(WatchPairingStartResponse);
const encodeToken = Schema.encodeSync(WatchPairingTokenResponse);
const restriction = {
  threadIds: [ThreadId.make("thread-1")],
  projectIds: [ProjectId.make("project-1")],
};

it.layer(NodeServices.layer)("WatchPairingStore", (it) => {
  it.effect("hands out a restricted watch credential exactly once after approval", () =>
    Effect.gen(function* () {
      const pairing = yield* WatchPairingStore.WatchPairingStore;
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const started = yield* pairing.start({ clientLabel: "  Wrist  " });
      expect(started.userCode).toMatch(
        /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/,
      );
      expect(started.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(started.interval).toBe(5);
      expect(DateTime.formatIso(started.expiresAt)).toBe("1970-01-01T00:10:00.000Z");

      expect(yield* pairing.poll({ deviceCode: started.deviceCode })).toEqual({
        status: "pending",
      });

      const approved = yield* pairing.approve({ userCode: started.userCode, restriction });
      expect(approved.clientLabel).toBe("Wrist");
      expect(approved.restriction).toEqual(restriction);
      expect(DateTime.formatIso(approved.expiresAt)).toBe("1970-01-01T00:15:00.000Z");

      yield* TestClock.adjust(Duration.seconds(5));
      const token = yield* pairing.poll({ deviceCode: started.deviceCode });
      if (token.status !== "approved") throw new Error(`Expected approval, got ${token.status}`);
      expect(token.credential.startsWith("watch.")).toBe(true);
      expect(DateTime.formatIso(token.expiresAt)).toBe("1970-01-01T00:15:00.000Z");

      const grant = yield* grants.consume(token.credential, { purpose: "watch" });
      expect(grant.subject).toBe("watch-client");
      expect(grant.watchRestriction).toEqual(restriction);
      expect(grant.label).toBe("Wrist");

      const replay = yield* Effect.flip(pairing.poll({ deviceCode: started.deviceCode }));
      expect(replay).toMatchObject({ _tag: "WatchPairingError", code: "pairing_not_found" });
    }).pipe(Effect.provide(layerStore)),
  );

  it.effect("answers polls faster than the interval with a growing, persisted slow_down", () =>
    Effect.gen(function* () {
      const pairing = yield* WatchPairingStore.WatchPairingStore;
      const sql = yield* SqlClient.SqlClient;
      const { deviceCode } = yield* pairing.start({});
      expect(yield* pairing.poll({ deviceCode })).toEqual({ status: "pending" });
      expect(yield* pairing.poll({ deviceCode })).toEqual({ status: "slow_down", interval: 10 });
      yield* TestClock.adjust(Duration.seconds(5));
      expect(yield* pairing.poll({ deviceCode })).toEqual({ status: "slow_down", interval: 15 });
      yield* TestClock.adjust(Duration.seconds(15));
      expect(yield* pairing.poll({ deviceCode })).toEqual({ status: "pending" });
      yield* TestClock.adjust(Duration.seconds(14));
      expect(yield* pairing.poll({ deviceCode })).toEqual({ status: "slow_down", interval: 20 });
      const rows = yield* sql<{ readonly interval: number }>`
        SELECT poll_interval_seconds AS "interval" FROM auth_watch_pairing_requests
      `;
      expect(rows).toEqual([{ interval: 20 }]);
    }).pipe(Effect.provide(layerStore)),
  );

  it.effect("reports expiry, denial, and unknown device codes", () =>
    Effect.gen(function* () {
      const pairing = yield* WatchPairingStore.WatchPairingStore;
      const expiring = yield* pairing.start({});
      const denied = yield* pairing.start({});

      expect(yield* pairing.deny({ userCode: denied.userCode })).toEqual({
        userCode: denied.userCode,
      });
      expect(yield* pairing.poll({ deviceCode: denied.deviceCode })).toEqual({ status: "denied" });
      const approveDenied = yield* Effect.flip(
        pairing.approve({ userCode: denied.userCode, restriction: {} }),
      );
      expect(approveDenied).toMatchObject({ reason: "not_pending" });

      yield* TestClock.adjust(Duration.minutes(10));
      expect(yield* pairing.poll({ deviceCode: expiring.deviceCode })).toEqual({
        status: "expired",
      });
      const approveExpired = yield* Effect.flip(
        pairing.approve({ userCode: expiring.userCode, restriction: {} }),
      );
      expect(approveExpired).toMatchObject({ reason: "expired" });
      expect(approveExpired.message).toContain("has expired");

      const unknown = yield* Effect.flip(pairing.poll({ deviceCode: "not-a-device-code" }));
      expect(unknown).toMatchObject({ _tag: "WatchPairingError", code: "pairing_not_found" });
      const unknownApproval = yield* Effect.flip(
        pairing.approve({ userCode: "2222-2222", restriction: {} }),
      );
      expect(unknownApproval).toMatchObject({ reason: "unknown" });
    }).pipe(Effect.provide(layerStore)),
  );

  it.effect("rate limits the 21st pending request until older ones expire", () =>
    Effect.gen(function* () {
      const pairing = yield* WatchPairingStore.WatchPairingStore;
      for (let index = 0; index < 20; index += 1) yield* pairing.start({});
      const limited = yield* Effect.flip(pairing.start({}));
      expect(limited).toMatchObject({ _tag: "WatchPairingError", code: "pairing_rate_limited" });
      expect(yield* pairing.listPending()).toHaveLength(20);

      yield* TestClock.adjust(Duration.minutes(10));
      expect(yield* pairing.listPending()).toEqual([]);
      yield* pairing.start({});
    }).pipe(Effect.provide(layerStore)),
  );

  it.effect("accepts user codes in any case, with or without the hyphen", () =>
    Effect.gen(function* () {
      const pairing = yield* WatchPairingStore.WatchPairingStore;
      const lower = yield* pairing.start({});
      const compact = yield* pairing.start({});
      const listed = yield* pairing.listPending();
      expect(listed.map((request) => request.userCode).toSorted()).toEqual(
        [lower.userCode, compact.userCode].toSorted(),
      );
      expect(listed[0]?.clientLabel).toBe("T3 Watch");

      const approvedLower = yield* pairing.approve({
        userCode: lower.userCode.toLowerCase(),
        restriction: {},
      });
      expect(approvedLower.userCode).toBe(lower.userCode);
      const approvedCompact = yield* pairing.approve({
        userCode: compact.userCode.replace("-", ""),
        restriction: {},
        label: "Owner's watch",
      });
      expect(approvedCompact.userCode).toBe(compact.userCode);
      expect(yield* pairing.listPending()).toEqual([]);
    }).pipe(Effect.provide(layerStore)),
  );

  it.effect("serves both unauthenticated pairing routes with the frozen wire shapes", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(EnvironmentHttpApi, ["watch"]);
      const pairing = yield* WatchPairingStore.WatchPairingStore;
      const started = yield* client.watch.pairingStart({
        payload: { protocolVersion: 1, clientLabel: "Ultra" },
      });
      const startJson = encodeStart(started);
      expect(startJson).toEqual({
        deviceCode: started.deviceCode,
        userCode: started.userCode,
        expiresAt: "1970-01-01T00:10:00.000Z",
        interval: 5,
        environment: { id: "watch-pairing-test", label: "Studio Mac" },
      });

      const poll = () =>
        client.watch
          .pairingToken({ payload: { protocolVersion: 1, deviceCode: started.deviceCode } })
          .pipe(Effect.map(encodeToken));
      expect(yield* poll()).toEqual({ status: "pending" });
      expect(yield* poll()).toEqual({ status: "slow_down", interval: 10 });

      yield* pairing.approve({ userCode: started.userCode, restriction: {} });
      const approved = yield* poll();
      expect(approved).toEqual({
        status: "approved",
        credential: expect.stringMatching(/^watch\./),
        expiresAt: "1970-01-01T00:15:00.000Z",
      });

      const consumed = yield* Effect.flip(poll());
      expect(consumed).toMatchObject({ _tag: "WatchRequestError", code: "pairing_not_found" });
    }).pipe(Effect.provide(Layer.merge(layerHttp, HttpServer.layerServices))),
  );
});
