# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/glkmuu/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/glkmuu/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free static site generator written from scratch: `solve.js` exports `run(input)`, which builds one site's output tree — every page's `index.html`, the index and tag pages, `build-report.txt` and each static file — byte-identical to the reference generator's answer for the same input. `main.ts` is the harness driver: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

## Model

Single-pass, allocation-light rendering: front matter is scanned line by line from the front of each source, Markdown blocks render straight into a joined output array (no token list, no per-line regular expressions), inline markup is scanned by index with plain runs escaped in bulk, slugs are cached per case with a fast ASCII path, and templates are compiled once per case into a small node tree. Templates that only read `site`, `tags` and `recent` render the same for every page, so each is rendered once per case and reused. Nothing is cached between cases; the same input bytes always produce the same output bytes. No network, no dependencies beyond the Node standard library, no WebAssembly or native code.

## Run it

```sh
node main.ts
```

Outside the harness container, point it at the practice set with:

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Requires Node 22.

## License

MIT — see [LICENSE](LICENSE).

---

<sub>Entered on [make.fun](https://make.fun/?ref=cxvrx67h&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
