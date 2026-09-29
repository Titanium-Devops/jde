# JDE with the OpenAI Agents SDK

An agent writes a file and answers a question; its last step is `completionCheck` on the run's
real tool calls and files. When the verdict is `partial` or `not_done`, it gets the conversation
back with the missing parts named and tries again, up to three times.

```bash
pip install jebadiah-decide && jeb serve   # the judge, in another terminal
npm install
OPENAI_API_KEY=... npm start              # without a key it only says what it needs
npm run typecheck
```

Needs Node 22.18 or later, which runs the `.ts` file directly.
