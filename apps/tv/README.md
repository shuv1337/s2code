# S2Code Apple TV

A read-only tvOS dashboard for one or more paired servers. It shares `T3WatchKit`
(`packages/watch-native`) with the Watch, so it uses the same `/api/watch/v1`
HTTP API and device-code pairing, and it never submits commands.

The paired credential is a normal Watch session. It can read threads and operate
them. This app never submits a command, but the token in the keychain can: anyone
who copies it can drive that server. The token is sent as a bearer header.

Plain HTTP is allowed only on the local network: private and link-local
addresses, loopback, `.local`, and single-label names. On those networks the
bearer token is visible to anyone on the path. Every other host, including a
tailnet name, must be HTTPS. `s2code pair --tailscale` publishes an HTTPS address.

```sh
cd apps/tv
xcodegen generate
xcodebuild build -project S2CodeTV.xcodeproj -scheme S2CodeTV \
  -destination 'platform=tvOS Simulator,name=<your Apple TV simulator>' \
  -derivedDataPath build/DD \
  DEVELOPMENT_TEAM=YOUR_TEAM CODE_SIGN_IDENTITY=-
```

`DEVELOPMENT_TEAM` is not committed. Pass your team as above, or export
`S2CODE_DEVELOPMENT_TEAM` before `xcodegen generate`. Build with signing, even
ad hoc, because an unsigned build cannot use the keychain. In the simulator,
launch with `-S2CodeTVPairOrigin http://host:port` to pair that origin (or add
it as another server) without the tvOS keyboard. Approve the code shown on
screen with `s2code pair --watch --approve CODE`.
