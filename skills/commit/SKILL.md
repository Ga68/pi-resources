---
name: commit
description: Create a high-quality git commit from the current working tree. Use when the user asks to commit, make a commit, prepare a commit, write a commit message, or commit selected changes.
---

# Commit Skill

Use this skill to turn the current working tree into a clean, intentional git commit that reflects the work from the current conversation/session.

## Core Principles

- Infer commit scope from the recent conversation/session and the current diff.
- Commit only the files, and when necessary only the hunks, that belong to the work being committed.
- Do not blindly commit everything dirty in the repository.
- Prefer small, focused commits.
- Use a clear, standard imperative commit message.
- Never commit secrets, credentials, password files, or unrelated local artifacts.
- Do not push unless explicitly asked.
- Do not run global validation/lint/test commands as part of this generic skill unless the user explicitly asks. Project-specific validation can be added by project instructions or a project-local skill.

## Rationale Files

For commits where the short commit message cannot fully capture the context, create a markdown rationale file under:

```text
.agents/commits/
```

Use a timestamp plus subject slug naming scheme, for example:

```text
.agents/commits/2026-05-28-193000-add-commit-skill.md
```

The rationale file should be committed in the same commit as the code/doc changes it explains.

### When to create a rationale file

Default to creating one when the change involved meaningful design/context. It is especially appropriate when the commit includes:

- non-trivial implementation choices
- tradeoffs or alternatives considered
- changes that may be revisited later
- exclusions from the commit scope
- migration, architecture, workflow, or policy decisions
- subtle bug fixes or behavioral changes

A rationale file is optional for very small, targeted, self-explanatory commits where the commit message itself fully explains the intent.

### Rationale file content

The format may be freeform. Write whatever will best help future maintainers understand what we were thinking when the commit was made.

Include, as appropriate:

- summary of the change
- relevant session/conversation context
- what was included
- what was intentionally excluded
- alternatives considered
- decisions made and why
- risks, assumptions, or tradeoffs
- follow-up work that may still be worth considering

Do not attempt to include private hidden chain-of-thought. Instead, write a useful engineering rationale: conclusions, considerations, decisions, alternatives, and evidence.

### Commit message reference

If a rationale file is created, the commit message body must end with a final sentence exactly in this form, using the project-relative path:

```text
For more details, see .agents/commits/<filename>.md.
```

## Workflow

1. Inspect repository state:

   ```bash
   git status --short
   git branch --show-current
   git diff --stat
   ```

2. Inspect unstaged and staged diffs:

   ```bash
   git diff
   git diff --cached
   ```

3. Infer commit scope:

   - Use the recent conversation/session as the primary source of intent.
   - Use the diff to verify which files and hunks actually implement that intent.
   - Separate related changes from unrelated dirty work.
   - If scope is obvious, proceed without asking.
   - If scope is ambiguous, risky, or crosses unrelated concerns, ask the user what should be included.

4. Check for risky files and content before staging.

   Exclude obvious secret or credential files, including but not limited to:

   ```text
   .env
   .env.*
   *.pem
   *.key
   *.p12
   *.pfx
   id_rsa
   id_ed25519
   secrets.*
   credentials.*
   ```

   Scan diffs for suspicious secret patterns such as:

   ```text
   api_key
   secret
   token
   password
   PRIVATE KEY
   sk-
   ```

   If suspicious content appears, stop and ask the user to confirm whether it is intended before committing.

5. Stage only intended changes.

   Prefer explicit paths:

   ```bash
   git add path/to/file another/file
   ```

   If a file contains both related and unrelated changes, stage only the relevant hunks. Use patch staging when appropriate:

   ```bash
   git add -p path/to/file
   ```

   Avoid `git add .` unless all dirty changes have been reviewed and clearly belong to the requested commit.

6. Decide whether to create a rationale file.

   - Create `.agents/commits/` if needed.
   - Write the rationale file before the commit.
   - Stage the rationale file with the rest of the intended changes.
   - If the rationale file is created, ensure the final sentence of the commit message body references it exactly as described above.

7. Write the commit message.

   Default format:

   ```text
   Concise imperative subject

   Optional body explaining motivation or context.
   For more details, see .agents/commits/<filename>.md.
   ```

   Subject guidelines:

   - Use imperative mood: `Add`, `Fix`, `Update`, `Remove`, `Refactor`.
   - Keep it concise, ideally <= 72 characters.
   - Do not end the subject with a period.
   - Mention the user-visible or architectural outcome, not just file names.
   - Use conventional commit prefixes only if the repository clearly already uses them or the user asks.

8. Before committing, verify staged content:

   ```bash
   git diff --cached --stat
   git diff --cached
   ```

   Confirm the staged diff matches the inferred scope. If unrelated or suspicious changes are staged, unstage them before committing.

9. Commit:

   ```bash
   git commit -m "subject"
   ```

   For multi-line messages, use multiple `-m` flags or a temporary message file:

   ```bash
   git commit -m "subject" -m "body"
   ```

10. After committing, report briefly:

   - What was accomplished.
   - Whether a rationale file was included and its path.
   - Any remaining uncommitted changes.

   The commit hash is not necessary unless the user asks for it.

## Common User Requests

### "Commit this" / "Commit our work"

Infer scope from the conversation/session. Stage only the changes that belong to that work. Leave unrelated dirty changes unstaged and mention them afterward.

### "Commit everything"

Still inspect the diff first. If all changes appear related and safe, stage all intended tracked and untracked files. If suspicious or unrelated changes are present, ask first.

### "Commit only X"

Stage only paths or hunks related to X. Leave other changes untouched and mention them after the commit.

### "Write a commit message"

Do not commit. Inspect the diff and propose one or more messages. If a rationale file would be appropriate, suggest that as part of the proposed commit plan.

### "Amend the last commit"

Ask for confirmation before amending. Then inspect:

```bash
git log -1 --oneline
git diff
git diff --cached
```

Use:

```bash
git commit --amend
```

only after explicit confirmation.

## Safety Rules

Never run these unless the user explicitly requests and confirms the exact action:

```bash
git reset --hard
git clean -fd
git push --force
git rebase
git checkout -- .
git restore .
```
