# schema/

`science-card.schema.json` is the **canonical** definition of a Squad Science
Card for the cross-repo scientific-sessions effort tracked by squad#20
(companion issues: rjwalters/loom#6109, rjwalters/lean-genius#43705).

It is runtime-neutral JSON Schema (draft 2020-12) — no Claude- or
Codex-specific fields, and no fields tied to any single agent runtime.

## If you are Loom or Lean Genius

Vendor a copy of this file rather than independently defining your own Science
Card shape. When you copy it, add a comment (or adjacent note) recording the
`$id` and `version` it was copied from, so a later diff against this file can
detect drift. Building automated cross-repo sync/CI is explicitly out of scope
for squad#22 — this file is just built to be copied, with the identifying
metadata that makes divergence detectable.

## Versioning

`version` is a plain semver string at the schema root (not a standard JSON
Schema keyword — validate with `strict: false` if using a strict-mode
validator such as Ajv). Bump it on any breaking change to the card shape.
