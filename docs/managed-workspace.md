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

## Session Recovery

The enrollment gate checks workspace authorization every 15 seconds, with at
most one verification in flight. A failed check blocks the workspace; it never
falls back to an unmanaged relay or continues on cached authorization.

Temporary transport, token-renewal, rate-limit and workspace-service failures
retain the native Microsoft session and offer verification retry, not another
interactive sign-in. Verification retries automatically. A workspace `401`
triggers at most one silent token renewal before retrying the workspace request;
a fresh token still rejected by the service remains a verification failure.
A membership `403` is a separate access-denied state, not an expired login.
An enrollment-required response instead repeats challenge/proof enrollment with
the existing Microsoft session and the same Buzz identity, without a browser.
The controller marks this with `X-Buzz-Workspace-State: enrollment-required`;
the earlier API's exact missing-enrollment detail is also supported.

Interactive sign-in is offered for a missing, mismatched or damaged Microsoft
session, an explicit user retry of a failed login, or Microsoft's `invalid_grant`,
`interaction_required`, `login_required` or `consent_required` response.
Rotated refresh tokens are persisted in the existing workspace-scoped keyring.
Cancellation and identity changes still fence stale verification results.

The recovery tests use local HTTP token/workspace fixtures and a mocked OS
keyring, plus a mock-bridge UI journey across the five-minute boundary, outages,
membership denial, lost enrollment, automatic recovery and explicit
reauthentication. Session recovery never resets the Buzz identity. These are
not live Microsoft sign-in or tenant-policy acceptance.

## Relay Policy

`BUZZ_MANAGED_ACCESS` is an optional strict JSON object containing the
controller's canonical `controller_pubkey` and `membership_ttl_seconds`.
The optional `allow_owner_attested_agents` boolean defaults to `false`.

Startup requires all of the following:

- Relay membership enforcement is enabled.
- `RELAY_OWNER_PUBKEY` equals the controller.
- NIP-OA owner delegation is disabled.
- The lease is between 30 and 300 seconds.

When `allow_owner_attested_agents` is enabled, an agent may authenticate with
its own key and a cryptographically verified NIP-OA owner credential. The owner
must have a fresh, controller-issued membership lease in the same community.
The permanent controller cannot serve as a delegated human owner, and an agent
cannot delegate onwards using only its derived access. General
`BUZZ_ALLOW_NIP_OA_AUTH` remains disabled.

Agent access does not create a permanent roster grant, inherit the owner's
channel memberships, or permit changes to controller-managed channels. Private
channels and DMs still require the agent's own channel membership. HTTP requests
recheck the owner lease; root and audio sockets record the admitted owner and
are closed by the same bounded lease monitor when that owner expires or is
removed. Bans retain the existing owner-to-agent revocation behavior.

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
