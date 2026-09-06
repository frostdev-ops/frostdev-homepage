import "./_setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../src/lib/users.ts";
import { getDb } from "../src/lib/db.ts";
import { getSession, afterLogin } from "../src/lib/auth.ts";
import { GET as runtimeBootstrap } from "../src/pages/api/runtime.ts";
import {
  beginDeviceAuth,
  approveDeviceAuth,
  pollDeviceAuth,
  deviceServerSession,
  deviceAuthorization,
} from "../src/lib/dev/device-auth.ts";
import {
  listDevices,
  revoke,
  allowedRelayPath,
} from "../src/lib/dev/devices.ts";

test("runtime bootstrap requires an authenticated user", async () => {
  const response = await runtimeBootstrap({ locals: {} } as Parameters<typeof runtimeBootstrap>[0]);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Sign in required." });
});

test("browser approval binds the initiating desktop, tokens are one-use, and revocation ends its server sessions", () => {
  const user = createUser("pair-flow@example.com", null),
    other = createUser("pair-other@example.com", null);
  const grant = beginDeviceAuth("My Mac", "darwin", 1),
    now = Date.now();
  assert.equal(
    pollDeviceAuth(grant.device_code, now).error,
    "authorization_pending",
  );
  assert.equal(pollDeviceAuth("wrong-secret", now).error, "expired_token");
  assert.equal(pollDeviceAuth(grant.device_code, now + 1).error, "slow_down");
  approveDeviceAuth(grant.user_code, user, true);
  assert.throws(() => approveDeviceAuth(grant.user_code, other, true));
  const paired = pollDeviceAuth(grant.device_code, now + 3100);
  assert.ok("token" in paired);
  if (!("token" in paired)) return;
  assert.equal(listDevices(other).length, 0);
  assert.equal(listDevices(user)[0]!.id, paired.id);
  assert.equal(
    pollDeviceAuth(grant.device_code, now + 6200).error,
    "expired_token",
  );
  const session = deviceServerSession(paired.token);
  assert.equal(getSession(session.id)?.userId, user);
  assert.throws(() => revoke(other, paired.id));
  assert.ok(getSession(session.id));
  revoke(user, paired.id);
  assert.equal(getSession(session.id), null);
  assert.throws(() => deviceServerSession(paired.token));
  assert.equal(
    JSON.stringify(getDb().prepare("SELECT * FROM devices").all()).includes(
      paired.token,
    ),
    false,
  );
});
test("declined and expired approvals cannot register a device, login continuation is a fixed path", () => {
  const user = createUser("denied-flow@example.com", null),
    g = beginDeviceAuth("Mac", "darwin", 1);
  approveDeviceAuth(g.user_code, user, false);
  assert.equal(pollDeviceAuth(g.device_code).error, "access_denied");
  assert.equal(listDevices(user).length, 0);
  const expired = beginDeviceAuth("Old", "darwin", 1);
  assert.equal(
    pollDeviceAuth(expired.device_code, Date.now() + 600001).error,
    "expired_token",
  );
  assert.throws(() => deviceAuthorization("https://evil.example"));
  for (const code of ["https://evil.example", "//evil.example", "ABCD-EF12"]) {
    let deleted = false;
    const target = afterLogin({
      get: () => ({ value: code }),
      delete: () => {
        deleted = true;
      },
    });
    assert.equal(
      target,
      code === "ABCD-EF12" ? "/desktop/connect?code=ABCD-EF12" : "/dash",
    );
    assert.equal(deleted, true);
  }
  for (const route of [
    "sign-in-start",
    "sign-in-poll",
    "sign-in-open",
    "sign-in-cancel",
    "folder",
    "onboard",
    "open-server",
  ])
    assert.equal(allowedRelayPath("/api/dev/" + route), false);
});
