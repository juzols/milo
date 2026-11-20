# Milo

**Milo** is an AI-powered coding agent that runs directly in your terminal. It can explore your codebase, edit files, execute commands, and manage multi-step tasks through natural language.

## Features

- **AI-powered coding** — Understand, modify, and create code.
- **Tool usage** — Read, edit, search files, and execute shell commands.
- **Session management** — Save, resume, and browse conversations.
- **Project context** — Persistent project instructions and memory.
- **Todo management** — Track progress across multi-step tasks.
- **Action approval** — Review actions before execution, with optional auto-approval.
- **Model selection** — Switch between AI models through Vercel AI Gateway.
- **Undo** — Revert the last action.
- **Streaming responses** — Get responses in real time.

## Requirements

- [Bun](https://bun.sh/)
- A [Vercel AI Gateway](https://vercel.com/ai-gateway) API key

## Installation

```bash
git clone https://github.com/juzols/milo.git
cd milo
bun install
```

## Add to PATH

To run `milo` from anywhere in your terminal, you must manually add its executable directory to your system's PATH.

For example, if your executable is located in `~/.local/bin/milo`, add the following to your shell configuration (`~/.bashrc` or `~/.zshrc`):

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Reload your shell configuration:

```bash
source ~/.bashrc
```

Make sure the executable has permission to run:

```bash
chmod +x ~/.local/bin/milo
```

You can now launch Milo from any directory:

```bash
milo
```

## Usage

Start an interactive session:

```bash
milo
```

Run a single prompt:

```bash
milo -p "Explain this codebase"
```

Resume the last session:

```bash
milo -c
```

Select a model:

```bash
milo --model openai/gpt-4.1
```

Automatically approve actions:

```bash
milo -y
```

## Commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/clear` | Start a new conversation |
| `/context` | Display project context |
| `/init` | Regenerate project context |
| `/sessions` | List previous sessions |
| `/todo` | Show current tasks |
| `/undo` | Undo the last action |
| `/cost` | Display session token usage |
| `/model <name>` | Change the AI model |
| `/exit` | Exit Milo |

## Project Data

Milo automatically creates a `.MILO/` directory in your project:

```text
.MILO/
├── config.json
├── context.md
├── memory.md
└── sessions/
```

- `config.json` — Project configuration and selected model.
- `context.md` — Project context, instructions, and notes.
- `memory.md` — Persistent notes remembered by the agent.
- `sessions/` — Saved conversation history.

## License

MIT