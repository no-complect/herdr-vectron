# Resume a diff review after an interruption

- **Author:** David Thomason
- **Date:** 2026-11-21

This worked example uses fictional answers to show how EGM Brainstorm narrows a Vectron feature. It ends at the checkpoint before Goldfish review.

## Example conversation

**EGM.** When you switch attention in Herdr, what takes the most effort to get back to?

**Example reply.** I’m midway through a diff when an agent asks for input. I jump to its terminal. When I come back, I remember the file but have to find the change I was reading.

**EGM.** What would Vectron need to remember so you could pick up where you left off?

**Example reply.** The file and the last hunk I deliberately selected on the diff rail. That’s enough even if the panel changed size in the meantime.

**EGM.** What should happen if the agent edits that file while you’re away?

**Example reply.** If the saved hunk can still be identified exactly, offer to take me back. If it can’t, show me the file and let me choose where to continue. A confident jump to the wrong change would be worse than making me look.

## Overview

When a developer selects a hunk in Changes, Vectron could remember that choice for the current worktree. The next time the developer opens Changes there, **Resume review** would reopen the file and jump to the saved hunk if the current diff still contains it.

## Analysis

Vectron already remembers which side panel a space had open. Changes already exposes clickable hunks and knows how to scroll to one. Changing workspace currently clears the open file and diff state. The useful addition is remembering the review position across that switch. [Panel selection](../../../mods/vectron-tabs/main.js#L238) · [Changes workspace reset](../../../mods/vectron-changes/main.js#L138) · [Diff rail jumps](../../../mods/vectron-changes/main.js#L805)

The hard case is a changed diff. A row number can now point to another edit, and identical edits can occur twice in the same file. For a first version, match the saved hunk header and text against the live preview. If there is no unique match, open the file and show **The saved change moved or changed**. If the file is gone, clear the saved position and show the Changes list. This conservative rule can also skip a valid hunk whose line numbers moved.

## Goals and boundaries

- Keep one review position per worktree for the current app session.
- Capture the position when the developer selects a hunk on the existing diff rail.
- Offer a single action when the developer returns to Changes. Use the existing diff loading and jump behavior.
- Keep the first version within the loaded text preview. Review history across restarts, named bookmarks, and guessing where a moved hunk went are outside this example.

## Alternatives weighed

- **Restore the exact scroll position.** Easy to picture, but a resize, line wrapping, or an edit can put a different hunk at that position.
- **Add a bookmark button.** Gives the developer deliberate control, but the interruption might happen before they save. Start by reusing the hunk selection they already make.
- **Open every review position automatically.** Saves a click when the guess is right. It also interrupts someone who came back to review a different file.

Two other candidates could start their own EGM conversations. **Quiet signals** would let people keep focus and agent cues with less motion. Its test is whether the cues stay legible in a light theme. **Review a changed design** would let someone hand an edited design document from Changes to the EGM panel. Its test is whether the shortcut saves enough work over picking the same document in EGM.

## Key decisions and next steps

Start with one interruption. The developer selects a hunk, visits an agent in another worktree, returns, and resumes the review in one click. Repeat after editing the saved hunk. The second run should reopen the file and explain why it stayed there.

**Example readiness checkpoint.** Vectron would remember one explicitly selected hunk per worktree and offer a way back inside Changes. A unique match in the current diff permits a jump. An edited or ambiguous hunk returns the developer to the file. Is this specific enough to send to the Goldfish reviewers?
