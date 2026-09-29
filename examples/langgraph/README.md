# JDE with LangGraph

A worker node loops with its tools, then a `verify` node runs `completionCheck` on the tool calls
in the conversation and the files the tool wrote. On `partial` or `not_done` it routes back to the
worker with the missing parts named; on `done`, or when the judge could not answer, it ends.

```bash
pip install jebadiah-decide && jeb serve   # the judge, in another terminal
npm install
OPENAI_API_KEY=... npm start              # without a key it prints the graph as Mermaid
npm run typecheck
```

Needs Node 22.18 or later, which runs the `.ts` file directly.
