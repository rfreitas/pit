# pit Agent Instructions

Read the pit-dev skill before making changes: `.pi/skills/pit-dev/SKILL.md`

## Before touching each area

| Area | Read first |
|---|---|
| `core/` | `pit/core/README.md` |
| `escape/` | `pit/escape/README.md` |
| `extensions/` | `pit/extensions/README.md` |
| `eslint-rules/` | `eslint-rules/README.md` |

## After any change

```bash
npm run typecheck   # must pass
npm run lint        # must pass — zero errors
npm test            # must pass
```

## Writing docs

Be concise, factual, and to the point. README.md is authoritative. AGENTS.md points to it — no duplication.
