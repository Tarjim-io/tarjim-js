# Security

Please report a vulnerability privately through GitHub: **Security → Report a vulnerability** on this repository.
Do not open a public issue for it.

Include what you found, how to reproduce it, and the version of the file. We aim to acknowledge a report within
three working days and to keep you informed until it is resolved.

In scope: anything that could expose an API key, serve text that does not match a release's hashes, insert a
translated value into a page as HTML, or break a page that uses the client.

**A fix never reaches a copy you host until you replace it.** `tarjim-reference.js` is downloaded and served from
your own site, so it never updates itself. Watch this repository's releases (**Watch → Custom → Releases**) to learn
of fixes, and compare the file you host with the sha256 in the release notes.
