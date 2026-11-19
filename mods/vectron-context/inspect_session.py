#!/usr/bin/env python3
"""Read-only session accounting. No network, credentials, hooks, or transcript writes."""

import argparse
import collections
import hashlib
import json
import math
import re
import sqlite3
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlparse

MAX_BYTES = 96 * 1024 * 1024
MAX_LINE = 16 * 1024 * 1024
MAX_EVENTS = 5000
PROVIDERS = ("codex", "claude", "grok", "agy")
CATEGORIES = [
    "runtime",
    "instructions",
    "memory",
    "skills",
    "tools",
    "environment",
    "user",
    "files",
    "calls",
    "results",
    "assistant",
    "summary",
]


def redact(text):
    text = re.sub(
        r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----",
        "[private key redacted]",
        text,
        flags=re.S,
    )
    text = re.sub(
        r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b",
        "[credential redacted]",
        text,
    )
    text = re.sub(r"(?i)(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}", r"\1[redacted]", text)
    text = re.sub(
        r"""(?ix)(["']?(?:[a-z0-9_]*api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret[_-]?key)["']?\s*[:=]\s*)(["'])(.*?)(\2)""",
        lambda m: m[1] + m[2] + "[redacted]" + m[2],
        text,
    )
    return re.sub(
        r"""(?ix)(\b(?:[a-z0-9_]*api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret[_-]?key)\s*=\s*)(?!["'])([^\s;,]+)""",
        r"\1[redacted]",
        text,
    )


def visible_text(value):
    """Exclude media payloads, opaque reasoning and embeddings from text estimates."""
    if isinstance(value, str):
        # Tool output may itself be serialized JSON with base64 media fields.
        if value.lstrip().startswith(("{", "[")):
            try:
                return visible_text(json.loads(value))
            except (ValueError, RecursionError):
                pass
        return re.sub(r'data:(?:image|audio|video)/[^\s"\']+', "[media omitted]", value)
    if isinstance(value, list):
        return "\n".join(filter(None, (visible_text(v) for v in value)))
    if isinstance(value, dict):
        kind = value.get("type", "")
        if kind in ("reasoning", "thinking", "redacted_thinking"):
            return ""
        if any(word in kind for word in ("image", "audio", "video")):
            return "[media omitted]"
        if isinstance(value.get("text"), str):
            return visible_text(value["text"])
        if isinstance(value.get("content"), (list, str)):
            return visible_text(value["content"])
        return json.dumps(
            {
                k: visible_text(v)
                for k, v in value.items()
                if k not in ("encrypted_content", "data", "base64", "signature")
            },
            ensure_ascii=False,
        )
    return "" if value is None else str(value)


def estimate(text):
    return math.ceil(len(text.encode("utf-8")) / 4)


def valid_count(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value >= 0
    )


def result_category(name, arguments):
    if re.search(r"(?i)(?:read|view_file|\bcat\b|\bsed\b)", name + " " + arguments):
        return (
            "skills"
            if "SKILL.md" in arguments
            else "memory"
            if re.search(r"MEMORY\.md|/memories/", arguments)
            else "files"
        )
    return "results"


def provider_of(path, home):
    path = Path(path).expanduser().resolve()
    for provider, root in [("codex", ".codex/sessions"), ("claude", ".claude/projects")]:
        if path.suffix == ".jsonl" and path.is_relative_to((home / root).resolve()):
            return provider
    root = (home / ".grok/sessions").resolve()
    if path.is_relative_to(root):
        parts = path.relative_to(root).parts
        if len(parts) == 3 and parts[-1] in ("chat_history.jsonl", "updates.jsonl"):
            return "grok"
    for root in agy_roots(home):
        root = (root / "brain").resolve()
        if path.is_relative_to(root):
            parts = path.relative_to(root).parts
            if len(parts) == 4 and parts[1:] == (".system_generated", "logs", "transcript.jsonl"):
                return "agy"
    raise ValueError("Select a local Codex, Claude Code, Grok Build or Antigravity transcript.")


def allowed(path, home, provider=None):
    path = Path(path).expanduser().resolve()
    actual = provider_of(path, home)
    if provider is not None and actual != provider:
        raise ValueError("The selected transcript belongs to another provider.")
    return path


def agy_roots(home):
    return [home / ".gemini/antigravity-cli", home / ".gemini/antigravity"]


def metadata(path, root):
    """Read only a bounded, known metadata file, never a link outside its session root."""
    try:
        path = path.resolve()
        if not path.is_relative_to(root.resolve()):
            return {}
        with path.open("rb") as stream:
            raw = stream.read(MAX_LINE + 1)
        value = json.loads(raw) if len(raw) <= MAX_LINE else None
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def extra_candidates(provider, home):
    candidates = []
    if provider == "grok":
        for source in home.glob(".grok/sessions/*/*/summary.json"):
            data = metadata(source, home / ".grok/sessions")
            info = data.get("info") or {}
            if not isinstance(info, dict):
                continue
            candidates.append(
                dict(
                    id=info.get("id") or source.parent.name,
                    path=str(source.with_name("chat_history.jsonl")),
                    name=data.get("title") or data.get("generated_title") or source.parent.name,
                    cwd=info.get("cwd", ""),
                )
            )
    elif provider == "agy":
        for root in agy_roots(home):
            data = metadata(root / "cache/conversation_metadata.json", root)
            indexed = data.get("conversations") or {}
            if not isinstance(indexed, dict):
                indexed = {}
            for source in root.glob("brain/*/.system_generated/logs/transcript.jsonl"):
                sid = source.parents[2].name
                entry = indexed.get(sid) or {}
                if not isinstance(entry, dict):
                    continue
                summary = entry.get("summary") or {}
                if (
                    not isinstance(summary, dict)
                    or entry.get("is_internal")
                    or summary.get("Internal")
                ):
                    continue
                uris = summary.get("WorkspaceURIs") or []
                cwd = unquote(urlparse(uris[0]).path) if uris and isinstance(uris[0], str) else ""
                candidates.append(
                    dict(id=sid, path=str(source), name=summary.get("Title") or sid, cwd=cwd)
                )
    result = []
    for candidate in candidates:
        try:
            source = allowed(candidate["path"], home, provider)
            if source.is_file():
                result.append(
                    dict(
                        candidate,
                        path=str(source),
                        name=redact(str(candidate["name"]))[:100],
                        updated=source.stat().st_mtime,
                    )
                )
        except (OSError, ValueError):
            continue
    return sorted(result, key=lambda c: c["updated"], reverse=True)[:60]


def canonical_session(path, home, provider):
    path = allowed(path, home, provider)
    if provider == "grok":
        path = allowed(path.with_name("chat_history.jsonl"), home, provider)
    return path


def process_session(path, home, provider):
    """Use known open-file identities without reading lock files or database contents."""
    path = Path(path).expanduser().resolve()
    if provider == "grok":
        root = (home / ".grok/sessions").resolve()
        if path.is_relative_to(root) and len(path.relative_to(root).parts) == 3:
            if path.name in ("events.jsonl", "chat_history.jsonl.lock", "updates.jsonl.lock"):
                return canonical_session(path.with_name("chat_history.jsonl"), home, provider)
    elif provider == "agy":
        for root in agy_roots(home):
            if path.parent == (root / "presence").resolve() and path.suffix == ".lock":
                transcript = root / "brain" / path.stem / ".system_generated/logs/transcript.jsonl"
                return canonical_session(transcript, home, provider)
    return canonical_session(path, home, provider)


def session_id(path, home):
    provider = provider_of(path, home)
    if provider == "grok":
        return path.parent.name
    if provider == "agy":
        return path.parents[2].name
    return path.stem.split("rollout-")[-1]


def header(path):
    try:
        with path.open("rb") as f:
            return json.loads(f.readline(MAX_LINE)).get("payload", {})
    except (OSError, ValueError):
        return {}


def codex_index(home):
    rows = []
    for path in sorted(home.glob(".codex/state_*.sqlite"), reverse=True):
        try:
            with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.3) as db:
                db.row_factory = sqlite3.Row
                columns = {r[1] for r in db.execute("pragma table_info(threads)")}
                fields = [
                    k
                    for k in [
                        "id",
                        "rollout_path",
                        "name",
                        "title",
                        "cwd",
                        "updated_at",
                        "archived",
                    ]
                    if k in columns
                ]
                if not {"id", "rollout_path"}.issubset(columns):
                    continue
                rows = [
                    dict(r)
                    for r in db.execute(
                        "select "
                        + ",".join(fields)
                        + " from threads order by updated_at desc limit 100"
                    )
                ]
            break
        except sqlite3.Error:
            continue
    if not rows:
        paths = sorted(
            home.glob(".codex/sessions/*/*/*/*.jsonl"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[:60]
        for p in paths:
            h = header(p)
            rows.append(
                dict(
                    id=h.get("id"),
                    rollout_path=str(p),
                    cwd=h.get("cwd"),
                    name="",
                    updated_at=int(p.stat().st_mtime),
                )
            )
    result = []
    for row in rows:
        try:
            path = allowed(row["rollout_path"], home)
            if path.is_file():
                result.append(
                    dict(
                        id=row["id"],
                        path=str(path),
                        name=redact(str(row.get("name") or row.get("title") or row["id"]))[:100],
                        cwd=row.get("cwd", ""),
                        updated=row.get("updated_at", 0),
                    )
                )
        except (ValueError, TypeError, OSError):
            pass
    return result


def find_id(sid, home):
    if not isinstance(sid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", sid):
        return None
    return next(home.glob(".codex/sessions/*/*/*/*" + sid + ".jsonl"), None)


def chain(path, home, seen=None, limit=None):
    seen = set() if seen is None else seen
    path = allowed(path, home)
    if str(path) in seen or len(seen) >= 16:
        return [], ["Earlier lineage is unavailable or cyclic."]
    seen.add(str(path))
    h = header(path)
    base = h.get("history_base") or {}
    parent_id = base.get("thread_id") or h.get("forked_from_id")
    parts, notes = [], []
    if parent_id:
        parent = find_id(parent_id, home)
        boundary = base.get("end_byte_offset")
        if parent and isinstance(boundary, int) and boundary >= 0:
            parts, notes = chain(parent, home, seen, boundary)
        else:
            notes.append("Earlier fork history has no readable byte boundary; it is not included.")
    parts.append((path, limit))
    return parts, notes


def resolve(request, home):
    provider = request.get("provider", "codex")
    if provider not in PROVIDERS:
        return None, [], "Focus a Codex, Claude Code, Grok Build or Antigravity CLI session.", ""
    if provider == "claude":
        paths = sorted(
            home.glob(".claude/projects/*/*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True
        )[:60]
        candidates = [
            dict(id=p.stem, path=str(p), name=p.stem, cwd="", updated=int(p.stat().st_mtime))
            for p in paths
        ]
    elif provider == "codex":
        candidates = codex_index(home)
    else:
        candidates = extra_candidates(provider, home)
    if request.get("path"):
        chosen = canonical_session(request["path"], home, provider)
        return chosen, candidates, None, "Selected session"
    sid = request.get("session_id")
    if sid:
        match = [c for c in candidates if c["id"] == sid]
        if len(match) == 1:
            return Path(match[0]["path"]), candidates, None, "Session identifier"
    # Open-file identity is stronger than folder or recency. Never inspect process environments.
    pid = request.get("pid")
    if isinstance(pid, int) and pid > 0:
        try:
            proc = subprocess.run(
                ["lsof", "-a", "-p", str(pid), "-Fn"], capture_output=True, text=True, timeout=2
            )
            opened = []
            for line in proc.stdout.splitlines():
                if line.startswith("n"):
                    try:
                        p = process_session(line[1:], home, provider)
                        if p.is_file():
                            opened.append(p)
                    except ValueError:
                        pass
            if len(set(opened)) == 1:
                return opened[0], candidates, None, "Foreground process file"
        except (OSError, subprocess.TimeoutExpired):
            pass
    if provider == "claude" and isinstance(pid, int):
        try:
            info = json.loads((home / ".claude/sessions" / (str(pid) + ".json")).read_text())
            match = [c for c in candidates if c["id"] == info.get("sessionId")]
            if len(match) == 1:
                return Path(match[0]["path"]), candidates, None, "Claude process session"
        except (OSError, ValueError):
            pass
    title = re.sub(r"^[^\w]+", "", request.get("title", "")).strip().split(" | ")[0].strip()
    if len(title) >= 8:
        matches = [c for c in candidates if c["name"].strip() == title]
        if matches:
            # A continued thread may retain its name. Remove recorded ancestors,
            # and follow a single leaf; independent same-name sessions stay ambiguous.
            ancestors = set()
            for candidate in matches:
                h = header(Path(candidate["path"]))
                ancestors.add(h.get("forked_from_id"))
                ancestors.add((h.get("history_base") or {}).get("thread_id"))
            leaves = [c for c in matches if c["id"] not in ancestors]
            if len(leaves) == 1:
                return (
                    Path(leaves[0]["path"]),
                    candidates,
                    None,
                    "Session name and recorded continuation",
                )
    near = [c for c in candidates if c.get("cwd") == request.get("cwd")]
    # A folder alone cannot establish which conversation the terminal is showing.
    return (
        None,
        near or candidates[:15],
        "Choose the session to inspect. A folder alone does not identify a conversation.",
        "",
    )


class Accounting:
    def __init__(self):
        self.events = []
        self.calls = {}
        self.segment = 0
        self.turn = 0
        self.reported = None
        self.samples = []
        self.model = ""
        self.window = None
        self.hidden_reasoning = 0
        self.malformed = 0
        self.media = 0
        self.opaque_compaction = False
        self.truncated_records = False
        self.persistent = {}

    def add(
        self,
        category,
        label,
        text,
        path,
        line,
        timestamp,
        field="",
        persistent=None,
        protected=False,
    ):
        if not text and category != "summary":
            return
        event = dict(
            id=str(len(self.events)),
            category=category,
            label=redact(label)[:110],
            tokens=estimate(text),
            bytes=len(text.encode("utf-8")),
            timestamp=timestamp,
            segment=self.segment,
            turn=self.turn,
            source=str(path),
            line=line,
            field=field,
            persistent=persistent,
            protected=protected,
            teaser="Instruction content is not displayed."
            if protected
            else redact(text[:600])[:160],
        )
        if persistent:
            self.persistent[persistent] = event["id"]
        self.media += text.count("[media omitted]")
        self.events.append(event)

    def message(self, payload, path, line, ts, field=""):
        role = payload.get("role", "")
        text = visible_text(payload.get("content", []))
        category = "assistant" if role == "assistant" else "user"
        label = "Assistant reply" if role == "assistant" else "Your prompt"
        protected = role in ("system", "developer")
        if protected:
            category, label = "instructions", role.capitalize() + " instructions"
        elif role == "user":
            self.turn += 1
            if "AGENTS.md instructions" in text or "<INSTRUCTIONS>" in text:
                category, label = "instructions", "Agent instructions"
            elif "<environment_context>" in text:
                category, label = "environment", "Environment update"
            else:
                label = text.strip().split("\n")[0][:100] or label
        self.add(category, label, text, path, line, ts, field=field, protected=protected)

    def feed(self, row, path, line):
        kind, p, ts = row.get("type"), row.get("payload", {}), row.get("timestamp", "")
        if not isinstance(p, dict):
            return
        if kind == "session_meta":
            base = p.get("base_instructions")
            text = base.get("text", "") if isinstance(base, dict) else base or ""
            self.add(
                "runtime",
                "Runtime instructions · recorded",
                text,
                path,
                line,
                ts,
                "base",
                "base",
                True,
            )
        elif kind == "world_state":
            state = p.get("state") or {}
            for key, category, label in [
                ("agents_md", "instructions", "Agent instruction snapshot"),
                ("top_level_tools", "tools", "Tool definitions snapshot"),
                ("environments", "environment", "Environment snapshot"),
                ("permissions", "environment", "Permission snapshot"),
            ]:
                if key in state:
                    self.add(
                        category,
                        label,
                        visible_text(state[key]),
                        path,
                        line,
                        ts,
                        "world:" + key,
                        "world:" + key,
                        True,
                    )
        elif kind == "turn_context":
            self.model = p.get("model") or self.model
        elif kind == "event_msg" and p.get("type") == "task_started":
            self.window = p.get("model_context_window") or self.window
        elif kind == "event_msg" and p.get("type") == "token_count":
            info = p.get("info") or {}
            usage = info.get("last_token_usage") or {}
            if isinstance(usage.get("input_tokens"), (int, float)):
                self.window = info.get("model_context_window") or self.window
                self.reported = dict(
                    input=usage["input_tokens"],
                    cached=usage.get("cached_input_tokens", 0),
                    output=usage.get("output_tokens", 0),
                    timestamp=ts,
                    window=self.window,
                )
                self.samples.append(dict(self.reported, afterId=len(self.events) - 1))
        elif kind == "compacted":
            self.segment += 1
            self.add(
                "summary", "Compaction boundary", p.get("message") or "", path, line, ts, "compact"
            )
            # A replacement history is only shown when the recorder explicitly saves it.
            for index, replacement in enumerate(p.get("replacement_history") or []):
                if isinstance(replacement, dict) and replacement.get("type") == "message":
                    self.message(replacement, path, line, ts, "replacement:" + str(index))
                elif (
                    isinstance(replacement, dict) and replacement.get("type") == "additional_tools"
                ):
                    self.add(
                        "tools",
                        "Tool definitions after compaction",
                        visible_text(replacement.get("tools", [])),
                        path,
                        line,
                        ts,
                        persistent="world:top_level_tools",
                        protected=True,
                    )
                elif isinstance(replacement, dict) and replacement.get("type") == "compaction":
                    self.opaque_compaction = True
        elif kind == "response_item":
            typ = p.get("type")
            if typ == "message":
                self.message(p, path, line, ts)
            elif typ in ("function_call", "custom_tool_call"):
                name = p.get("name", "tool")
                text = visible_text(p.get("arguments", p.get("input", "")))
                self.calls[p.get("call_id")] = (name, text)
                self.add("calls", name, text, path, line, ts)
            elif typ in ("function_call_output", "custom_tool_call_output"):
                name, args = self.calls.get(p.get("call_id"), ("tool", ""))
                text = visible_text(p.get("output", ""))
                category = "results"
                if re.search(r"(?i)(?:\bread|\bcat\b|sed\b|read_file)", name + " " + args):
                    category = (
                        "skills"
                        if "SKILL.md" in args
                        else "memory"
                        if re.search(r"MEMORY\.md|/memories/", args)
                        else "files"
                    )
                self.add(category, name + " · result", text, path, line, ts)
            elif typ == "additional_tools":
                self.add(
                    "tools",
                    "Additional tool definitions",
                    visible_text(p.get("tools", [])),
                    path,
                    line,
                    ts,
                    protected=True,
                )
            elif typ == "reasoning":
                self.hidden_reasoning += 1
        # event_msg/item_completed mirrors response_item: deliberately do not count it twice.

    def claude(self, row, path, line):
        typ, ts = row.get("type"), row.get("timestamp", "")
        if typ == "system" and row.get("subtype") == "compact_boundary":
            self.segment += 1
            self.add("summary", "Compaction boundary", "", path, line, ts, "claude")
            return
        msg = row.get("message") or {}
        if typ not in ("user", "assistant") or not isinstance(msg, dict):
            return
        self.model = msg.get("model") or self.model
        usage = msg.get("usage") or {}
        if "input_tokens" in usage:
            # Claude reports uncached, cache-read and cache-write inputs as separate buckets.
            value = sum(
                usage.get(k, 0) or 0
                for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
            )
            self.reported = dict(
                input=value,
                cached=usage.get("cache_read_input_tokens", 0),
                output=usage.get("output_tokens", 0),
                timestamp=ts,
                window=None,
            )
            self.samples.append(dict(self.reported, afterId=len(self.events) - 1))
        content = msg.get("content", [])
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for index, part in enumerate(content):
            if not isinstance(part, dict):
                continue
            field = "claude:" + str(index)
            kind = part.get("type")
            if kind in ("thinking", "redacted_thinking"):
                self.hidden_reasoning += 1
                continue
            if kind == "tool_use":
                self.add(
                    "calls",
                    part.get("name", "Tool call"),
                    visible_text(part.get("input")),
                    path,
                    line,
                    ts,
                    field,
                )
            elif kind == "tool_result":
                self.add(
                    "results",
                    "Tool result",
                    visible_text(part.get("content")),
                    path,
                    line,
                    ts,
                    field,
                )
            else:
                text = visible_text(part)
                if typ == "user":
                    self.turn += 1
                self.add(
                    "user" if typ == "user" else "assistant",
                    "Your prompt" if typ == "user" else "Assistant reply",
                    text,
                    path,
                    line,
                    ts,
                    field,
                )

    def grok(self, row, path, line):
        typ, ts = row.get("type"), row.get("timestamp", "")
        text = visible_text(row.get("content", ""))
        reason = row.get("synthetic_reason")
        if typ == "reasoning":
            self.hidden_reasoning += 1
        elif typ == "system":
            self.add(
                "runtime",
                "Runtime instructions · recorded",
                text,
                path,
                line,
                ts,
                "grok:content",
                protected=True,
            )
        elif typ == "user":
            if reason == "compaction_meta":
                # This file is a retained snapshot, not an append-only pre-compaction log.
                self.add(
                    "summary", "Compacted history · recorded", text, path, line, ts, "grok:content"
                )
            elif reason and reason != "human":
                self.add(
                    "instructions",
                    "Runtime injection · " + str(reason),
                    text,
                    path,
                    line,
                    ts,
                    "grok:content",
                    protected=True,
                )
            else:
                self.turn += 1
                self.add("user", "Your prompt", text, path, line, ts, "grok:content")
        elif typ == "assistant":
            self.model = row.get("model_id") or self.model
            self.add("assistant", "Assistant reply", text, path, line, ts, "grok:content")
            for index, call in enumerate(row.get("tool_calls") or []):
                if not isinstance(call, dict):
                    continue
                name = call.get("name") or "Tool call"
                args = visible_text(call.get("arguments", ""))
                self.calls[call.get("id")] = (name, args)
                self.add("calls", name, args, path, line, ts, "grok:call:" + str(index))
        elif typ == "tool_result":
            name, args = self.calls.get(row.get("tool_call_id"), ("Tool", ""))
            self.add(
                result_category(name, args),
                name + " · result",
                text,
                path,
                line,
                ts,
                "grok:content",
            )

    def grok_usage(self, row):
        params = row.get("params") or {}
        meta = params.get("_meta") or {}
        value = meta.get("totalTokens")
        if valid_count(value):
            self.reported = dict(
                input=value,
                cached=0,
                output=0,
                window=None,
                timestamp=row.get("timestamp", ""),
                kind="context",
                label="CONTEXT ESTIMATE",
            )

    def agy(self, row, path, line):
        typ, ts = row.get("type"), row.get("created_at", "")
        if row.get("thinking"):
            self.hidden_reasoning += 1
        if row.get("truncated_fields"):
            self.truncated_records = True
        if typ == "USER_INPUT":
            self.turn += 1
            self.add(
                "user",
                "Your prompt",
                visible_text(row.get("content", "")),
                path,
                line,
                ts,
                "agy:content",
            )
        elif typ == "PLANNER_RESPONSE":
            self.add(
                "assistant",
                "Assistant reply",
                visible_text(row.get("content", "")),
                path,
                line,
                ts,
                "agy:content",
            )
            for index, call in enumerate(row.get("tool_calls") or []):
                if isinstance(call, dict):
                    self.add(
                        "calls",
                        call.get("name") or "Tool call",
                        visible_text(call.get("args", {})),
                        path,
                        line,
                        ts,
                        "agy:call:" + str(index),
                    )
            value = row.get("input_tokens")
            if valid_count(value):
                cached = row.get("cache_read_tokens", 0)
                cached = cached if valid_count(cached) else 0
                self.reported = dict(
                    input=value + cached,
                    cached=cached,
                    output=row.get("output_tokens", 0),
                    window=None,
                    timestamp=ts,
                )
                self.samples.append(dict(self.reported, afterId=len(self.events) - 1))
        elif typ == "GENERIC":
            self.add(
                "results",
                "Recorded result",
                visible_text(row.get("content") or row.get("error", "")),
                path,
                line,
                ts,
                "agy:content",
            )


def summarize(path, home):
    path = allowed(path, home)
    provider = provider_of(path, home)
    parts, notes = chain(path, home) if provider == "codex" else ([(path, None)], [])
    accounting = Accounting()
    if provider == "grok":
        path = canonical_session(path, home, provider)
        parts = [(path, None)]
        updates = allowed(path.with_name("updates.jsonl"), home, provider)
        if updates.is_file():
            parts.append((updates, None))
        data = metadata(path.with_name("summary.json"), home / ".grok/sessions")
        accounting.model = data.get("current_model_id") or ""
        notes.append(
            "Grok shows its own context estimate and the retained chat history. Compaction or rewind can replace that history; pre-compaction history and earlier usage replay are unavailable."
        )
        notes.append(
            "Grok tool definitions outside the chat history are not included in captured text."
        )
    elif provider == "agy":
        notes.append(
            "Antigravity input and cache-read counters are separate and are summed. Model/window capacity and startup instructions are not recorded in this transcript format."
        )
        notes.append(
            "Antigravity result steps are grouped under Tool results. Compaction boundaries are not reconstructed from these transcripts."
        )
    used = 0
    for source, boundary in parts:
        with source.open("rb") as stream:
            line = 0
            while True:
                if boundary is not None and stream.tell() >= boundary:
                    break
                remaining = MAX_BYTES - used
                if remaining <= 0:
                    notes.append("The read limit was reached; this view is partial.")
                    break
                raw = stream.readline(min(MAX_LINE + 1, remaining))
                if not raw:
                    break
                used += len(raw)
                line += 1
                if boundary is not None and stream.tell() > boundary:
                    accounting.malformed += 1
                    break
                if len(raw) > MAX_LINE:
                    notes.append("An oversized record was skipped; this view is partial.")
                    # Finish the record without interpreting its fragments as new lines.
                    while raw and not raw.endswith(b"\n"):
                        remaining = MAX_BYTES - used
                        if remaining <= 0:
                            break
                        raw = stream.readline(min(MAX_LINE, remaining))
                        used += len(raw)
                    continue
                if not raw.endswith(b"\n"):
                    accounting.malformed += 1
                    break
                try:
                    row = json.loads(raw)
                    if provider == "claude":
                        accounting.claude(row, source, line)
                    elif provider == "grok":
                        if source.name == "updates.jsonl":
                            accounting.grok_usage(row)
                        else:
                            accounting.grok(row, source, line)
                    elif provider == "agy":
                        accounting.agy(row, source, line)
                    else:
                        accounting.feed(row, source, line)
                except (ValueError, TypeError, AttributeError):
                    accounting.malformed += 1
    if provider == "grok" and accounting.reported:
        accounting.samples = [dict(accounting.reported, afterId=len(accounting.events) - 1)]
    if accounting.truncated_records:
        notes.append(
            "The provider truncated some recorded fields; text estimates and previews are partial."
        )
    if accounting.malformed:
        notes.append(
            str(accounting.malformed)
            + " incomplete or unsupported records skipped; a pending write is retried on refresh."
        )
    if accounting.hidden_reasoning:
        notes.append(
            "Private reasoning is excluded. Only ordinary messages, tool records and usage counters are inspected."
        )
    if accounting.media:
        notes.append(
            "Image/audio payloads are omitted from text estimates; they may still consume model context."
        )
    if accounting.opaque_compaction:
        notes.append(
            "The compacted summary is opaque in this session format. Its content and token cost cannot be reconstructed; the reported usage still includes provider-accounted context."
        )
    events = accounting.events
    # Preserve the beginning, largest contributors and latest events within a bounded UI payload.
    if len(events) > MAX_EVENTS:
        kept = {
            e["id"]: e
            for e in events[-3500:]
            + sorted(events, key=lambda e: e["tokens"], reverse=True)[:1000]
            + events[:500]
        }
        events = sorted(kept.values(), key=lambda e: int(e["id"]))[-MAX_EVENTS:]
        notes.append(
            "Event list is capped at 5,000 entries; category estimates cover the retained entries only."
        )
    return dict(
        events=events,
        recorded_events=len(accounting.events),
        latest_segment=accounting.segment,
        reported=accounting.reported,
        model=accounting.model,
        notes=notes,
        usage_samples=accounting.samples[-2000:],
        files=len(parts),
        persistent=accounting.persistent,
        all_totals=dict(
            collections.Counter(
                {
                    c: sum(e["tokens"] for e in accounting.events if e["category"] == c)
                    for c in CATEGORIES
                }
            )
        ),
        method="Text estimate = UTF-8 bytes / 4. Category estimates are not an exact decomposition of reported input tokens.",
    )


def signature(path, home):
    provider = provider_of(path, home)
    parts, _ = chain(path, home) if provider == "codex" else ([(path, None)], [])
    if provider == "grok":
        path = canonical_session(path, home, provider)
        parts = [(path, None)]
        updates = allowed(path.with_name("updates.jsonl"), home, provider)
        if updates.is_file():
            parts.append((updates, None))
        summary = path.with_name("summary.json").resolve()
        if summary.is_relative_to((home / ".grok/sessions").resolve()) and summary.is_file():
            parts.append((summary, None))
    values = [
        (
            str(p),
            p.stat().st_mtime_ns if end is None else end,
            p.stat().st_size if end is None else end,
        )
        for p, end in parts
    ]
    return hashlib.sha256(json.dumps(values).encode()).hexdigest()


def detail(request, home):
    if request.get("protected"):
        return dict(
            text="Runtime and developer instruction content is not displayed. Only its recorded size is estimated."
        )
    path = allowed(request["source"], home)
    target = int(request["line"])
    if target <= 0:
        raise ValueError("Invalid event position.")
    with path.open("rb") as stream:
        number = 0
        while True:
            raw = stream.readline(MAX_LINE + 1)
            if not raw:
                break
            number += 1
            if len(raw) > MAX_LINE:
                if number == target:
                    return dict(text="This record is too large to preview.")
                while raw and not raw.endswith(b"\n"):
                    raw = stream.readline(MAX_LINE)
                continue
            if number != target:
                continue
            row = json.loads(raw)
            provider = provider_of(path, home)
            p = row.get("payload", {})
            field = request.get("field", "")
            if provider in ("grok", "agy"):
                if provider == "grok" and (
                    row.get("type") in ("system", "reasoning")
                    or row.get("synthetic_reason") not in (None, "human", "compaction_meta")
                ):
                    return dict(
                        text="Runtime instruction and private reasoning content is not displayed."
                    )
                if field == provider + ":content":
                    text = visible_text(
                        row.get("content") or (row.get("error", "") if provider == "agy" else "")
                    )
                elif field.startswith(provider + ":call:"):
                    call = row.get("tool_calls", [])[int(field.split(":")[-1])]
                    text = visible_text(call.get("arguments" if provider == "grok" else "args", ""))
                else:
                    return dict(text="This field is not available for preview.")
                text = redact(text)
                return dict(text=text[:24000], truncated=len(text) > 24000)
            if field.startswith("replacement:"):
                p = p.get("replacement_history", [])[int(field.split(":")[1])]
            if (
                row.get("type") in ("session_meta", "world_state")
                or p.get("role") in ("system", "developer")
                or p.get("type") == "reasoning"
            ):
                return dict(
                    text="Runtime instruction and private reasoning content is not displayed."
                )
            if field.startswith("claude:"):
                content = (row.get("message") or {}).get("content", [])
                if isinstance(content, str):
                    content = [{"type": "text", "text": content}]
                part = content[int(field.split(":")[1])]
                text = visible_text(part.get("input", part.get("content", part)))
            elif field == "compact":
                text = p.get("message") or "Conversation compacted."
            else:
                text = visible_text(
                    p.get("output", p.get("arguments", p.get("input", p.get("content", ""))))
                )
            text = redact(text)
            return dict(text=text[:24000], truncated=len(text) > 24000)
    return dict(text="The source record is no longer available.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    request, home = json.loads(args.request), Path.home()
    try:
        if request.get("action") == "detail":
            result = detail(request, home)
        else:
            path, candidates, reason, matched = resolve(request, home)
            result = dict(candidates=candidates[:20], reason=reason)
            if path:
                sig = signature(path, home)
                result.update(
                    path=str(path),
                    session_id=session_id(path, home),
                    match=matched,
                    signature=sig,
                )
                if sig == request.get("signature"):
                    result["unchanged"] = True
                else:
                    result.update(summarize(path, home))
    except (OSError, ValueError, TypeError, KeyError, IndexError):
        result = dict(
            error="The session data is unavailable or has an unsupported shape. Choose another session or refresh."
        )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
