"""Independent lifecycle checks; never import a participant's test helpers."""

import asyncio
import inspect

import pytest

import jinja2
from jinja2 import (
    DictLoader,
    Environment,
    FileSystemBytecodeCache,
    ModuleLoader,
    Template,
)
from jinja2.exceptions import SecurityError
from jinja2.nativetypes import NativeEnvironment, NativeTemplate
from jinja2.sandbox import ImmutableSandboxedEnvironment, SandboxedEnvironment


def make_env(factory=Environment, **options):
    events = []
    return factory(render_observer=events.append, **options), events


def lifecycle(events, template, operation, kinds, error=None):
    assert [event.kind for event in events] == kinds
    event_class = getattr(jinja2, "RenderEvent", None)
    assert isinstance(event_class, type), "RenderEvent must be public"
    for event in events:
        assert isinstance(event, event_class)
        assert event.template is template
        assert event.operation == operation
        assert event.error is (error if event.kind == "error" else None)


def invoke(template, operation, **values):
    if operation == "render":
        return template.render(**values)
    if operation == "generate":
        return "".join(template.generate(**values))
    if operation == "make_module":
        return str(template.make_module(values))
    raise AssertionError(operation)


async def invoke_async(template, operation, **values):
    if operation == "render_async":
        return await template.render_async(**values)
    if operation == "generate_async":
        return "".join([item async for item in template.generate_async(**values)])
    if operation == "make_module_async":
        return str(await template.make_module_async(values))
    raise AssertionError(operation)


@pytest.mark.parametrize(
    "factory", [Environment, SandboxedEnvironment, NativeEnvironment]
)
def test_configuration_disabled_and_runtime_attribute(factory):
    env, original = make_env(factory)
    template = env.from_string("{{ value }}")
    assert original == []
    current = []
    env.render_observer = current.append
    assert template.render(value="hello") == "hello"
    lifecycle(current, template, "render", ["start", "success"])
    assert original == []
    env.render_observer = None
    assert template.render(value="later") == "later"
    assert len(current) == 2
    disabled = factory(render_observer=None)
    assert disabled.render_observer is None
    assert disabled.from_string("plain").render() == "plain"


@pytest.mark.parametrize("factory", [Environment, Template, NativeTemplate])
@pytest.mark.parametrize("invalid", [False, 17, "callback", object()])
def test_invalid_configuration(factory, invalid):
    args = ("constant",) if issubclass(factory, Template) else ()
    factory(*args, render_observer=lambda event: None)
    with pytest.raises(TypeError, match="render_observer"):
        factory(*args, render_observer=invalid)


@pytest.mark.parametrize("target", [Environment, Template, Environment.overlay])
def test_new_parameter_is_keyword_only(target):
    make_env()
    assert (
        inspect.signature(target).parameters["render_observer"].kind
        is inspect.Parameter.KEYWORD_ONLY
    )


@pytest.mark.parametrize("mode", ["inherit", "replace", "disable"])
def test_overlay_precedence(mode):
    env, parent = make_env()
    replacement = []
    options = (
        {}
        if mode == "inherit"
        else {"render_observer": replacement.append if mode == "replace" else None}
    )
    overlay = env.overlay(**options)
    template = overlay.from_string("overlay")
    assert template.render() == "overlay"
    if mode == "inherit":
        lifecycle(parent, template, "render", ["start", "success"])
    elif mode == "replace":
        lifecycle(replacement, template, "render", ["start", "success"])
        assert parent == []
    else:
        assert parent == replacement == []
    assert env.render_observer is not None
    with pytest.raises(TypeError, match="render_observer"):
        env.overlay(render_observer=4)


@pytest.mark.parametrize("factory", [Template, NativeTemplate])
def test_direct_templates_accept_unhashable_independent_observers(factory):
    class Collector:
        __hash__ = None

        def __init__(self):
            self.events = []

        def __call__(self, event):
            self.events.append(event)
            return "ignored"

    left, right = Collector(), Collector()
    a = factory("{{ value }}", render_observer=left)
    b = factory("{{ value }}", render_observer=right)
    plain = factory("{{ value }}")
    assert a.render(value="left") == "left"
    assert b.render(value="right") == "right"
    assert plain.render(value="plain") == "plain"
    lifecycle(left.events, a, "render", ["start", "success"])
    lifecycle(right.events, b, "render", ["start", "success"])
    assert plain.environment.render_observer is None


def test_events_are_immutable():
    env, events = make_env()
    template = env.from_string("constant")
    template.render()
    lifecycle(events, template, "render", ["start", "success"])
    for event in events:
        original = (event.kind, event.operation, event.template, event.error)
        for field in ("kind", "operation", "template", "error"):
            with pytest.raises((AttributeError, TypeError)):
                setattr(event, field, "changed")
        assert (event.kind, event.operation, event.template, event.error) == original


@pytest.mark.parametrize("operation", ["render", "generate", "make_module"])
def test_sync_lifecycle_and_output(operation):
    env, events = make_env(
        autoescape=True, loader=DictLoader({"example": "<b>{{ value }}</b>"})
    )
    template = env.get_template("example")
    assert events == []
    assert (
        invoke(template, operation, value="café <中文>") == "<b>café &lt;中文&gt;</b>"
    )
    lifecycle(events, template, operation, ["start", "success"])


@pytest.mark.parametrize("operation", ["render", "generate", "make_module"])
@pytest.mark.parametrize("base_exception", [False, True])
def test_render_failures_keep_exception_identity_and_traceback(
    operation, base_exception
):
    class StopRendering(BaseException):
        pass

    error = StopRendering("stop") if base_exception else ValueError("template failure")

    def fail():
        raise error

    env, events = make_env(loader=DictLoader({"broken": "first\n{{ fail() }}"}))
    env.globals["fail"] = fail
    template = env.get_template("broken")
    with pytest.raises(type(error)) as caught:
        invoke(template, operation)
    assert caught.value is error
    lifecycle(events, template, operation, ["start", "error"], error)
    frames = []
    tb = error.__traceback__
    while tb:
        frames.append(tb.tb_frame.f_code.co_filename)
        tb = tb.tb_next
    assert any("template" in name for name in frames)


@pytest.mark.parametrize("operation", ["render", "generate"])
def test_argument_preparation_failure_is_observed(operation):
    env, events = make_env()
    template = env.from_string("constant")
    with pytest.raises(TypeError) as caught:
        result = getattr(template, operation)(1)
        if operation == "generate":
            list(result)
    lifecycle(events, template, operation, ["start", "error"], caught.value)


@pytest.mark.parametrize("operation", ["render", "generate", "make_module"])
@pytest.mark.parametrize("failure_kind", ["start", "success", "error"])
def test_observer_failure_is_not_recursively_observed(operation, failure_kind):
    observer_error = RuntimeError("observer failure")
    observed = []
    effects = []

    def observer(event):
        observed.append(event)
        if event.kind == failure_kind:
            raise observer_error

    def execute():
        effects.append("executed")
        if failure_kind == "error":
            raise ValueError("render failure")
        return "value"

    env = Environment(render_observer=observer)
    template = env.from_string("{{ execute() }}")
    with pytest.raises(RuntimeError) as caught:
        invoke(template, operation, execute=execute)
    assert caught.value is observer_error
    assert [event.kind for event in observed] == (
        ["start"] if failure_kind == "start" else ["start", failure_kind]
    )
    assert effects == ([] if failure_kind == "start" else ["executed"])


def test_sync_generator_laziness_close_and_underlying_cleanup():
    env, events = make_env()
    template = env.from_string("{% for item in values %}{{ item }}{% endfor %}")
    advanced, closed = [], []
    original = template.root_render_func

    def values():
        for item in range(4):
            advanced.append(item)
            yield item

    def root(context):
        try:
            yield from original(context)
        finally:
            closed.append(True)

    template.root_render_func = root
    unused = template.generate(values=values())
    unused.close()
    assert events == advanced == closed == []
    stream = template.generate(values=values())
    assert events == advanced == []
    assert next(stream) == "0"
    assert advanced == [0], "observation must not eagerly consume the template"
    lifecycle(events, template, "generate", ["start"])
    stream.close()
    stream.close()
    lifecycle(events, template, "generate", ["start", "close"])
    assert closed == [True]


@pytest.mark.parametrize("buffered", [False, True])
def test_template_stream_and_exhaustion(buffered):
    env, events = make_env()
    template = env.from_string("{% for item in range(4) %}{{ item }}{% endfor %}")
    stream = template.stream()
    if buffered:
        stream.enable_buffering(2)
    assert events == []
    chunks = list(stream)
    assert "".join(chunks) == "0123"
    if buffered:
        assert chunks == ["01", "23"]
    lifecycle(events, template, "generate", ["start", "success"])
    events.clear()
    raw = template.generate()
    assert "".join(raw) == "0123"
    raw.close()
    lifecycle(events, template, "generate", ["start", "success"])


def test_interleaved_generators_capture_their_observer_once():
    env, left = make_env()
    a = env.from_string("A{{ value }}Z")
    b = env.from_string("B{{ value }}Z")
    first = a.generate(value="x")
    assert next(first) == "A"
    right = []
    env.render_observer = right.append
    second = b.generate(value="y")
    assert next(second) == "B"
    first.close()
    assert "".join(second) == "yZ"
    lifecycle(left, a, "generate", ["start", "close"])
    lifecycle(right, b, "generate", ["start", "success"])


def test_replacing_observer_from_start_does_not_split_the_lifecycle():
    old, new = [], []
    env = Environment(render_observer=old.append)

    def observer(event):
        old.append(event)
        env.render_observer = new.append

    env.render_observer = observer
    template = env.from_string("constant")
    template.render()
    lifecycle(old, template, "render", ["start", "success"])
    assert new == []
    template.render()
    lifecycle(new, template, "render", ["start", "success"])


@pytest.mark.parametrize(
    "operation", ["render_async", "generate_async", "make_module_async"]
)
def test_async_success_and_error(operation):
    async def scenario():
        env, events = make_env(enable_async=True)
        template = env.from_string("{{ value() }}")

        async def value():
            return "async café"

        assert await invoke_async(template, operation, value=value) == "async café"
        lifecycle(events, template, operation, ["start", "success"])
        events.clear()
        error = ValueError("async render failure")

        async def fail():
            raise error

        with pytest.raises(ValueError) as caught:
            await invoke_async(template, operation, value=fail)
        assert caught.value is error
        lifecycle(events, template, operation, ["start", "error"], error)

    asyncio.run(scenario())


@pytest.mark.parametrize("operation", ["render_async", "generate_async"])
def test_async_api_on_sync_environment_reports_the_error(operation):
    async def scenario():
        env, events = make_env()
        template = env.from_string("constant")
        with pytest.raises(RuntimeError) as caught:
            await invoke_async(template, operation)
        lifecycle(events, template, operation, ["start", "error"], caught.value)

    asyncio.run(scenario())


@pytest.mark.parametrize("operation", ["render", "generate"])
def test_sync_async_bridge_reports_only_the_public_operation(operation):
    env, events = make_env(enable_async=True)
    template = env.from_string("{{ value() }}")

    async def value():
        return "bridged"

    assert invoke(template, operation, value=value) == "bridged"
    lifecycle(events, template, operation, ["start", "success"])


def test_async_generator_lifetime_closes_underlying_generator():
    async def scenario():
        env, events = make_env(enable_async=True)
        template = env.from_string("A{{ value }}Z")
        closed = []
        original = template.root_render_func

        async def root(context):
            generator = original(context)
            try:
                async for chunk in generator:
                    yield chunk
            finally:
                await generator.aclose()
                closed.append(True)

        template.root_render_func = root
        unused = template.generate_async(value="x")
        await unused.aclose()
        assert events == closed == []
        stream = template.generate_async(value="x")
        assert events == []
        assert await stream.__anext__() == "A"
        await stream.aclose()
        await stream.aclose()
        lifecycle(events, template, "generate_async", ["start", "close"])
        assert closed == [True]
        events.clear()
        assert await invoke_async(template, "generate_async", value="x") == "AxZ"
        lifecycle(events, template, "generate_async", ["start", "success"])

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "operation", ["render_async", "generate_async", "make_module_async"]
)
def test_async_cancellation_retains_original_exception(operation):
    async def scenario():
        env, events = make_env(enable_async=True)
        entered = asyncio.Event()
        blocker = asyncio.Event()

        async def wait():
            entered.set()
            await blocker.wait()

        template = env.from_string("{{ wait() }}")
        task = asyncio.create_task(invoke_async(template, operation, wait=wait))
        await asyncio.wait_for(entered.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError) as caught:
            await task
        lifecycle(events, template, operation, ["start", "error"], caught.value)

    asyncio.run(scenario())


def test_concurrent_async_renders_remain_independent():
    async def scenario():
        env, events = make_env(enable_async=True)
        a = env.from_string("A{{ value() }}")
        b = env.from_string("B{{ value() }}")
        both = asyncio.Event()
        entered = []

        async def value():
            entered.append(True)
            if len(entered) == 2:
                both.set()
            await both.wait()
            return "x"

        results = await asyncio.wait_for(
            asyncio.gather(a.render_async(value=value), b.render_async(value=value)), 2
        )
        assert results == ["Ax", "Bx"]
        lifecycle(
            [event for event in events if event.template is a],
            a,
            "render_async",
            ["start", "success"],
        )
        lifecycle(
            [event for event in events if event.template is b],
            b,
            "render_async",
            ["start", "success"],
        )

    asyncio.run(scenario())


@pytest.mark.parametrize("asynchronous", [False, True])
def test_application_nested_rendering_is_not_suppressed(asynchronous):
    env, events = make_env(enable_async=asynchronous)
    child = env.from_string("child")
    parent = env.from_string("parent:{{ call_child() }}")
    if asynchronous:
        result = asyncio.run(parent.render_async(call_child=child.render_async))
        operation = "render_async"
    else:
        result = parent.render(call_child=child.render)
        operation = "render"
    assert result == "parent:child"
    assert [(event.template, event.kind, event.operation) for event in events] == [
        (parent, "start", operation),
        (child, "start", operation),
        (child, "success", operation),
        (parent, "success", operation),
    ]


@pytest.mark.parametrize("asynchronous", [False, True])
def test_native_results_preserve_identity(asynchronous):
    env, events = make_env(NativeEnvironment, enable_async=asynchronous)
    template = env.from_string("{{ value }}")
    value = {"items": [1, 2], "unicode": "中文"}
    result = (
        asyncio.run(template.render_async(value=value))
        if asynchronous
        else template.render(value=value)
    )
    assert result is value
    operation = "render_async" if asynchronous else "render"
    lifecycle(events, template, operation, ["start", "success"])


@pytest.mark.parametrize(
    "factory", [SandboxedEnvironment, ImmutableSandboxedEnvironment]
)
def test_sandbox_keeps_security_failures(factory):
    env, events = make_env(factory)
    template = env.from_string("{{ object.__class__.__mro__ }}")
    with pytest.raises(SecurityError) as caught:
        template.render(object=42)
    lifecycle(events, template, "render", ["start", "error"], caught.value)


@pytest.mark.parametrize("asynchronous", [False, True])
def test_module_exports_and_module_cache(asynchronous):
    env, events = make_env(enable_async=asynchronous)
    template = env.from_string(
        "{% set answer = 42 %}{% macro greet(name) %}Hi {{ name }}{% endmacro %}body"
    )
    if asynchronous:
        module = asyncio.run(template.make_module_async())
        operation = "make_module_async"
        greeting = asyncio.run(module.greet("reader"))
    else:
        module = template.module
        assert template.module is module
        operation = "make_module"
        greeting = module.greet("reader")
    assert module.answer == 42
    assert greeting == "Hi reader"
    assert str(module) == "body"
    lifecycle(events, template, operation, ["start", "success"])


def test_imports_observe_actual_module_construction_and_cache():
    env, events = make_env(
        loader=DictLoader(
            {
                "main": '{% import "lib" as lib %}{{ lib.greet() }}',
                "lib": "{% macro greet() %}hello{% endmacro %}",
            }
        )
    )
    main = env.get_template("main")
    assert main.render() == "hello"
    assert [(event.template.name, event.operation, event.kind) for event in events] == [
        ("main", "render", "start"),
        ("lib", "make_module", "start"),
        ("lib", "make_module", "success"),
        ("main", "render", "success"),
    ]
    events.clear()
    assert main.render() == "hello"
    lifecycle(events, main, "render", ["start", "success"])


def test_inheritance_includes_extensions_and_expression_compilation():
    env, events = make_env(
        loader=DictLoader(
            {
                "base": "A{% block body %}{% endblock %}Z",
                "main": '{% extends "base" %}{% block body %}{% do values.append("seen") %}{% include "part" %}{% endblock %}',
                "part": "{{ value }}",
            }
        ),
        extensions=["jinja2.ext.do"],
    )
    template = env.get_template("main")
    assert env.compile_expression("number + 1")(number=2) == 3
    assert events == []
    values = []
    assert template.render(value="middle", values=values) == "AmiddleZ"
    assert values == ["seen"]
    lifecycle(events, template, "render", ["start", "success"])


def test_loader_and_bytecode_cache_use_invocation_environment(tmp_path):
    loader = DictLoader({"page": "{{ value }}"})
    cache = FileSystemBytecodeCache(str(tmp_path))
    env, first = make_env(loader=loader, bytecode_cache=cache)
    template = env.get_template("page")
    assert env.get_template("page") is template
    assert first == []
    assert template.render(value="first") == "first"
    other, second = make_env(loader=loader, bytecode_cache=cache)
    cached = other.get_template("page")
    assert second == []
    assert cached.render(value="second") == "second"
    lifecycle(first, template, "render", ["start", "success"])
    lifecycle(second, cached, "render", ["start", "success"])


def test_compiled_module_loader_uses_the_current_observer(tmp_path):
    env, compiling = make_env(loader=DictLoader({"page": "Hello {{ name }}"}))
    env.compile_templates(str(tmp_path), zip=None)
    assert compiling == []
    runtime, events = make_env(loader=ModuleLoader(str(tmp_path)))
    template = runtime.get_template("page")
    assert events == []
    assert template.render(name="reader") == "Hello reader"
    lifecycle(events, template, "render", ["start", "success"])
