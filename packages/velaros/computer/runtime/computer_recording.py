"""有界录像复用 PyAV/FFmpeg 编解码；帧直接流入编码器，不保留全屏帧数组。"""
from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path
from typing import Callable

from computer_helper_common import ComputerHelperError


def record(payload: dict, capture: Callable) -> dict:
    try:
        import av
    except ImportError as error:
        raise ComputerHelperError("UNAVAILABLE", f"Bundled recording backend is unavailable: {error}") from error
    from PIL import ImageOps

    output = Path(payload["path"])
    if not output.is_absolute() or output.suffix.lower() != ".mp4":
        raise ComputerHelperError("VALIDATION", "Recording requires an absolute MP4 path")
    duration_ms, fps = payload["durationMs"], payload.get("fps", 5)
    if not 100 <= duration_ms <= 5000 or not 1 <= fps <= 10:
        raise ComputerHelperError("VALIDATION", "Recording exceeds duration or frame-rate limits")
    if output.exists():
        raise ComputerHelperError("CONFLICT", "Recording output already exists")
    # 在目标目录创建临时文件；完成编码后用硬链接原子发布，已有目标绝不覆盖。
    descriptor, temporary = tempfile.mkstemp(prefix=".velaros-record-", suffix=".mp4", dir=output.parent)
    os.close(descriptor)
    try:
        image = capture()
        width, height = image.size
        encoded_size = (width + width % 2, height + height % 2)
        if width <= 0 or height <= 0 or encoded_size[0] * encoded_size[1] > 16777216:
            raise ComputerHelperError("LIMIT", "Recording frame exceeds 16 megapixels")
        started = time.monotonic()
        frames = 0
        with av.open(temporary, mode="w", format="mp4") as container:
            # MPEG-4 编码器由 PyAV 携带的 FFmpeg 提供，不依赖系统安装或 GPL x264。
            stream = container.add_stream("mpeg4", rate=fps)
            stream.width, stream.height = encoded_size
            stream.pix_fmt = "yuv420p"
            stream.bit_rate = min(encoded_size[0] * encoded_size[1] * 4, 16000000)
            while frames == 0 or time.monotonic() - started < duration_ms / 1000:
                if frames:
                    image = capture()
                if image.size != (width, height):
                    raise ComputerHelperError("CONFLICT", "Capture geometry changed during recording")
                image = ImageOps.pad(image, encoded_size)
                frame = av.VideoFrame.from_image(image)
                frame.pts = frames
                for packet in stream.encode(frame):
                    container.mux(packet)
                frames += 1
                remaining = started + frames / fps - time.monotonic()
                if remaining > 0:
                    time.sleep(min(remaining, max(0, started + duration_ms / 1000 - time.monotonic())))
            for packet in stream.encode():
                container.mux(packet)
        if os.path.getsize(temporary) == 0:
            raise ComputerHelperError("UNAVAILABLE", "Encoder produced no recording")
        os.link(temporary, output)
        return {"path": str(output), "width": encoded_size[0], "height": encoded_size[1],
                "frames": frames, "fps": fps, "durationMs": round((time.monotonic() - started) * 1000),
                "bytes": output.stat().st_size}
    finally:
        os.unlink(temporary)
