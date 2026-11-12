# Agent Skills & Tools

Personal collection of agents, skills, and MCP server definitions for AI coding tools. For personal use only — not intended as a public or shared library. Tool-agnostic layout: each folder follows the de-facto conventions so consumers can map them into their native locations.

## Layout

```text
├── agents/                  # one Markdown file per agent (frontmatter: name, description, tools)
├── skills/                  # one directory per skill
│   └── <skill-id>/
│       ├── SKILL.md         # required; frontmatter: name, description
│       ├── scripts/         # optional supporting files, paths relative to this dir
│       └── references/
├── mcp/                     # optional per-server snippets for selective sharing
└── .mcp.json                # MCP server manifest (single source of truth)
```

## Conventions

- **Skills** — one directory per skill under `skills/`, named after the skill ID. IDs are lowercase kebab-case and match the folder name; keep them unique across the repo. Supporting files (`scripts/`, `references/`) live beside `SKILL.md`; paths written inside a skill are relative to its directory.
- **Agents** — one `.md` file per agent in `agents/`. Frontmatter carries at least `name` and `description`; tool-specific fields (model, permissions) may be added as needed by the consuming harness.
- **MCP** — server definitions live in `.mcp.json` under `mcpServers`. The optional `mcp/` folder holds per-server snippets for cherry-picking; `.mcp.json` stays canonical.

## Wiring into a project

No tool auto-discovers this exact layout, so map it per harness:

| Tool       | Skills                                        | Agents                          | MCP                                   |
| ---------- | --------------------------------------------- | ------------------------------- | ------------------------------------- |
| OpenCode   | `"skills": ["./skills"]` in `opencode.jsonc`, or symlink into `.opencode/skills/` | copy/symlink into `.opencode/agents/` (same Markdown + frontmatter format) | merge servers into `mcp.servers`      |
| Claude Code| symlink `skills/` → `.claude/skills/`         | copy into `.claude/agents/`    | reads `.mcp.json` natively            |

Example:

```sh
ln -s "$PWD/skills" .claude/skills   # or ~/.config/opencode/skills for global use
```

### Installing agents globally (OpenCode)

Agent discovery has no "extra directories" option, so copy from this repo into the global folder. This repo is canonical — re-copy after editing agents:

```sh
cp -r <path-to-agent-kit>/agents/* ~/.config/opencode/agents/
```
