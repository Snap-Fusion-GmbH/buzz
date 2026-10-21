# Private GitHub Repositories

GitHub remains the canonical source for code, repository access, PRs and CI.
Buzz projects can link to an external GitHub repository without mirroring its
contents into the relay.

## Desktop Workflow

Projects and the sidebar's Add project dialog expose **Add from GitHub**.
The connection uses the current person's installed GitHub CLI/keychain.
The account controls report missing CLI, sign-in, network failures and the
connected login, with sign-in, official CLI downloads and explicit retry.
On macOS, sign-in uses the existing Terminal `.command` launch pattern with a
private, self-removing script and an allowlisted environment, without adding
Apple Events automation permissions to the signed app.

The repository selector lists only the repositories visible to that account.
Managed builds restrict the selector and native Git operations to the compiled
`github_organization` in their public workspace configuration. Workspace sign-in
does not grant GitHub organization or repository permission.

Before import, the user explicitly consents to sharing the repository's name and
link with the current Buzz workspace. Import revalidates repository access,
stable ID and the consented URL/name before any Buzz write. Generation and
identity checks continue through discovery, signing and publication; switching
away and back also cancels the old operation. Imported projects default to
an unlisted project and private home channel; unlisted is discovery behavior,
not encryption or a promise to hide metadata from the relay operator.

The existing recoverable project bootstrap writes the project/repository
metadata and adds the project to the user's sidebar. Its clone/web URL remains
GitHub's. Repeating the same import opens the existing project rather than
creating a duplicate; an unrelated repository coordinate is never overwritten.

The Code surface reads GitHub refs, commits and files through authenticated Git.
Users can clone, fetch, create/delete branches, fast-forward pull and push local
commits. A failed remote check propagates instead of becoming an empty remote.
Push uses the checked commit SHA, not a later moving `HEAD`. GitHub branch
protection and write permissions remain authoritative.
Explicit Local selection survives pending branch-query results instead of
switching to the remote source during a local branch round trip.

## Credential Boundary

Buzz never returns a GitHub token to the renderer or puts one in project events.
The ephemeral native Git configuration invokes `gh auth git-credential` only
for the exact selected repository. GitHub processes do not receive Buzz identity
keys, inherited token overrides or Git debug/config-injection settings.
Managed operations reject an active community other than the configured
corporate relay. Account/repository query keys include workspace and identity.
Credentialed redirects are disabled, and Git output, deadlines and child process
trees use the existing bounded subprocess runner.

No GitHub credentials are copied to the relay, signing/deployment jobs or a
remote agent provider. Existing local agents can use the person's existing Git
authentication; Azure-hosted agents need a separately approved workload/GitHub
App credential design. Import does not add users to GitHub or synchronize
GitHub issues, PRs, project boards or ACLs.

## Agent Repository Context

Owner-attested agents discover both their own and their owner's project and
repository announcements through the CLI. An explicit `--owner` still narrows
the read, ambiguous project slugs require it, and mutation lookups remain bound
to the agent's own signing identity.

Unlisted projects remain unlisted. A project with an authoritative repository
binding to the agent's current channel supplies that channel's project context,
including its credential-free canonical clone URL. This is not a global
project listing or an inheritance of private channel membership.

Project chat includes the canonical clone URL and the known local checkout
path in its pre-send context preview. The same payload reaches the agent.
The agent must verify the path and its Git origin before editing; a path on
the sending desktop is not a promise that a remote machine has that checkout.

## Validation

The browser journey covers consent, access failure/retry, import into the real
project/sidebar/cache code, authenticated-source selection and clone/push UI.
Native tests cover exact credential scope, key/env isolation, strict URLs,
bounded subprocess output, ref parsing, repository discovery and failed remote
checks. A concurrent-HEAD test binds the production pusher.

The opt-in `private_github_round_trip` native test uses an explicitly selected
private organization repository and durable receipt path. It creates one
task-owned branch, commits a synthetic file, exercises the production pusher,
reads back the exact commit and deletes only that expected ref with a lease.
An ambiguous failure leaves a durable cleanup record. It never writes `main`.

Both managed builders execute the actual binary's
`--print-github-organization` probe before producing a distribution receipt;
the signer and Intune jobs never execute application code.

Related upstream report: `block/buzz#7426`. Public-only read work in PR `#6016`
does not solve private authentication. Closed broad proposals `#6196` and
`#7696` were inspected, not merged into this feature.
