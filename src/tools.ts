import { tool } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { exec } from "node:child_process";
import path from "node:path";
import { approve, showCall, showResult, diffPreview, c } from "./ui.ts";
import { ROOT, IGNORED, appendMemory } from "./store.ts";

const MAX_OUTPUT = 20_000;
const clip = (s: string) =>
    s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n...[truncated]" : s;

const abs = (p: string) => path.resolve(ROOT, p);
const inside = (p: string) => {
    const rel = path.relative(ROOT, abs(p));
    return !rel.startsWith("..") && !path.isAbsolute(rel);
};
const rel = (p: string) => path.relative(ROOT, p) || ".";

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(() => fn());
    queue = next.catch(() => {});
    return next;
}

function run(
    description: string,
    opts: { approval?: boolean; preview?: string },
    action: () => Promise<string>,
): Promise<string> {
    return serial(async () => {
        showCall(description);
        if (opts.approval && !(await approve(description, opts.preview))) {
            const refused = "The user declined this action.";
            showResult(refused);
            return refused;
        }
        let result: string;
        try {
            result = await action();
        } catch (e: any) {
            result = `Error: ${e.message}`;
        }
        showResult(result);
        return result;
    });
}

const outside = (description: string, p: string) =>
    run(
        description,
        {},
        async () =>
            `Error: "${p}" is outside the working directory. Access denied.`,
    );

type Snapshot = { file: string; previous: string | null };
const undoStack: Snapshot[] = [];

async function snapshot(file: string) {
    undoStack.push({
        file,
        previous: await fs.readFile(file, "utf8").catch(() => null),
    });
}

export async function undoLast(): Promise<string> {
    const s = undoStack.pop();
    if (!s) return "Nothing to undo.";
    if (s.previous === null) await fs.rm(s.file, { force: true });
    else await fs.writeFile(s.file, s.previous, "utf8");
    return `Undone: ${rel(s.file)}`;
}

type Todo = { text: string; status: "todo" | "doing" | "done" };
let todos: Todo[] = [];
export const getTodos = () => todos;

async function* walk(dir: string): AsyncGenerator<string> {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (IGNORED.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(full);
        else yield full;
    }
}

function globMatch(glob: string, file: string) {
    const re = new RegExp(
        "^" +
            glob
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replace(/\*\*/g, "§")
                .replace(/\*/g, "[^/]*")
                .replace(/§/g, ".*")
                .replace(/\?/g, ".") +
            "$",
    );
    return re.test(glob.includes("/") ? file : path.basename(file));
}

export const tools = {
    read_file: tool({
        description:
            "Reads a text file with line numbers. You can optionally read only a specific range of lines.",
        inputSchema: z.object({
            path: z.string().describe("File path"),
            start_line: z
                .number()
                .int()
                .optional()
                .describe("First line (1 = beginning)"),
            end_line: z
                .number()
                .int()
                .optional()
                .describe("Last included line"),
        }),
        execute: ({ path: p, start_line, end_line }) =>
            run(`read_file: ${p}`, {}, async () => {
                const lines = (await fs.readFile(abs(p), "utf8")).split("\n");
                const start = Math.max(1, start_line ?? 1);
                const end = Math.min(lines.length, end_line ?? start + 1999);
                return clip(
                    lines
                        .slice(start - 1, end)
                        .map((l, i) => `${String(start + i).padStart(5)}  ${l}`)
                        .join("\n"),
                );
            }),
    }),

    list_dir: tool({
        description:
            "Lists files and directories (node_modules, .git, and .MILO are ignored).",
        inputSchema: z.object({
            path: z.string().default(".").describe("Directory (default: .)"),
            depth: z
                .number()
                .int()
                .min(1)
                .max(4)
                .default(1)
                .describe("Depth (1 to 4)"),
        }),
        execute: ({ path: p, depth }) =>
            run(`list_dir: ${p}`, {}, async () => {
                const lines: string[] = [];
                const go = async (dir: string, level: number) => {
                    for (const e of (
                        await fs.readdir(dir, { withFileTypes: true })
                    ).sort((a, b) => a.name.localeCompare(b.name))) {
                        if (IGNORED.has(e.name)) continue;
                        lines.push(
                            "  ".repeat(level) +
                                e.name +
                                (e.isDirectory() ? "/" : ""),
                        );
                        if (e.isDirectory() && level + 1 < depth)
                            await go(path.join(dir, e.name), level + 1);
                    }
                };
                await go(abs(p), 0);
                return clip(lines.join("\n") || "(empty)");
            }),
    }),

    grep: tool({
        description:
            "Searches project files for a regular expression. Returns file:line:text (maximum 100 results).",
        inputSchema: z.object({
            pattern: z.string().describe("JavaScript regular expression"),
            path: z.string().default(".").describe("Directory to search"),
            glob: z
                .string()
                .optional()
                .describe('File filter, e.g. "*.ts" or "src/**/*.tsx"'),
        }),
        execute: ({ pattern, path: p, glob }) =>
            run(
                `grep: ${pattern}${glob ? `  (${glob})` : ""}`,
                {},
                async () => {
                    const re = new RegExp(pattern);
                    const hits: string[] = [];
                    for await (const file of walk(abs(p))) {
                        if (glob && !globMatch(glob, rel(file))) continue;
                        const stat = await fs.stat(file);
                        if (stat.size > 1_000_000) continue;
                        const text = await fs
                            .readFile(file, "utf8")
                            .catch(() => "");
                        if (text.includes("\0")) continue;
                        const lines = text.split("\n");
                        for (let i = 0; i < lines.length; i++) {
                            if (re.test(lines[i]!))
                                hits.push(
                                    `${rel(file)}:${i + 1}:${lines[i]!.trim().slice(0, 200)}`,
                                );
                            if (hits.length >= 100)
                                return (
                                    hits.join("\n") + "\n...[maximum 100 results]"
                                );
                        }
                    }
                    return hits.join("\n") || "No results found.";
                },
            ),
    }),

    write_file: tool({
        description:
            "Creates a file or overwrites an existing file with the complete provided content. Prefer edit_file for small changes.",
        inputSchema: z.object({
            path: z.string(),
            content: z.string().describe("Complete file content"),
        }),
        execute: async ({ path: p, content }) => {
            const desc = `write_file: ${p}`;
            if (!inside(p)) return outside(desc, p);
            const previous = await fs
                .readFile(abs(p), "utf8")
                .catch(() => null);
            const newLines = content.split("\n").length;
            const preview = c.dim(
                previous === null
                    ? `  new file, ${newLines} lines`
                    : `  overwrites file: ${previous.split("\n").length} → ${newLines} lines`,
            );
            return run(desc, { approval: true, preview }, async () => {
                await snapshot(abs(p));
                await fs.mkdir(path.dirname(abs(p)), { recursive: true });
                await fs.writeFile(abs(p), content, "utf8");
                return `File written: ${p}`;
            });
        },
    }),

    edit_file: tool({
        description:
            "Replaces ONE exact and unique occurrence of old_string with new_string in a file. Read the file first.",
        inputSchema: z.object({
            path: z.string(),
            old_string: z
                .string()
                .describe("Exact text to replace; it must appear only once"),
            new_string: z.string(),
        }),
        execute: async ({ path: p, old_string, new_string }) => {
            const desc = `edit_file: ${p}`;
            if (!inside(p)) return outside(desc, p);
            let text: string;
            try {
                text = await fs.readFile(abs(p), "utf8");
            } catch (e: any) {
                return run(desc, {}, async () => `Error: ${e.message}`);
            }
            const count = text.split(old_string).length - 1;
            if (count !== 1)
                return run(desc, {}, async () =>
                    count === 0
                        ? "Error: old_string not found (check spaces and indentation)."
                        : `Error: old_string appears ${count} times; add more context to make it unique.`,
                );
            return run(
                desc,
                {
                    approval: true,
                    preview: diffPreview(old_string, new_string),
                },
                async () => {
                    await snapshot(abs(p));
                    await fs.writeFile(
                        abs(p),
                        text.replace(old_string, () => new_string),
                        "utf8",
                    );
                    return `File modified: ${p}`;
                },
            );
        },
    }),

    bash: tool({
        description:
            "Runs a shell command in the working directory. Returns stdout, stderr, and the exit code.",
        inputSchema: z.object({
            command: z.string(),
            timeout_seconds: z.number().int().min(1).max(300).default(60),
        }),
        execute: ({ command, timeout_seconds }) =>
            run(
                `bash: ${command}`,
                { approval: true },
                () =>
                    new Promise<string>((resolve) => {
                        exec(
                            command,
                            {
                                cwd: ROOT,
                                timeout: timeout_seconds * 1000,
                                maxBuffer: 10 * 1024 * 1024,
                            },
                            (err: any, stdout: string, stderr: string) => {
                                let out =
                                    stdout +
                                    (stderr ? `\n[stderr]\n${stderr}` : "");
                                if (err?.killed) out += "\n[timeout exceeded]";
                                else if (err)
                                    out += `\n[exit code ${err.code}]`;
                                resolve(clip(out.trim() || "(no output)"));
                            },
                        );
                    }),
            ),
    }),

    remember: tool({
        description:
            "Stores a lasting piece of project information in .MILO/memory.md (convention, useful command, or decision). It will be read in future sessions. Use sparingly.",
        inputSchema: z.object({
            note: z.string().describe("One short, useful sentence"),
        }),
        execute: ({ note }) =>
            run(`remember: ${note}`, {}, async () => {
                await appendMemory(note);
                return "Saved to .MILO/memory.md";
            }),
    }),

    todo_write: tool({
        description:
            "Creates or updates the task list visible to the user. Useful for multi-step work: send the complete list each time.",
        inputSchema: z.object({
            todos: z.array(
                z.object({
                    text: z.string(),
                    status: z.enum(["todo", "doing", "done"]),
                }),
            ),
        }),
        execute: ({ todos: next }) =>
            run("todo_write", {}, async () => {
                todos = next;
                const icon = { todo: "☐", doing: "◐", done: "☑" } as const;
                return (
                    next.map((t) => `${icon[t.status]} ${t.text}`).join("\n") ||
                    "(empty list)"
                );
            }),
    }),
};