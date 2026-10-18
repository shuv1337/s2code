import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthStandardClientScopes,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  ProjectId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";
import { watchClientScopes } from "./WatchAuth.ts";
import * as WatchHttp from "./WatchHttp.ts";

const layer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-watch-auth-test-" })),
);
const request = (token: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://localhost/api/watch/v1/threads", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
const issuer = { subject: "admin", scopes: AuthStandardClientScopes };
const client = { deviceType: "unknown" as const };

it.layer(NodeServices.layer)("Watch auth", (it) => {
  it.effect(
    "Watch middleware provides the receipt principal and restriction only for Watch bearers",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const grant = yield* auth.issueWatchPairingCredential({
          issuer,
          restriction: { projectIds: [] },
        });
        const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
          grant.credential,
          undefined,
          client,
        );
        const middleware = yield* EnvironmentAuthenticatedAuth;
        const handler = Effect.gen(function* () {
          const session = yield* WatchHttp.requireWatchSession.pipe(Effect.orDie);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          expect(principal.sessionId).toBe(session.sessionId);
          expect(session.restriction).toEqual({ projectIds: [] });
          return HttpServerResponse.empty({ status: 204 });
        });
        const options = {
          // HttpApiBuilder erases the invariant endpoint union at this boundary too.
          group: EnvironmentHttpApi.groups.watch as unknown as HttpApiGroup.Top,
          endpoint: EnvironmentHttpApi.groups.watch.endpoints.capabilities,
        };
        const response = yield* middleware(handler, options).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request(token.access_token)),
        );
        expect(response.status).toBe(204);
        const ordinary = yield* auth.issueSession();
        expect(
          yield* middleware(handler, options).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request(ordinary.token)),
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "EnvironmentAuthInvalidError" });
      }).pipe(
        Effect.provideService(HttpServerRequest.ParsedSearchParams, {}),
        Effect.provideService(HttpRouter.RouteContext, {
          params: {},
          route: HttpRouter.route("GET", "/api/watch/v1/capabilities", HttpServerResponse.empty()),
        }),
        Effect.provide(WatchHttp.layerAuthenticatedAuth.pipe(Layer.provideMerge(layer))),
      ),
  );

  it.effect(
    "round-trips restrictions, isolates the audience, and revokes through ordinary sessions",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const restriction = {
          threadIds: [ThreadId.make("thread-a")],
          projectIds: [ProjectId.make("project-a")],
        };
        const grant = yield* auth.issueWatchPairingCredential({ issuer, restriction });
        expect(grant.subject).toBe("watch-client");
        expect(grant.scopes).toEqual(watchClientScopes);
        expect(
          yield* auth.createBrowserSession(grant.credential, client).pipe(Effect.flip),
        ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
        expect(
          yield* auth
            .consumeMcpApprovalCode(grant.credential, "approval-required")
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "ServerAuthMcpApprovalCodeError" });
        expect(
          yield* auth
            .exchangeBootstrapCredentialForAccessToken(grant.credential, undefined, client, {
              proofKeyThumbprint: "key",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
        const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
          grant.credential,
          undefined,
          client,
        );
        const session = yield* auth.authenticateWatchClient(request(token.access_token));
        expect(session.restriction).toEqual(restriction);
        expect(session.subject).toBe("watch-client");
        expect(session.scopes).toEqual(watchClientScopes);
        expect(session.method).toBe("bearer-access-token");
        expect(
          yield* auth
            .exchangeBootstrapCredentialForAccessToken(grant.credential, undefined, client)
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
        const ticket = yield* sessions.issueWebSocketToken(session.sessionId);
        const wsRequest = HttpServerRequest.fromWeb(
          new Request(`http://localhost/ws?wsTicket=${ticket.token}`),
        );
        for (const attempt of [
          auth.authenticateHttpRequest(request(token.access_token)).pipe(Effect.asVoid),
          auth.authenticateWebSocketUpgrade(wsRequest).pipe(Effect.asVoid),
          auth.authenticateMcpClient(request(token.access_token)).pipe(Effect.asVoid),
        ]) {
          expect(yield* attempt.pipe(Effect.flip)).toMatchObject({
            _tag: "ServerAuthInvalidCredentialError",
          });
        }
        expect(yield* auth.revokeSession(session.sessionId)).toBe(true);
        for (const attempt of [
          auth.authenticateWatchClient(request(token.access_token)),
          auth.authenticateHttpRequest(request(token.access_token)),
          auth.authenticateWebSocketUpgrade(wsRequest),
        ]) {
          expect(yield* attempt.pipe(Effect.flip)).toMatchObject({
            _tag: "ServerAuthInvalidCredentialError",
          });
        }
      }).pipe(Effect.provide(layer)),
  );

  it.effect("requires every Watch scope from the issuer to mint Watch grants", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const grant = yield* auth.issueWatchPairingCredential({
        issuer: { subject: "ordinary", scopes: watchClientScopes },
      });
      expect(grant.scopes).toEqual(watchClientScopes);
      for (const scopes of [
        ["orchestration:read"] as const,
        ["orchestration:operate"] as const,
        ["access:write"] as const,
      ]) {
        expect(
          yield* auth
            .issueWatchPairingCredential({ issuer: { subject: "ordinary", scopes } })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "ServerAuthScopeNotGrantedError" });
      }
    }).pipe(Effect.provide(layer)),
  );

  // Default pairings now carry access and relay management. A Watch credential
  // minted from one, or exchanged asking for them, still gets only Watch's scopes.
  it.effect("caps Watch credentials at Watch scopes whatever the issuer or request holds", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const grant = yield* auth.issueWatchPairingCredential({
        issuer,
        restriction: { threadIds: [ThreadId.make("thread-a")] },
      });
      expect(grant.scopes).toEqual(watchClientScopes);
      const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
        grant.credential,
        [...AuthStandardClientScopes],
        client,
      );
      expect(token.scope.split(" ").toSorted()).toEqual([...watchClientScopes].toSorted());
      const session = yield* auth.authenticateWatchClient(request(token.access_token));
      expect(session.scopes).toEqual(watchClientScopes);
      expect(session.restriction).toEqual({ threadIds: [ThreadId.make("thread-a")] });
      expect(
        yield* auth
          .issueWatchPairingCredential({
            issuer: { subject: session.subject, scopes: AuthStandardClientScopes },
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "ServerAuthScopeNotGrantedError" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses MCP and ordinary bearer sessions and preserves empty restrictions", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const mcp = yield* auth.issueMcpClientSession({
        label: "MCP",
        access: "full-access",
        peerLink: false,
        client,
      });
      const ordinary = yield* auth.issueSession();
      for (const token of [mcp.token, ordinary.token]) {
        expect(yield* auth.authenticateWatchClient(request(token)).pipe(Effect.flip)).toMatchObject(
          { _tag: "ServerAuthInvalidCredentialError" },
        );
      }
      const grant = yield* auth.issueWatchPairingCredential({
        issuer,
        restriction: { threadIds: [] },
      });
      const tampered = grant.credential.slice(0, -1) + (grant.credential.endsWith("A") ? "B" : "A");
      expect(
        yield* auth
          .exchangeBootstrapCredentialForAccessToken(tampered, undefined, client)
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
      const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
        grant.credential,
        undefined,
        client,
      );
      expect(
        (yield* auth.authenticateWatchClient(request(token.access_token))).restriction,
      ).toEqual({ threadIds: [] });
    }).pipe(Effect.provide(layer)),
  );
});

it.effect("rejects Watch and MCP RPC subjects even with sufficient scopes", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.assetsCreateUrl
        > => tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = false;
    for (const subject of ["watch-client", "mcp-client"]) {
      const rpc = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
              Effect.sync(() => {
                handled = true;
                return { relativeUrl: "/file", expiresAt: 1 };
              }),
            ),
            RpcAuthorization.layer(watchClientScopes, subject),
          ),
        ),
      );
      expect(
        yield* rpc[WS_METHODS.assetsCreateUrl]({
          resource: { _tag: "attachment", attachmentId: "image" },
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
    }
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);
