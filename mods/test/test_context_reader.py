import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ENTRY = Path(__file__).resolve().parents[1] / "vectron-context" / "inspect_session.py"
SPEC = importlib.util.spec_from_file_location("inspect_session", ENTRY)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class ReaderCommandTests(unittest.TestCase):
    def test_snapshot_and_unchanged_responses_share_a_signature(self):
        with tempfile.TemporaryDirectory() as home:
            home = Path(home)
            session = home / ".codex/sessions/rollout-test.jsonl"
            session.parent.mkdir(parents=True)
            session.write_text(
                json.dumps(
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "message",
                            "role": "user",
                            "content": "Sample prompt",
                        },
                    }
                )
                + "\n"
            )

            def read(**params):
                request = json.dumps(params)
                output = io.StringIO()
                with (
                    patch.object(Path, "home", return_value=home),
                    patch.object(sys, "argv", [str(ENTRY), "--request", request]),
                    redirect_stdout(output),
                ):
                    m.main()
                return json.loads(output.getvalue())

            full = read(provider="codex", path=str(session))
            self.assertEqual(full["events"][0]["category"], "user")
            unchanged = read(provider="codex", path=str(session), signature=full["signature"])
            self.assertTrue(unchanged["unchanged"])
            self.assertNotIn("events", unchanged)
            self.assertEqual(unchanged["path"], str(session.resolve()))


class RedactionTests(unittest.TestCase):
    def test_each_secret_pattern_is_redacted_in_mixed_text(self):
        private_key = "private key content"
        fixtures = {
            f"-----BEGIN RSA PRIVATE KEY-----\n{private_key}\n-----END RSA PRIVATE KEY-----": private_key,
            "sk-" + "x" * 20: "x" * 20,
            "ghp_" + "y" * 20: "y" * 20,
            "github_pat_" + "z" * 20: "z" * 20,
            "AKIA" + "A" * 16: "A" * 16,
            "bEaReR\t" + "B" * 24: "B" * 24,
            '{"api_key":"fixture credential"}': "fixture credential",
            'password = "fixture passphrase"': "fixture passphrase",
            "ACCESS_TOKEN=fixture-secret": "fixture-secret",
        }
        for text, secret in fixtures.items():
            with self.subTest(text=text):
                output = m.redact(f"Prefix: {text}\nSuffix")
                self.assertNotIn(secret, output)
                self.assertIn("redacted", output)
                self.assertTrue(output.startswith("Prefix: "))
                self.assertTrue(output.endswith("\nSuffix"))

    def test_plain_text_and_non_secret_punctuation_are_preserved(self):
        for text in ["Keep this résumé", "password reminder", "time: 10:20", "count=42"]:
            with self.subTest(text=text):
                self.assertEqual(m.redact(text), text)


class CodexAccountingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.root = self.home / ".codex/sessions/2026/11/16"
        self.root.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, records):
        path = self.root / ("rollout-" + name + ".jsonl")
        path.write_text("".join(json.dumps(r) + "\n" for r in records))
        return path

    def record(self, typ, **payload):
        return dict(type=typ, payload=payload, timestamp="2026-11-16T12:00:00Z")

    def test_usage_counts_cached_input_once_and_ignores_mirror_and_reasoning(self):
        path = self.write(
            "usage000",
            [
                self.record(
                    "response_item",
                    type="message",
                    role="user",
                    content=[dict(type="input_text", text="hello")],
                ),
                self.record("event_msg", type="user_message", message="hello"),
                self.record("response_item", type="reasoning", encrypted_content="opaque" * 1000),
                self.record(
                    "event_msg",
                    type="token_count",
                    info=dict(
                        last_token_usage=dict(
                            input_tokens=1000, cached_input_tokens=800, output_tokens=60
                        ),
                        model_context_window=4000,
                    ),
                ),
            ],
        )
        result = m.summarize(path, self.home)
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["reported"]["input"], 1000)
        self.assertEqual(result["reported"]["cached"], 800)
        self.assertTrue(any("reasoning" in note for note in result["notes"]))

    def test_fork_import_stops_at_recorded_boundary_and_compaction_starts_segment(self):
        parent = self.write(
            "parent00",
            [
                self.record("session_meta", id="parent00"),
                self.record("response_item", type="message", role="user", content="before fork"),
            ],
        )
        boundary = parent.stat().st_size
        with parent.open("a") as f:
            f.write(
                json.dumps(
                    self.record(
                        "response_item",
                        type="message",
                        role="user",
                        content="different later branch",
                    )
                )
                + "\n"
            )
        child = self.write(
            "child000",
            [
                self.record(
                    "session_meta",
                    id="child000",
                    history_base=dict(thread_id="parent00", end_byte_offset=boundary),
                ),
                self.record("compacted", message="saved summary"),
                self.record("response_item", type="message", role="user", content="after compact"),
            ],
        )
        result = m.summarize(child, self.home)
        self.assertEqual(result["files"], 2)
        self.assertEqual(result["latest_segment"], 1)
        self.assertNotIn("different later branch", str(result["events"]))
        self.assertEqual([e["segment"] for e in result["events"]], [0, 1, 1])

    def test_instruction_snapshots_replace_and_protected_text_is_not_exposed(self):
        path = self.write(
            "world000",
            [
                self.record("session_meta", base_instructions=dict(text="private runtime words")),
                self.record("world_state", state=dict(agents_md="old instructions")),
                self.record("world_state", state=dict(agents_md="new instructions")),
            ],
        )
        result = m.summarize(path, self.home)
        self.assertEqual(result["persistent"]["world:agents_md"], result["events"][-1]["id"])
        self.assertNotIn("private runtime words", str(result["events"]))
        self.assertNotIn("new instructions", str(result["events"]))
        preview = m.detail(dict(source=str(path), line=1), self.home)
        self.assertNotIn("private runtime words", preview["text"])

    def test_partial_tail_retries_and_media_payload_is_not_counted_as_text(self):
        path = self.write(
            "partial0",
            [
                self.record(
                    "response_item",
                    type="message",
                    role="user",
                    content=[
                        dict(type="input_image", image_url="data:image/png;base64," + "A" * 300000)
                    ],
                )
            ],
        )
        with path.open("a") as f:
            f.write('{"type":"response_item"')
        result = m.summarize(path, self.home)
        self.assertLess(result["events"][0]["tokens"], 20)
        self.assertTrue(any("incomplete" in n for n in result["notes"]))
        self.assertTrue(any("Image/audio" in n for n in result["notes"]))

    def test_read_limit_keeps_recent_events_usage_and_preview_offsets(self):
        path = self.write(
            "large000",
            [
                self.record("response_item", type="message", role="user", content="old" * 1500),
                self.record("response_item", type="message", role="user", content="latest"),
                self.record(
                    "event_msg", type="token_count", info=dict(last_token_usage=dict(input_tokens=42))
                ),
            ],
        )
        with patch.object(m, "MAX_BYTES", 640):
            snapshot = m.summarize(path, self.home)
            self.assertTrue(any("read limit" in note for note in snapshot["notes"]))
            self.assertEqual(snapshot["reported"]["input"], 42)
            (event,) = snapshot["events"]
            self.assertEqual(m.detail(event, self.home)["text"], "latest")

            reply = self.record("response_item", type="message", role="assistant", content="new reply")
            with path.open("a") as stream:
                stream.write(json.dumps(reply) + "\n")
            self.assertEqual(m.summarize(path, self.home)["events"][0]["id"], event["id"])

    def test_redaction_and_source_boundary(self):
        secret = "sk-" + "a" * 40
        self.assertNotIn(secret, m.redact("key " + secret))
        self.assertNotIn("secret-value", m.redact('{"access_token":"secret-value"}'))
        self.assertNotIn("secret-value", m.redact("TYPESAFE_API_KEY=secret-value"))
        outside = self.home / "credentials.jsonl"
        outside.write_text("private")
        with self.assertRaises(ValueError):
            m.detail(dict(source=str(outside), line=1), self.home)

    def test_compaction_replacement_preview_and_opaque_summary(self):
        path = self.write(
            "compact0",
            [
                self.record(
                    "compacted",
                    message="",
                    replacement_history=[
                        dict(type="message", role="developer", content="private instructions"),
                        dict(type="message", role="user", content="retained prompt"),
                        dict(type="compaction", encrypted_content="opaque payload"),
                        dict(type="additional_tools", tools=[dict(name="example")]),
                    ],
                )
            ],
        )
        result = m.summarize(path, self.home)
        prompt = next(e for e in result["events"] if e["category"] == "user")
        self.assertEqual(
            m.detail(dict(source=str(path), line=1, field=prompt["field"]), self.home)["text"],
            "retained prompt",
        )
        self.assertNotIn(
            "private instructions",
            m.detail(dict(source=str(path), line=1, field="replacement:0"), self.home)["text"],
        )
        self.assertNotIn("opaque payload", str(result))
        self.assertTrue(any("summary is opaque" in n for n in result["notes"]))
        self.assertEqual(result["events"][-1]["category"], "tools")

    def test_serialized_tool_media_is_omitted(self):
        output = json.dumps(
            dict(
                content=[
                    dict(type="image", data="A" * 300000),
                    dict(type="text", text="visible text"),
                ]
            )
        )
        self.assertLess(len(m.visible_text(output)), 100)
        self.assertIn("visible text", m.visible_text(output))


class OtherProvidersTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name).resolve()
        self.grok = self.home / ".grok/sessions/workspace/grok-session/chat_history.jsonl"
        self.agy = (
            self.home
            / ".gemini/antigravity-cli/brain/agy-session/.system_generated/logs/transcript.jsonl"
        )

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, rows):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(row) + "\n" for row in rows))
        return path

    def grok_metadata(self):
        self.grok.with_name("summary.json").write_text(
            json.dumps(
                dict(
                    info=dict(id="grok-session", cwd="/project"),
                    generated_title="Grok title",
                    current_model_id="grok-model",
                )
            )
        )

    def test_grok_uses_retained_history_without_counting_update_mirrors_or_reasoning(self):
        self.write(
            self.grok,
            [
                dict(type="system", content="private runtime"),
                dict(type="user", synthetic_reason="compaction_meta", content="saved summary"),
                dict(type="user", content=[dict(type="text", text="inspect a file")]),
                dict(
                    type="user", synthetic_reason="system_reminder", content="private injected rule"
                ),
                dict(type="reasoning", encrypted_content="private hidden reasoning"),
                dict(
                    type="assistant",
                    content="checking",
                    model_id="grok-model",
                    tool_calls=[
                        dict(id="call", name="read_file", arguments='{"path":"example.py"}')
                    ],
                ),
                dict(type="tool_result", tool_call_id="call", content="file contents"),
            ],
        )
        self.grok_metadata()
        self.write(
            self.grok.with_name("updates.jsonl"),
            [
                dict(timestamp=1000, params=dict(_meta=dict(totalTokens=5000))),
                dict(
                    timestamp=2000,
                    params=dict(
                        _meta=dict(totalTokens=1200),
                        update=dict(
                            sessionUpdate="agent_message_chunk",
                            content=dict(type="text", text="checking"),
                        ),
                    ),
                ),
            ],
        )
        result = m.summarize(self.grok, self.home)
        self.assertEqual(result["reported"]["input"], 1200)
        self.assertEqual(result["reported"]["kind"], "context")
        self.assertIsNone(result["reported"]["window"])
        self.assertEqual(result["model"], "grok-model")
        self.assertEqual(len(result["usage_samples"]), 1)
        self.assertEqual(result["usage_samples"][0]["afterId"], int(result["events"][-1]["id"]))
        self.assertEqual(
            [e["category"] for e in result["events"]],
            ["runtime", "summary", "user", "instructions", "assistant", "calls", "files"],
        )
        self.assertEqual(result["latest_segment"], 0)
        self.assertNotIn("private hidden reasoning", str(result))
        self.assertNotIn("private injected rule", str(result))
        for event in result["events"]:
            request = dict(source=event["source"], offset=event["offset"], field=event["field"])
            preview = m.detail(request, self.home)["text"]
            if event["protected"]:
                self.assertNotIn("private runtime", preview)
                self.assertNotIn("private injected rule", preview)
            elif event["category"] == "files":
                self.assertEqual(preview, "file contents")
            elif event["category"] == "calls":
                self.assertIn("example.py", preview)

    def test_grok_refreshes_when_only_usage_changes_and_does_not_fabricate_missing_usage(self):
        self.write(self.grok, [dict(type="user", content="hello")])
        before = m.signature(self.grok, self.home)
        self.assertIsNone(m.summarize(self.grok, self.home)["reported"])
        self.write(
            self.grok.with_name("updates.jsonl"), [dict(params=dict(_meta=dict(totalTokens=0)))]
        )
        self.assertNotEqual(m.signature(self.grok, self.home), before)
        self.assertEqual(m.summarize(self.grok, self.home)["reported"]["input"], 0)

    def test_agy_separate_cache_buckets_and_previews_exclude_thinking(self):
        self.write(
            self.agy,
            [
                dict(
                    step_index=0,
                    type="USER_INPUT",
                    created_at="2026-11-16T12:00:00Z",
                    content="inspect this",
                ),
                dict(
                    step_index=1,
                    type="PLANNER_RESPONSE",
                    input_tokens=10,
                    cache_read_tokens=90,
                    output_tokens=3,
                    thinking="PRIVATE THOUGHT",
                    content="visible reply",
                    tool_calls=[dict(name="view_file", args=dict(Path="example.py"))],
                ),
                dict(
                    step_index=2,
                    type="GENERIC",
                    content="recorded file text",
                    truncated_fields=["content"],
                ),
            ],
        )
        # The full export mirrors these steps; it must never be counted a second time.
        self.write(
            self.agy.with_name("transcript_full.jsonl"),
            [dict(type="USER_INPUT", content="duplicate")],
        )
        result = m.summarize(self.agy, self.home)
        self.assertEqual(result["reported"]["input"], 100)
        self.assertEqual(result["reported"]["cached"], 90)
        self.assertIsNone(result["reported"]["window"])
        self.assertEqual(
            [e["category"] for e in result["events"]], ["user", "assistant", "calls", "results"]
        )
        self.assertNotIn("PRIVATE THOUGHT", str(result))
        self.assertNotIn("duplicate", str(result))
        self.assertTrue(any("truncated" in note for note in result["notes"]))
        request = dict(source=str(self.agy), line=2, field="agy:content")
        self.assertEqual(m.detail(request, self.home)["text"], "visible reply")
        request["field"] = "agy:call:0"
        self.assertIn("example.py", m.detail(request, self.home)["text"])
        request["field"] = "thinking"
        self.assertNotIn("PRIVATE THOUGHT", m.detail(request, self.home)["text"])

    def test_new_sources_reject_auth_files_cross_provider_paths_and_symlink_escapes(self):
        self.write(self.grok, [])
        self.write(self.agy, [])
        for path in [
            self.home / ".grok/auth.json",
            self.agy.with_name("transcript_full.jsonl"),
            self.home / ".gemini/antigravity-cli/history.jsonl",
        ]:
            with self.assertRaises(ValueError):
                m.allowed(path, self.home)
        with self.assertRaises(ValueError):
            m.resolve(dict(provider="grok", path=str(self.agy)), self.home)
        outside = self.home / "private.jsonl"
        outside.write_text("private")
        self.grok.unlink()
        self.grok.symlink_to(outside)
        with self.assertRaises(ValueError):
            m.allowed(self.grok, self.home)

    def test_claude_counts_cache_buckets_and_previews_only_visible_reply(self):
        path = self.write(
            self.home / ".claude/projects/sample/session.jsonl",
            [
                dict(
                    type="assistant",
                    message=dict(
                        model="test",
                        usage=dict(
                            input_tokens=10,
                            cache_read_input_tokens=20,
                            cache_creation_input_tokens=30,
                        ),
                        content=[
                            dict(type="thinking", thinking="private reasoning"),
                            dict(type="text", text="reply"),
                        ],
                    ),
                ),
            ],
        )

        result = m.summarize(path, self.home)
        self.assertEqual(result["reported"]["input"], 60)
        self.assertEqual(len(result["events"]), 1)
        self.assertNotIn("private reasoning", str(result["events"]))
