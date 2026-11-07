# Security policy

## Reporting a vulnerability

Report it privately: on this repository, open **Security → [Report a vulnerability](https://github.com/hht/syncline/security/advisories/new)**. Please don't open a public issue.

Include what you found, how to reproduce it, and its impact.

## Scope

In scope are flaws in Syncline itself, such as:

- a token reaching rows of a space or bucket it does not grant;
- a write lost, or applied twice;
- a device that stops syncing for good;
- a request getting past a limit in [Limits](docs/reference/limits.md);
- a crafted request breaking a space for its owner.

Out of scope is what your app owns:

- issuing tokens, and which space or buckets your `verify` grants;
- what your code does in `mutate`, `resubmit`, `scheduled`, and exporters;
- access that lasts until a token expires, and rate limiting the sync route (see [Security](docs/reference/api.md#security) in the API).

## Supported versions

Fixes ship in a new release. Check the latest release before reporting.
