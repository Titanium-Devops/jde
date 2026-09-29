# Releasing JDE to npm

The package is `jde` on npm, and it ships the library and the `jde-mcp` MCP server. It was chosen
on 2026-09-29, when the name was free. If npm refuses `jde` as too close to an existing name, use
`jev-decision-engine` instead, and change the `name` in package.json, `npm i jde` in the README
Quickstart and `-p jde` in the README, USAGE.md and `examples/mcp`.

## Before publishing

On a machine with Ollama, llama.cpp 0.5.0 or later and `jeb` (`pip install jebadiah-decide`):

```bash
git checkout master && git pull
npm ci
npm test                          # must end with "fail 0"
scripts/verify-all.sh             # must end with "every committed result reproduced"
npm pack --dry-run                # dist/ (with dist/mcp), policy.json, README, LICENSE, USAGE, DESIGN; nothing else
```

Do not publish if either check fails.

## Publish

The npm token is in Bitwarden, item "AI API Keys", field `NPM_TOKEN` (a granular token with
publish rights). It goes into a throwaway npmrc, never into the repo or `~/.npmrc`:

```bash
export BW_SESSION="$(cat ~/.bw-session)"
NPMRC="$(mktemp)"; chmod 600 "$NPMRC"
bw get item "AI API Keys" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=JSON.parse(s).fields.find(x=>x.name==="NPM_TOKEN");process.stdout.write("//registry.npmjs.org/:_authToken="+f.value+"\n")})' > "$NPMRC"
npm whoami --userconfig "$NPMRC"
npm publish --access public --userconfig "$NPMRC"   # prepublishOnly runs npm test again
rm -f "$NPMRC"
```

Never run `bw lock` or `bw logout` afterwards.

## After publishing

In an empty directory, with nothing installed:

```bash
npm view jde version                          # the version just published
npx -y -p jde jde-mcp < /dev/null             # starts and exits cleanly on end of input
npm i jde && node -e 'import("jde").then(m => console.log(typeof m.completionCheck))'   # function
```

Then tag the release: `git tag v<version> && git push origin v<version>`.

## A new version

Bump `version` in package.json in its own pull request, run the checks above on the merged
master, then publish. A change to a question's wording in `src/decisions/completion-check.ts`
changes every measurement: rerun `npm run eval:local` for each committed model and runtime and
commit the new results before releasing.
