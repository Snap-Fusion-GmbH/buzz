# Managed Workspace Builds

The Snap Fusion integration adds an opt-in Microsoft enrollment gate. Ordinary
Buzz builds retain their existing onboarding and relay behavior.

## Public Desktop Configuration

`BUZZ_BUILD_MANAGED_WORKSPACE` contains a JSON object with only:

- `workspace_id`
- `tenant_id`
- `desktop_client_id`
- `api_client_id`
- `base_url` (HTTPS origin)
- `relay_url` (WSS origin)

The build and runtime share one strict parser. A managed build rejects
`BUZZ_BUILD_AGENT_ENV`; provider credentials must not be compiled into desktop
artifacts. Identity and Microsoft session keyrings are separate and
workspace-scoped. Use a separate corporate bundle identifier when the managed
app must coexist with an existing personal installation.

Microsoft authorization uses a native PKCE loopback callback and the system
browser. Tokens remain native and in the OS keyring, not frontend IPC or
localStorage. Enrollment proves possession of the individual's Nostr key.
First login creates a profile from the verified work name only when a profile
does not already exist. A locked keyring uses the existing recovery UI.

## Relay Policy

`BUZZ_MANAGED_ACCESS` is an optional strict JSON object containing the
controller's canonical `controller_pubkey` and `membership_ttl_seconds`.

Startup requires all of the following:

- Relay membership enforcement is enabled.
- `RELAY_OWNER_PUBKEY` equals the controller.
- NIP-OA owner delegation is disabled.
- The lease is between 30 and 300 seconds.

Non-controller members need both a controller-issued `added_by` record and a
fresh `updated_at`. Ordinary invite rows and another member's grants cannot
substitute for directory enrollment. The controller renews a member lease with
the existing owner-signed kind 9032 command, preserving role `member`.

HTTP admission reads the writer's membership and clock together. Every relay
pod also checks its root and audio sockets every five seconds, under a
three-second total deadline. Expired, missing or unverifiable membership
closes the session. The pinned controller has no time expiry, but its current
owner membership must still exist. This backstop does not depend on the
controller process staying alive or Redis delivering a disconnect.

Channel administrative mutations on controller-created channels require the
controller. This prevents ordinary private-channel invitations, role changes,
visibility changes and archival from overriding directory policy. Independently
created private channels retain normal Buzz behavior.

## Database Ownership

Run migrations with a dedicated schema owner, not the relay runtime login.
`buzz-admin partition-maintain --months-ahead 6` uses the existing bounded
partition-maintenance implementation. Replacing an empty right-edge catch-all
requires the explicit `--advance-empty-catch-all` flag; nonempty unsafe layouts
still require operator intervention.

Run `buzz-admin partition-audit --months-ahead 6` afterward. A relay login
without DDL rights must have automatic partition creation and advancement
disabled. Schedule owner maintenance before its audited runway is exhausted.

## Acceptance

Focused tests cover expiry, enrollment provenance, source-channel authority,
writer-clock checks and root/audio cancellation. A real local relay exercise
also verifies authenticated reads, outsider denial, rejected manual source
invites, wall-clock WebSocket expiry and recovery after owner renewal.

These tests do not establish hosted storage compatibility, native Microsoft
sign-in, signing/notarization, Intune installation or human acceptance. Keep
the integration draft until the corresponding platform and live checks pass.
