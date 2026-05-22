# pit Agent Instructions

Read the pit-dev skill before making changes: `.pi/skills/pit-dev/SKILL.md`

## Before touching each area

| Area | Read first |
|---|---|
| `core/` | `pit/src/core/README.md` |
| `escape/` | `pit/src/escape/README.md` |
| `extensions/` | `pit/src/extensions/README.md` |
| `eslint-rules/` | `eslint-rules/README.md` |

## After any change

```bash
npm run typecheck   # must pass
npm run lint        # must pass — zero errors
npm test            # must pass
```

## Writing docs

Be concise, factual, and to the point. README.md is authoritative. AGENTS.md points to it — no duplication.
