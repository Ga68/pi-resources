import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const POLICY =
  "When deleting files or directories, do not use rm, /bin/rm, /usr/bin/rm, rmdir, or unlink. Use `trash <path>` so deleted items go to the Trash. If `trash` cannot perform the requested deletion, ask the user before using any permanent deletion command.";

const BLOCK_MESSAGE =
  "Blocked by global deletion policy: use `trash <path>` instead of permanent deletion commands such as rm, rmdir, or unlink.";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\nGlobal deletion policy:\n${POLICY}`,
    };
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;

    const input = event.input as { command?: unknown };
    if (typeof input.command !== "string") return;

    if (violatesDeletionPolicy(input.command)) {
      return { block: true, reason: BLOCK_MESSAGE };
    }
  });
}

function violatesDeletionPolicy(command: string): boolean {
  const tokens = tokenizeShellLike(command);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (isSeparator(token)) continue;

    const commandStart = i === 0 || isSeparator(tokens[i - 1]);
    if (!commandStart) continue;

    let j = skipCommandPrefixes(tokens, i);
    const executable = tokens[j];
    if (!executable || isSeparator(executable)) continue;

    if (isPermanentDeleteExecutable(executable)) return true;

    if (isShellExecutable(executable)) {
      const nested = shellCArgument(tokens, j + 1);
      if (nested && violatesDeletionPolicy(nested)) return true;
    }

    if (baseName(executable) === "xargs") {
      for (let k = j + 1; k < tokens.length && !isSeparator(tokens[k]); k++) {
        if (isPermanentDeleteExecutable(tokens[k])) return true;
      }
    }

    if (baseName(executable) === "find") {
      for (let k = j + 1; k < tokens.length && !isSeparator(tokens[k]); k++) {
        if (tokens[k] === "-delete") return true;
        if ((tokens[k] === "-exec" || tokens[k] === "-execdir") && isPermanentDeleteExecutable(tokens[k + 1] ?? "")) {
          return true;
        }
      }
    }
  }

  // Catch command substitutions and other compact forms missed by token command-start heuristics.
  return /(^|[\s;&|(){}])(?:sudo\s+)?(?:(?:command|builtin)\s+)?(?:\/?(?:[\w.-]+\/)*)(?:rm|rmdir|unlink)(?=$|[\s;&|(){}])/.test(
    command,
  );
}

function skipCommandPrefixes(tokens: string[], start: number): number {
  let i = start;

  while (i < tokens.length && /^\w+=/.test(tokens[i])) i++;

  let changed = true;
  while (changed && i < tokens.length) {
    changed = false;

    if (tokens[i] === "sudo") {
      i++;
      while (i < tokens.length && tokens[i].startsWith("-") && !isSeparator(tokens[i])) i++;
      changed = true;
    }

    if (tokens[i] === "env") {
      i++;
      while (i < tokens.length && !isSeparator(tokens[i]) && (tokens[i].startsWith("-") || /^\w+=/.test(tokens[i]))) i++;
      changed = true;
    }

    if (tokens[i] === "command" || tokens[i] === "builtin" || tokens[i] === "exec") {
      i++;
      changed = true;
    }
  }

  return i;
}

function shellCArgument(tokens: string[], start: number): string | undefined {
  for (let i = start; i < tokens.length && !isSeparator(tokens[i]); i++) {
    if (tokens[i] === "-c") return tokens[i + 1];
  }
  return undefined;
}

function isShellExecutable(token: string): boolean {
  return ["sh", "bash", "zsh", "fish", "dash"].includes(baseName(token));
}

function isPermanentDeleteExecutable(token: string): boolean {
  return ["rm", "rmdir", "unlink"].includes(baseName(token));
}

function baseName(token: string): string {
  return token.split("/").filter(Boolean).pop() ?? token;
}

function isSeparator(token: string): boolean {
  return token === ";" || token === "&&" || token === "||" || token === "|" || token === "(" || token === ")" || token === "\n";
}

function tokenizeShellLike(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  const push = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1];

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (quote === '"' && char === "\\" && next) {
        current += next;
        i++;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "\\" && next) {
      current += next;
      i++;
      continue;
    }

    if (char === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
      while (i < command.length && command[i] !== "\n") i++;
      if (command[i] === "\n") {
        push();
        tokens.push("\n");
      }
      continue;
    }

    if (/\s/.test(char)) {
      push();
      if (char === "\n") tokens.push("\n");
      continue;
    }

    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      push();
      tokens.push(char + next);
      i++;
      continue;
    }

    if (";|()".includes(char)) {
      push();
      tokens.push(char);
      continue;
    }

    current += char;
  }

  push();
  return tokens;
}
