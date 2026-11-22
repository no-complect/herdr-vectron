const reports = {
  concepts_brief: "Brief",
  egm_lite_checklist: "Checklist",
  consolidated_review_report: "Review",
  goldfish_review_report: "Review",
  zoom_out_report: "Review",
  comprehension_report: "Review",
  critic_report: "Review",
  intermediate_zoom_out_report: "Review",
  implementation_readiness_report: "Review",
};
const kinds = ["Brief", "Design", "Design index", "Checklist", "Review", "Drift report"];
const pathspecs = [
  ":(glob)docs/designs/**/*.md",
  ":(glob)**/*_DRIFT_REPORT.md",
  ...Object.keys(reports).map((name) => `:(glob)**/${name}.md`),
];
const maxDocuments = 100;

export function absolutePath(root, path) {
  return root.endsWith("/") ? root + path : root + "/" + path;
}

export async function discoverDocuments(exec, { cwd, on }) {
  const options = { cwd, on, timeout: 5000 };
  const repository = await exec("git", ["rev-parse", "--show-toplevel"], options);
  if (repository.code !== 0) return null;

  const root = repository.stdout.replace(/\r?\n$/, "");
  const result = await exec("git", [
    "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspecs,
  ], { ...options, cwd: root });
  if (result.code !== 0) throw new Error("Git could not list documents");

  const documents = [...new Set(result.stdout.split("\0").filter(Boolean))].map((path) => {
    const name = path.split("/").at(-1).slice(0, -3);
    const kind = Object.hasOwn(reports, name) ? reports[name]
      : name.endsWith("_DRIFT_REPORT") ? "Drift report"
      : name === "SITEMAP" ? "Design index"
      : "Design";
    return { path, kind };
  });
  documents.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.path.localeCompare(b.path));
  return { root, documents: documents.slice(0, maxDocuments), limited: documents.length > maxDocuments };
}

export function skillInvocation(skill, host, root, document) {
  const prefix = host === "codex" ? "$egm:" : "/egm:";
  let target;
  if (skill === "draft" && document?.kind === "Brief") {
    target = document.path;
  } else if (["review", "review-loop"].includes(skill) && document?.kind === "Design") {
    target = document.path;
  } else if (skill === "drift-report" && ["Design", "Design index"].includes(document?.kind)) {
    target = document.path.slice(0, document.path.lastIndexOf("/"));
  }
  return prefix + "egm-" + skill + (target ? " " + JSON.stringify(absolutePath(root, target)) : "");
}
