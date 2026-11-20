import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

export const rl = readline.createInterface({
    input: stdin,
    output: stdout,
});

export const c = {
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    orange: (s: string) => `\x1b[38;5;209m${s}\x1b[0m`,
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let timer: ReturnType<typeof setInterval> | null = null;

export function startSpinner(label = "thinking...") {
    if (timer || !stdout.isTTY) return;

    let i = 0;

    timer = setInterval(() => {
        stdout.write(
            `\r${c.orange(frames[i++ % frames.length]!)} ${c.dim(label)}`,
        );
    }, 80);
}

export function stopSpinner() {
    if (!timer) return;

    clearInterval(timer);
    timer = null;
    stdout.write("\r\x1b[K");
}

let autoApprove = false;
let activeSignal: AbortSignal | undefined;

export const setAutoApprove = (v: boolean) => (autoApprove = v);
export const setActiveSignal = (s: AbortSignal | undefined) =>
    (activeSignal = s);

export async function approve(
    description: string,
    preview?: string,
): Promise<boolean> {
    if (autoApprove) return true;
    if (preview) console.log(preview);

    try {
        const answer = (
            await rl.question(
                `${c.orange("?")} Autoriser ${c.bold(description)} ${c.dim("[y]es / [n]o / [a]lways")} `,
                activeSignal ? { signal: activeSignal } : {},
            )
        )
            .trim()
            .toLowerCase();

        if (answer === "a") {
            autoApprove = true;
            return true;
        }

        return answer === "" || answer === "y" || answer === "yes";
    } catch {
        return false;
    }
}

export function showCall(description: string) {
    stopSpinner();
    console.log(`\n${c.green("●")} ${c.bold(description)}`);
}

export function showResult(text: string) {
    const lines = text.split("\n");
    const preview = lines.slice(0, 6).join("\n");
    const more = lines.length > 6 ? `\n  … (+${lines.length - 6} lines)` : "";
    console.log(c.dim((preview + more).replace(/^/gm, "  ⎿ ")));
    startSpinner();
}

export function diffPreview(oldStr: string, newStr: string): string {
    const cut = (s: string) => {
        const l = s.split("\n");
        return l.length > 12
            ? [...l.slice(0, 12), `… (+${l.length - 12} lines)`]
            : l;
    };
    const out = [
        ...cut(oldStr).map((l) => c.red(`  - ${l}`)),
        ...cut(newStr).map((l) => c.green(`  + ${l}`)),
    ];
    return out.join("\n");
}

export function showTodos(todos: { text: string; status: string }[]) {
    stopSpinner();
    const icon: Record<string, string> = { todo: "☐", doing: "◐", done: "☑" };
    for (const t of todos) {
        const line = `  ${icon[t.status] ?? "☐"} ${t.text}`;
        console.log(
            t.status === "done"
                ? c.dim(line)
                : t.status === "doing"
                  ? c.orange(line)
                  : line,
        );
    }
}
