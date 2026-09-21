# docs

Pages and specs that travel with the engine.

| File | What it is |
| --- | --- |
| `PREMORTEM.md` | Production pre-mortem (2026-09-21). Harsh, file-level findings for Claude Code / Grok hand-off. Fix P0 before wiring agents on `ask().action`. |
| `decisions-not-just-answers.html` | Why JDE exists, told for someone deciding whether to use it. The measured numbers, the "ask small questions" finding, and what it looks like from a customer's side. Published at [artifacts.semfreak.dev](https://artifacts.semfreak.dev/a/titanium-bot/jde-decisions-8eefb1de/). |
| `five-decisions-spec.html` | The implementation spec for five decisions ported from a prompt-heavy plugin into JDE: task restatement, an ask gate, claim labelling, room hygiene, and a playbook router. Published [here](https://artifacts.semfreak.dev/a/titanium-bot/pstack-spec-ce9efc79/). |

Both HTML pages are single files with no external requests, so they open from disk.

`../DESIGN.md` is the contract, `../USAGE.md` is how to call it, and `../cases/` holds the case sets. Every blind set in that folder was written by an author who never saw the questions it grades.
