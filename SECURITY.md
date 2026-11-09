# Security

## Reporting a vulnerability

Please don't open a public issue for security problems. Use GitHub's
**Report a vulnerability** button instead (repository *Security* tab → *Advisories*).
It reaches the maintainers privately. You'll get a reply within a few days, and
credit in the release notes if you'd like it.

## How Saw Forge protects you

- **Built in public.** Releases are built by GitHub Actions from this repository. Every file has a SHA-256 in `SHA256SUMS.txt` on the release page.
- **Reproducible app packages.** The same source always gives a byte-identical package, so anyone can rebuild one and compare checksums.
- **Verified installs.** Saw Forge Hub checks each app package against the SHA-256 in the catalog before unpacking it. If they don't match, nothing is installed.
- **Sandboxed apps.**
  - Apps run in sandboxed windows with no Node.js access.
  - They can only read and write their own folder in `Documents/Saw Forge`.
  - Links to other sites open in your browser, not in the app.
- **Permissions.** Microphone and MIDI are allowed only for Saw Forge apps. On macOS the system asks you first.
- **Network.** The hub connects only to GitHub: the release files, and the project's GitHub Pages site for the app catalog.
