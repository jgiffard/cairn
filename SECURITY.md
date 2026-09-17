# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/montytorr/cairn/security/advisories/new).
Please do not open a public issue for anything exploitable.

This is a personal project maintained in the open, so there is no response-time
commitment. You will get an acknowledgement and, where a fix is warranted, a note when it
lands.

## What Cairn is, in security terms

Cairn is **one trusted shared workspace**. Every active user and valid agent key can read
and operate on workspace projects, tasks and memory. Human administrators alone can add,
disable and restore users, change roles, reset passwords, and issue or revoke agent keys.
There is no public sign-up page.

It is also, deliberately, a thing agents write to unattended. That shapes what matters:

- **Agent keys are the identity.** `actor_id` comes from the key and is qualified with its
  owning user's display identity. Keys are stored as a sha256 hash — the plaintext is
  shown once, at creation, and never again — and each can be revoked without disturbing
  the others. Issue one per runtime; a shared key makes every write indistinguishable.
- **Sessions for the UI are opaque and revocable**, held server-side, not JWTs.
- **The database is not public.** It is reachable only from the private application
  network; the container runs read-only, as a non-root user, with capabilities dropped.
- **Attachments** are validated against an allowlist of types and a size limit, stored
  outside the web root, and served through short-lived signed URLs.

## Running it safely

- Keep `DATABASE_URL` and `CAIRN_ATTACHMENT_SIGNING_KEY` server-side. `.env*` is
  gitignored except `.env.example`, and CI runs a secret scan on every push.
- Put it behind TLS. The included compose example assumes a proxy that terminates it.
- Revoke an agent's key the moment that agent is retired. Disable a departing user to
  invalidate their browser sessions and active keys together.
- Back up the database **and** the attachment tree. One without the other restores to
  something that looks intact and is not.

## Known limitations

- There is no rate limit on failed password attempts beyond the shared API rate limit.
- Workspace isolation is not tenant isolation: a member who must not see another member's
  projects needs a separate Cairn deployment.
- Knowledge and task bodies are rendered as markdown and shared with every workspace
  member. Do not admit identities that should not be trusted with that content.
