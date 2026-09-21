// Build the playbook catalog for JDE decision E (playbook-route) from the REAL product data.
// Source: source/shared/marketplace/bots/bots.json in the gb repo -- the community pack a customer
// actually installs. Nothing here is invented; every id, title and description is a real row.
import { readFileSync } from "node:fs";

const SRC = process.argv[2];
const rows = JSON.parse(readFileSync(SRC, "utf8"));

// Four roles with enough real depth to produce the near-miss pairs the brief asks for.
// Engineering and Product are deliberately excluded: their richest bot carries 3 and 5 playbooks,
// which cannot support "two playbooks that share a domain" without inventing one.
const ROLES = {
  sales:      ["Account Research Desk", "Customer Proof Desk", "Call Follow-Ups"],
  marketing:  ["Ad Spend Watch", "AI Search Visibility", "Event Producer"],
  operations: ["Event Request Desk", "Office Ops Desk", "Alfred"],
  recruiting: ["Talent Discovery", "Recruiting Coordinator"],
};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

const out = [];
const seen = new Set();
for (const [role, botNames] of Object.entries(ROLES)) {
  for (const botName of botNames) {
    const bot = rows.find((r) => r.name === botName);
    if (!bot) throw new Error(`no bot named ${botName}`);
    for (const skill of bot.skills ?? []) {
      const title = String(skill.name ?? "").trim();
      if (!title) continue;
      const id = slug(title);
      const key = `${role}:${id}`;
      if (seen.has(key)) continue;       // "Getting started" ships on every bot
      seen.add(key);
      out.push({
        id,
        title,
        role,
        bot: botName,
        description: String(skill.description ?? "").trim(),
      });
    }
  }
}

const byRole = {};
for (const e of out) (byRole[e.role] ??= []).push(e.id);

console.log(JSON.stringify({
  note: [
    "Playbook catalog for JDE decision E (playbook-route).",
    "Taken verbatim from the Titanium Bot community pack, source/shared/marketplace/bots/bots.json.",
    "There is no step list, and that is not an omission. Every one of the 277 playbooks in the pack",
    "ships as a title plus the one-line 'use when' summary below and nothing else. The product",
    "generates three placeholder steps at import and says in the document itself that they are the",
    "shape of a job and not the job. Handing those steps to a case author would measure our filler.",
    "The description line IS the routing signal in production, so it is the whole catalog entry.",
  ].join(" "),
  roles: Object.fromEntries(Object.entries(byRole).map(([r, ids]) => [r, ids.length])),
  playbooks: out,
}, null, 2));
