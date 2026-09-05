# Security

Report a vulnerability privately through GitHub's **Report a vulnerability** button on this
repository's Security tab. Please do not open a public issue for it. You will get an answer
within a week, and a fix or a mitigation before any public disclosure.

What the app already assumes: every route but the splash, the login and the OAuth callbacks
needs a session; the agent's outbound tools wait for a confirm; every host a user names
(webhooks, MCP servers, browser wards' pages) is resolved once and checked against the private
address ranges before it is connected to; browser wards run Chromium sandboxed unless the server
is root without `BROWSER_EXECUTABLE`; stored credentials are sealed with `TOKEN_ENC_KEY`.
