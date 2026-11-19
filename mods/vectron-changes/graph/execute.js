// Action execution is separate from the UI so context checks can be tested
// against disposable repositories. exec has Herdr's (program, argv, options) shape.
import { READ, commandsFor, gitError } from "./git.js";

async function revision(git) {
  const head = await git([...READ, "rev-parse", "--verify", "-q", "HEAD"]);
  const branch = await git([...READ, "symbolic-ref", "-q", "--short", "HEAD"]);
  // Unborn HEAD and detached HEAD are valid. Other failures cannot authorize a mutation.
  if (![0, 1].includes(head.code) || ![0, 1].includes(branch.code)) return null;
  return {
    head: head.code === 0 ? head.stdout.trim() : null,
    current: branch.code === 0 ? branch.stdout.trim() : null,
  };
}

export async function reviewCommit(git, confirmedConflicts) {
  const index = await git([...READ, "ls-files", "--unmerged", "-z"]);
  if (index.code !== 0) return { message: "Could not check for unresolved merge conflicts." };
  if (!index.stdout && !confirmedConflicts) return null;

  const current = await revision(git);
  if (!current) return { message: "Could not verify the current branch and HEAD." };
  if (
    confirmedConflicts &&
    (current.head !== confirmedConflicts.head || current.current !== confirmedConflicts.current)
  ) {
    return { message: "The branch or HEAD changed. Review the changes before committing." };
  }
  if (!index.stdout || index.stdout === confirmedConflicts?.entries) return null;

  return {
    conflicts: { ...current, entries: index.stdout },
    message: "Confirm the conflicts are resolved. This will stage all changes and commit them.",
  };
}

export async function executeAction(action, values, ctx, exec) {
  const git = (args) => exec("git", args, { cwd: ctx.root, on: ctx.on });
  const commands = commandsFor(action, values, ctx);
  // A dialog/menu describes this snapshot, not whatever HEAD happens to be
  // when the user confirms it. Fetch does not operate on the current branch.
  if (action.type !== "fetch") {
    const actual = await revision(git);
    if (!actual) {
      return {
        ok: false,
        message: "Cannot verify the repository state. Close this action and refresh the graph.",
      };
    }
    if (actual.head !== ctx.head || actual.current !== ctx.current) {
      return {
        ok: false,
        stale: true,
        message:
          "The repository's branch or HEAD changed. Close this action, refresh the graph, and review it again.",
      };
    }
  }
  if (action.type === "commit" && values.all) {
    const review = await reviewCommit(git, values.confirmedConflicts);
    if (review) return { ok: false, ...review };
  }
  // Git has no transaction spanning these commands and other terminals. This
  // preflight detects an already changed context; it cannot lock out future edits.
  for (const args of commands) {
    const result = await git(args);
    if (result.code !== 0) return { ok: false, message: gitError(result) };
  }
  return { ok: true };
}
