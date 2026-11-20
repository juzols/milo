#!/usr/bin/env bun

import { createGateway, isLoopFinished, isStepCount, streamText, type ModelMessage } from "ai";
import {
    DIR,
    getApiKey,
    initProject,
    listSessions,
    loadLastSession,
    newSessionId,
    readContext,
    regenerateContext,
    ROOT,
    saveApiKey,
    saveConfig,
    saveSession,
    type SessionFile,
} from "./store";
import {
    c,
    rl,
    setActiveSignal,
    setAutoApprove,
    showTodos,
    startSpinner,
    stopSpinner,
} from "./ui";
import { getTodos, tools, undoLast } from "./tools";

const VERSION = "0.2.0";

const HELP = `milo ${VERSION}, terminal coding agent

Usage:
  milo                    start an interactive session in the current directory
  milo -c                 resume the last session in the current directory
  milo -p "question"      send a single prompt, then exit
  milo --model openai/... select a model (saved in .MILO/config.json)
  milo -y                 automatically approve all actions

Inside a session:
  /help  /clear  /context  /init  /sessions  /todo  /undo  /cost  /model <name>  /exit
  Press Ctrl+C during a response to interrupt it.

The .MILO/ directory (created on first launch) contains:
  config.json   selected model
  context.md    project context (editable, re-read with every message)
  memory.md     notes the agent has decided to remember
  sessions/     complete history of every conversation`;

const args = process.argv.slice(2);

const has = (...flags: string[]) => args.some((a) => flags.includes(a));
const valueOf = (...flags: string[]) => {
    const i = args.findIndex((a) => flags.includes(a));
    return i >= 0 ? args[i + 1] : undefined;
};

const printIdx = args.findIndex((a) => a === "-p" || a === "--print");
const oneShot =
    printIdx >= 0
        ? args
              .slice(printIdx + 1)
              .join(" ")
              .trim()
        : undefined;

if (has("-h", "--help")) {
    console.log(HELP);
    process.exit(0);
}
if (has("-v", "--version")) {
    console.log(VERSION);
    process.exit(0);
}
if (has("-y", "--yes")) setAutoApprove(true);

let session: SessionFile;
let messages: ModelMessage[];
let currentAbort: AbortController | null = null;
let ctrlC = 0;

async function ensureApiKey(): Promise<string> {
    const existing = await getApiKey();

    if (existing) return existing;
    if (!process.stdin.isTTY) {
        console.error(c.red("AI_GATEWAY_API_KEY is missing."));
        process.exit(1);
    }

    console.log(c.yellow("No Vercel AI Gateway API key found."));

    const key = (
        await rl.question(
            "Enter your AI_GATEWAY_API_KEY (stored in ~/.milo/config.json): ",
        )
    ).trim();

    if (!key) process.exit(1);

    await saveApiKey(key);
    return key;
}

async function buildInstructions(): Promise<string> {
    return `You are milo, a coding agent running in the user's terminal.
Working directory: ${ROOT}
System: ${process.platform}
Date: ${new Date().toISOString().slice(0, 10)}

Rules:
- Respond concisely in the user's language.
- Explore before taking action: use list_dir, grep, and read_file. Read a file before modifying it.
- Prefer edit_file over write_file for small changes.
- For multi-step tasks, keep todo_write up to date.
- After making changes, use bash to verify them when relevant (tests, build, typecheck).
- Use remember sparingly to record a lasting project convention or decision.
- Actions that modify anything require the user's approval. If they refuse, suggest an alternative.

${await readContext()}`;
}

async function turn(
    text: string,
    gateway: ReturnType<typeof createGateway>,
    model: string,
) {
    const before = messages.length;
    messages.push({ role: "user", content: text });

    const controller = new AbortController();
    currentAbort = controller;
    setActiveSignal(controller.signal);
    let streamError: unknown;

    try {
        startSpinner();

        const result = streamText({
            model: gateway(model),
            instructions: await buildInstructions(),
            messages,
            tools,
            stopWhen: isLoopFinished(),
            abortSignal: controller.signal,
            onError: ({ error }) => {
                streamError = error;
            },
        });

        let wroteText = false;

        for await (const chunk of result.textStream) {
            stopSpinner();
            process.stdout.write(chunk);
            wroteText = true;
        }

        stopSpinner();

        if (wroteText) process.stdout.write("\n");
        if (streamError) throw streamError;

        messages.push(...(await result.responseMessages));

        const usage = await result.totalUsage;

        session.tokens.input += usage.inputTokens ?? 0;
        session.tokens.output += usage.outputTokens ?? 0;
        session.model = model;

        await saveSession(session);
    } catch (e: any) {
        stopSpinner();

        messages.length = before;

        if (controller.signal.aborted) console.log(c.yellow("\n(interrupted)"));
        else console.error(c.red(`\nError: ${e?.message ?? e}`));
    } finally {
        currentAbort = null;

        setActiveSignal(undefined);
    }
}

async function slash(
    line: string,
    config: { model: string },
    createdAt: string,
): Promise<boolean> {
    const [cmd, ...rest] = line.slice(1).split(" ");

    switch (cmd) {
        case "help":
            console.log(HELP);

            break;
        case "clear":
            session = {
                ...session,
                id: newSessionId(),
                startedAt: new Date().toISOString(),
                tokens: { input: 0, output: 0 },
                messages: [],
            };
            messages = session.messages;

            console.log(c.dim("New conversation."));

            break;
        case "context":
            console.log(c.dim(await readContext()));

            break;
        case "init":
            await regenerateContext();

            console.log(
                c.dim(
                    "context.md regenerated (your previous notes have been overwritten).",
                ),
            );

            break;
        case "sessions": {
            const all = await listSessions();

            if (!all.length) console.log(c.dim("No sessions found."));

            for (const s of all.slice(-10)) {
                const first = s.messages.find((m) => m.role === "user");
                const label =
                    typeof first?.content === "string"
                        ? first.content.slice(0, 50)
                        : "(empty)";
                console.log(`  ${c.dim(s.id)}  ${label}`);
            }

            console.log(c.dim("  (milo -c resumes the latest session)"));

            break;
        }
        case "todo":
            getTodos().length
                ? showTodos(getTodos())
                : console.log(c.dim("No tasks."));

            break;
        case "undo":
            console.log(c.dim(await undoLast()));

            break;
        case "cost":
            console.log(
                c.dim(
                    `Tokens this session: ${session.tokens.input} input, ${session.tokens.output} output`,
                ),
            );

            break;
        case "model": {
            const name = rest.join(" ").trim();

            if (!name) {
                console.log(c.dim(`Current model: ${config.model}`));
            } else {
                config.model = name;
                await saveConfig({ model: name, createdAt });
                console.log(c.dim(`Model: ${name}`));
            }

            break;
        }
        case "exit":
        case "quit":
            return true;
        default:
            console.log(c.red(`Unknown command: /${cmd}`) + c.dim("  (/help)"));
    }

    return false;
}

async function main() {
    const apiKey = await ensureApiKey();
    const gateway = createGateway({ apiKey });

    const modelFlag = valueOf("--model");
    const { created, config } = await initProject(modelFlag);
    if (modelFlag) await saveConfig(config);

    const last = has("-c", "--continue") ? await loadLastSession() : undefined;
    session = last ?? {
        id: newSessionId(),
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model: config.model,
        tokens: { input: 0, output: 0 },
        messages: [],
    };
    messages = session.messages;

    rl.on("SIGINT", () => {
        if (currentAbort) {
            currentAbort.abort();
            return;
        }
        if (++ctrlC >= 2) {
            console.log();
            process.exit(0);
        }
        console.log(c.dim("\n(Press Ctrl+C again to quit)"));
        process.stdout.write(c.orange("> "));
    });

    if (oneShot !== undefined) {
        if (oneShot) await turn(oneShot, gateway, config.model);
        process.exit(0);
    }

    rl.on("close", () => process.exit(0));

    console.log(c.yellow("✻ milo") + c.dim(`  v${VERSION}  ${config.model}`));
    console.log(c.dim(`  ${ROOT}`));

    if (created)
        console.log(
            c.dim(
                `  First launch here: created ${DIR} (context, memory, sessions).`,
            ),
        );

    if (last)
        console.log(c.dim(`  Session resumed (${messages.length} messages).`));

    while (true) {
        let line: string;

        try {
            line = (await rl.question(c.yellow("> "))).trim();
        } catch {
            break;
        }

        ctrlC = 0;

        if (!line) continue;

        if (line.startsWith("/")) {
            if (await slash(line, config, config.createdAt)) break;
            continue;
        }

        await turn(line, gateway, config.model);
        console.log();
    }

    rl.close();
}

main();
