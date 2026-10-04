"""Independent public-behavior checks frozen before either model runs."""
import asyncio
import gzip
import inspect
import zlib
from unittest.mock import patch

import httpx
import pytest


URL = "https://body-limit.invalid/"
KINDS = ["sync", "async"]
METHODS = ["get", "head", "options", "post", "put", "patch", "delete"]


class SyncStream(httpx.SyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
        self.reads = 0
        self.closes = 0

    def __iter__(self):
        for chunk in self.chunks:
            self.reads += 1
            yield chunk

    def close(self):
        self.closes += 1


class AsyncStream(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
        self.reads = 0
        self.closes = 0

    async def __aiter__(self):
        for chunk in self.chunks:
            self.reads += 1
            yield chunk

    async def aclose(self):
        self.closes += 1


def make_client(kind, chunks, *, headers=None, buffered=False, **options):
    stream = (SyncStream if kind == "sync" else AsyncStream)(chunks)
    seen = []

    def handler(request):
        seen.append(request)
        kwargs = {"content": b"".join(chunks)} if buffered else {"stream": stream}
        return httpx.Response(200, headers=headers, **kwargs)

    cls = httpx.Client if kind == "sync" else httpx.AsyncClient
    return cls(transport=httpx.MockTransport(handler), **options), stream, seen


def send(kind, client, **options):
    if kind == "sync":
        return client.get(URL, **options)
    return asyncio.run(client.get(URL, **options))


def close(kind, client):
    if kind == "sync":
        client.close()
    else:
        asyncio.run(client.aclose())


@pytest.mark.parametrize("kind", KINDS)
def test_public_api_and_exception(kind):
    cls = httpx.Client if kind == "sync" else httpx.AsyncClient
    with pytest.raises(ValueError):
        cls(max_response_bytes=-1)
    assert issubclass(httpx.ResponseTooLarge, httpx.RequestError)
    for name in ["request", "stream", "send", "build_request", *METHODS]:
        assert "max_response_bytes" in inspect.signature(getattr(cls, name)).parameters
    for name in ["request", "stream", *METHODS]:
        assert "max_response_bytes" in inspect.signature(getattr(httpx, name)).parameters


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("limit,body,allowed", [(0, b"", True), (0, b"x", False),
    (5, b"12345", True), (4, b"12345", False), (None, b"123456789", True)])
def test_boundaries_and_idempotent_buffered_reads(kind, limit, body, allowed):
    client, stream, seen = make_client(kind, [body], max_response_bytes=limit)
    try:
        assert client.max_response_bytes == limit
        if allowed:
            response = send(kind, client)
            assert response.content == body
            if kind == "sync":
                assert response.read() == response.read() == body
                assert b"".join(response.iter_bytes(chunk_size=1)) == body
            else:
                async def again():
                    assert await response.aread() == await response.aread() == body
                    return b"".join([chunk async for chunk in response.aiter_bytes(chunk_size=1)])
                assert asyncio.run(again()) == body
        else:
            with pytest.raises(httpx.ResponseTooLarge) as caught:
                send(kind, client)
            assert caught.value.limit == limit
            assert caught.value.received == len(body)
            assert caught.value.request is seen[0]
            assert str(limit) in str(caught.value)
        assert stream.closes == 1
    finally:
        close(kind, client)


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("bad,error", [(True, TypeError), (False, TypeError), (1.5, TypeError),
    ("4", TypeError), ([], TypeError), (-2, ValueError)])
def test_validation_precedes_transport(kind, bad, error):
    cls = httpx.Client if kind == "sync" else httpx.AsyncClient
    with pytest.raises(error):
        cls(max_response_bytes=bad)
    client, _, seen = make_client(kind, [b"hello"])
    try:
        with pytest.raises(error):
            send(kind, client, max_response_bytes=bad)
        with pytest.raises(error):
            client.build_request("GET", URL, max_response_bytes=bad)
        request = httpx.Request("GET", URL)
        with pytest.raises(error):
            if kind == "sync":
                client.send(request, max_response_bytes=bad)
            else:
                asyncio.run(client.send(request, max_response_bytes=bad))
        assert not seen
    finally:
        close(kind, client)


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("method", METHODS)
def test_convenience_override_none_and_per_request_isolation(kind, method):
    cls = httpx.Client if kind == "sync" else httpx.AsyncClient
    client = cls(max_response_bytes=2, transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"hello")))
    try:
        def call(**kwargs):
            result = getattr(client, method)(URL, **kwargs)
            return result if kind == "sync" else asyncio.run(result)
        assert call(max_response_bytes=None).content == b"hello"
        assert call(max_response_bytes=5).content == b"hello"
        with pytest.raises(httpx.ResponseTooLarge):
            call()
        assert client.max_response_bytes == 2
    finally:
        close(kind, client)


@pytest.mark.parametrize("kind", KINDS)
def test_build_request_send_precedence_and_caller_extensions(kind):
    cls = httpx.Client if kind == "sync" else httpx.AsyncClient
    client = cls(max_response_bytes=2, transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"hello")))
    source = {"trace": "keep"}
    request = client.build_request("GET", URL, extensions=source, max_response_bytes=4)
    assert source == {"trace": "keep"}
    assert request.extensions["max_response_bytes"] == 4
    before = dict(request.extensions)
    try:
        def dispatch(req, **kwargs):
            result = client.send(req, **kwargs)
            return result if kind == "sync" else asyncio.run(result)
        assert dispatch(request, max_response_bytes=None).content == b"hello"
        assert request.extensions == before
        with pytest.raises(httpx.ResponseTooLarge):
            dispatch(request)
        with pytest.raises(httpx.ResponseTooLarge):
            dispatch(httpx.Request("GET", URL))
        assert dispatch(client.build_request("GET", URL, max_response_bytes=None)).content == b"hello"
        assert request.extensions == before
    finally:
        close(kind, client)


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("consumer", ["read", "bytes", "text", "lines"])
def test_decoded_consumers_close_and_stop_at_overflow(kind, consumer):
    client, stream, _ = make_client(kind, [b"ab", b"cdef", b"unread"], max_response_bytes=4)
    try:
        with pytest.raises(httpx.ResponseTooLarge) as caught:
            if kind == "sync":
                with client.stream("GET", URL) as response:
                    if consumer == "read":
                        response.read()
                    else:
                        list(getattr(response, "iter_" + consumer)())
            else:
                async def consume():
                    async with client.stream("GET", URL) as response:
                        if consumer == "read":
                            await response.aread()
                        else:
                            return [chunk async for chunk in getattr(response, "aiter_" + consumer)()]
                asyncio.run(consume())
        assert caught.value.received == 6
        assert stream.reads == 2
        assert stream.closes == 1
    finally:
        close(kind, client)


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("chunk_size", [None, 2, 16])
def test_limit_is_checked_before_output_chunking(kind, chunk_size):
    client, stream, _ = make_client(kind, [b"ab", b"cdef", b"unread"], max_response_bytes=4)
    yielded = []
    try:
        with pytest.raises(httpx.ResponseTooLarge):
            if kind == "sync":
                with client.stream("GET", URL) as response:
                    for chunk in response.iter_bytes(chunk_size=chunk_size):
                        yielded.append(chunk)
            else:
                async def consume():
                    async with client.stream("GET", URL) as response:
                        async for chunk in response.aiter_bytes(chunk_size=chunk_size):
                            yielded.append(chunk)
                asyncio.run(consume())
        assert yielded == ([] if chunk_size == 16 else [b"ab"])
        assert stream.reads == 2
        assert stream.closes == 1
    finally:
        close(kind, client)


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("encoding", ["gzip", "deflate", "br", "zstd", "gzip, deflate"])
def test_limit_measures_decompressed_bytes(kind, encoding):
    import brotli
    import zstandard
    original = ("café 中文\n" * 40).encode()
    compressed = {"gzip": gzip.compress(original), "deflate": zlib.compress(original),
        "br": brotli.compress(original), "zstd": zstandard.ZstdCompressor().compress(original),
        "gzip, deflate": zlib.compress(gzip.compress(original))}[encoding]
    client, stream, _ = make_client(kind, [compressed[:5], compressed[5:]],
        headers={"content-encoding": encoding, "content-length": str(len(compressed))},
        max_response_bytes=len(original) - 1)
    try:
        with pytest.raises(httpx.ResponseTooLarge) as caught:
            send(kind, client)
        assert caught.value.received >= len(original)
        assert stream.closes == 1
    finally:
        close(kind, client)


@pytest.mark.parametrize("kind", KINDS)
def test_content_length_is_not_used_as_decoded_length(kind):
    for claimed, limit, allowed in [("10000", 5, True), ("0", 4, False)]:
        client, _, _ = make_client(kind, [b"hello"], headers={"content-length": claimed}, max_response_bytes=limit)
        try:
            if allowed:
                assert send(kind, client).content == b"hello"
            else:
                with pytest.raises(httpx.ResponseTooLarge):
                    send(kind, client)
        finally:
            close(kind, client)
    client, _, _ = make_client(kind, ["中文".encode()], max_response_bytes=3)
    try:
        with pytest.raises(httpx.ResponseTooLarge):
            send(kind, client)
    finally:
        close(kind, client)


@pytest.mark.parametrize("kind", KINDS)
def test_already_buffered_transport_is_checked_before_stream_send_returns(kind):
    client, _, _ = make_client(kind, [b"hello"], buffered=True, max_response_bytes=4)
    try:
        with pytest.raises(httpx.ResponseTooLarge):
            request = httpx.Request("GET", URL)
            if kind == "sync":
                client.send(request, stream=True)
            else:
                asyncio.run(client.send(request, stream=True))
    finally:
        close(kind, client)


@pytest.mark.parametrize("kind", KINDS)
def test_explicit_raw_iteration_preserves_wire_semantics(kind):
    body = gzip.compress(b"hello" * 100)
    client, stream, _ = make_client(kind, [body], headers={"content-encoding": "gzip"}, max_response_bytes=0)
    try:
        if kind == "sync":
            with client.stream("GET", URL) as response:
                assert b"".join(response.iter_raw()) == body
        else:
            async def consume():
                async with client.stream("GET", URL) as response:
                    return b"".join([part async for part in response.aiter_raw()])
            assert asyncio.run(consume()) == body
        assert stream.closes == 1
    finally:
        close(kind, client)


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("overflow", [False, True])
def test_redirect_policy_resets_per_response_and_stops_on_overflow(kind, overflow):
    seen = []
    streams = []
    def handler(request):
        seen.append(request)
        n = len(seen)
        stream = (SyncStream if kind == "sync" else AsyncStream)([b"large" if overflow and n == 1 else b"abc"])
        streams.append(stream)
        return httpx.Response(302 if n < 3 else 200, headers={"location": "/next"}, stream=stream)
    cls = httpx.Client if kind == "sync" else httpx.AsyncClient
    client = cls(transport=httpx.MockTransport(handler), follow_redirects=True, max_response_bytes=3)
    try:
        if overflow:
            with pytest.raises(httpx.ResponseTooLarge):
                send(kind, client)
            assert len(seen) == 1
        else:
            response = send(kind, client)
            assert len(seen) == 3
            assert response.content == b"abc"
            assert len(response.history) == 2
        assert all(stream.closes == 1 for stream in streams)
    finally:
        close(kind, client)


class Challenge(httpx.Auth):
    def auth_flow(self, request):
        response = yield request
        if response.status_code == 401:
            request.headers["Authorization"] = "retry"
            yield request


@pytest.mark.parametrize("kind", KINDS)
def test_auth_intermediate_body_obeys_policy(kind):
    seen = []
    def handler(request):
        seen.append(request)
        stream = (SyncStream if kind == "sync" else AsyncStream)([b"large"])
        return httpx.Response(401 if len(seen) == 1 else 200, stream=stream)
    cls = httpx.Client if kind == "sync" else httpx.AsyncClient
    client = cls(transport=httpx.MockTransport(handler), auth=Challenge(), max_response_bytes=3)
    try:
        with pytest.raises(httpx.ResponseTooLarge):
            send(kind, client)
        assert len(seen) == 1
    finally:
        close(kind, client)


@pytest.mark.parametrize("kind", KINDS)
def test_hooks_receive_policy_before_reading(kind):
    seen = []
    def sync_hook(response):
        seen.append(response)
        response.read()
    async def async_hook(response):
        seen.append(response)
        await response.aread()
    client, stream, _ = make_client(kind, [b"hello"], max_response_bytes=4,
        event_hooks={"response": [sync_hook if kind == "sync" else async_hook]})
    try:
        with pytest.raises(httpx.ResponseTooLarge):
            send(kind, client)
        assert len(seen) == 1
        assert seen[0].is_closed
        assert stream.closes == 1
    finally:
        close(kind, client)


@pytest.mark.parametrize("method", METHODS)
def test_top_level_convenience_passes_limit(method):
    original = httpx.Client
    class LocalClient(original):
        def __init__(self, **kwargs):
            kwargs["transport"] = httpx.MockTransport(lambda request: httpx.Response(200, content=b"hello"))
            super().__init__(**kwargs)
    with patch("httpx._api.Client", LocalClient):
        with pytest.raises(httpx.ResponseTooLarge):
            getattr(httpx, method)(URL, max_response_bytes=4)
        assert getattr(httpx, method)(URL, max_response_bytes=None).content == b"hello"


def test_top_level_request_and_stream():
    original = httpx.Client
    class LocalClient(original):
        def __init__(self, **kwargs):
            kwargs["transport"] = httpx.MockTransport(lambda request: httpx.Response(200, stream=SyncStream([b"hello"])))
            super().__init__(**kwargs)
    with patch("httpx._api.Client", LocalClient):
        with pytest.raises(httpx.ResponseTooLarge):
            httpx.request("GET", URL, max_response_bytes=4)
        with pytest.raises(httpx.ResponseTooLarge):
            with httpx.stream("GET", URL, max_response_bytes=4) as response:
                response.read()


def test_wsgi_transport_enforces_limit():
    def app(environ, start_response):
        start_response("200 OK", [("content-type", "text/plain")])
        return [b"hello"]
    with httpx.Client(transport=httpx.WSGITransport(app=app), max_response_bytes=4) as client:
        with pytest.raises(httpx.ResponseTooLarge):
            client.get(URL)


def test_asgi_transport_and_concurrent_overrides():
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"hello"})
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), max_response_bytes=3) as client:
            responses = await asyncio.gather(
                client.get(URL, max_response_bytes=None), client.get(URL, max_response_bytes=5),
                client.get(URL), return_exceptions=True)
            assert responses[0].content == responses[1].content == b"hello"
            assert isinstance(responses[2], httpx.ResponseTooLarge)
            assert client.max_response_bytes == 3
    asyncio.run(run())
