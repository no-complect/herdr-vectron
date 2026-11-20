export const previewRows = 1500;

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiffPreview(lines, { newFile = false, limited = false } = {}) {
  const hunks = [];
  let hunk = null;
  let old = 0;
  let next = 0;
  let extent = 1;
  let newFileLines = null;

  const finish = (end) => {
    if (hunk && hunk.line !== null) {
      // Plain scroll areas reveal just one row. Bring the first edit plus its
      // neighbor into view without spilling into the next hunk.
      hunk.revealRow = Math.min(hunk.revealRow, end - 1);
      hunks.push(hunk);
    }
  };

  // Derive marks and row indexes together so a mark only targets a loaded hunk.
  const rows = lines.slice(0, previewRows).map((raw, row) => {
    const text = raw.length > 4000 ? raw.slice(0, 4000) + "… (line truncated)" : raw;
    const match = hunkHeader.exec(raw);
    if (match) {
      finish(row);
      old = Number(match[1]);
      next = Number(match[3]);
      if (newFile && row === 0 && old === 0 && match[2] === "0" && next === 1)
        newFileLines = Number(match[4] ?? 1);
      hunk = { row, line: null, add: 0, del: 0 };
      return { kind: "@", text };
    }

    const kind = text[0];
    if (!hunk || (kind !== "+" && kind !== "-" && kind !== " "))
      return { kind: "", text };

    const line = text.slice(1) || " ";
    if (kind !== " " && hunk.line === null) {
      hunk.line = Math.max(1, next);
      hunk.revealRow = row + 1;
    }
    extent = Math.max(extent, next);
    if (kind === "-") {
      hunk.del++;
      return { kind, number: old++, text: line };
    }
    if (kind === "+") hunk.add++;
    else old++;
    return { kind, number: next++, text: line };
  });
  finish(rows.length);

  const wholeFile = newFileLines !== null && newFileLines >= extent;
  return {
    rows,
    hunks,
    extent: wholeFile ? newFileLines : extent,
    wholeFile,
    limited: limited || lines.length > previewRows,
  };
}
