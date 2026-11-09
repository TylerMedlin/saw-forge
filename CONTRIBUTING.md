# Contributing to Saw Forge

Thanks for helping! Bug reports, ideas, presets, docs and code are all welcome.

## Reporting a problem

[Open an issue](../../issues). Include your operating system and version, what you did, and what happened. Screenshots or a short recording help a lot.

## Working on the code

- **Saw Forge Studio** (the music app) is plain JavaScript in `src/`, `styles/` and `index.html`.
  - To run it, use `python serve.py` and open `http://127.0.0.1:8765`.
  - Tests run at `http://127.0.0.1:8765/tests/`.
- **Saw Forge Hub** (the desktop app and installers) is in `desktop/`.
  - Setup: `npm ci`, `npm run pack-apps`, then `npm start`.
  - Check your change with `npm run selftest`.
- **The website** is static HTML in `site/`.
- How releases work: [`docs/RELEASING.md`](docs/RELEASING.md).

Please keep changes focused, explain the *why* in your pull request, and run the tests that cover what you touched.

## License

Saw Forge is licensed under the GNU General Public License v3 or later. By contributing, you agree that your contributions are licensed under the same terms.
