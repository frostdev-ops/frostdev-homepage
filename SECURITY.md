# Security

Report a vulnerability privately through GitHub's **Report a vulnerability** button on this
repository's Security tab. Please do not open a public issue for it. You will get an answer
within a week, and a fix or a mitigation before any public disclosure.

Application data routes require an authenticated session. Public sign-in, device authorization
start/poll, one-shot desktop bootstrap, and OAuth callback routes have their own scoped
credentials and validation. The agent's outbound tools wait for a confirm; every host a user names
(webhooks, MCP servers, browser wards' pages) is resolved once and checked against the private
address ranges before it is connected to; browser wards run Chromium sandboxed unless the server
is root without `BROWSER_EXECUTABLE`; stored credentials are sealed with `TOKEN_ENC_KEY`.

The standalone desktop binds to loopback with authenticated bootstrap/native actions; being
on loopback is not authorization. Its database, project files, recovery buffers, terminal
screens, conversations, and integrations remain local. Encryption keys and pairing
credentials live in the OS credential store. Terminal environments exclude backend secrets.
Approved project roots constrain file operations, including symlinks. Biome runs with a
bundled configuration in a private temporary directory and never loads project plugins.

Remote clients authenticate to the server and select an owned, paired desktop. Both ends
authorize the relay; a server user ID never becomes a desktop user ID. Revocation closes
the connection and device-issued server sessions. An offline desktop cannot be edited or
continued remotely. The server handles plaintext content transiently over HTTPS/WSS; this
release does not provide end-to-end encryption against the server operator.

Deploy the [relay nginx configuration](ops/runtime-relay.nginx.conf), and disable payload
capture, cache overrides, disk buffering, and request-body reporting at every proxy/CDN.
Server backups must not contain desktop workspace content. No remote mutation or terminal
input is automatically replayed after an uncertain acknowledgement.

Native terminal agents run with the local user's filesystem access. Human is the default
permission mode. Only the user can configure delegated Rimeward control or a CLI's explicit
YOLO mode; the next start applies that policy. Shared-tree coordination is advisory, not a
filesystem sandbox. Dirty worktrees and unrelated edits must be preserved.
