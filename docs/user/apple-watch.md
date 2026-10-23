# Apple Watch

Fork mobile/watch distributions are not available yet. These steps apply only
to a fork app built from source; do not install an upstream app as a substitute.

T3 Watch lets you record an instruction, review its transcript, and send it to an
existing thread. The iPhone companion must include T3 Watch, and each connected
server must support the Watch API.

## Connect a server

Open T3 Watch and enter the server's URL. Choose **Pair**, then approve the code
on that server with `s2code pair --watch --approve CODE`. Pairing creates a separate
Watch session; removing the environment from Watch does not revoke that session
on the server.

Use **Environments** at the bottom of the thread list to add or switch servers.
Each environment keeps its own drafts, pins, and recent threads.

Choose **iPhone** as the connection route for a private server reached through
Tailscale on your phone. The paired iPhone must be available, have S2Code
installed, and be able to reach the server. **Direct** connects from Watch.
**Automatic** uses the phone when available, otherwise it tries a direct
connection. If a request loses its connection, it is not automatically sent
again over another route.

## Record an instruction

Open a thread, tap **Record**, then stop when finished. The selected server
transcribes the recording locally. First use downloads its speech model and may
take several minutes; transcription currently supports English.

Review the transcript before sending. **Send** starts work on an idle thread,
**Steer** redirects an active turn when supported, and **Queue** saves an
instruction for later. A saved recording can be retried if transcription fails.

The receipt shows whether the server committed the instruction. If delivery is
unknown, check the same receipt again; retry keeps the original command ID.
