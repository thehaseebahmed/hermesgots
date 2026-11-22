"""The charm's audio wire (``plugin/charm_audio.py``): ``[len][opus packet]``, both directions.

``av`` is not on a test host, so the cases that prove the framing stand a stub codec in its place,
the way ``test_dictation`` stands one in for ``tools.transcription_tools``: a small honest stand-in
for the library, whose packets are a frame compressed rather than a mock of this module's own calls.
The one case that needs the real codec is skipped where it is absent.

The framing is read here by hand, out of the bytes an encoder produced, because that is what the
charm's C reads: a test that asked this module to parse its own stream would agree with it about a
mistake.
"""

from __future__ import annotations

import importlib.util
import math
import struct
import sys
import types
import unittest
import zlib
from typing import Any, List, Optional, Tuple
from unittest import mock

from plugin import charm_audio

HAVE_AV = importlib.util.find_spec("av") is not None


class Packet:
    """A codec's packet: bytes it hands back, as ``bytes(packet)`` does in PyAV."""

    def __init__(self, data: bytes) -> None:
        self.data = bytes(data)

    @property
    def size(self) -> int:
        return len(self.data)

    def __bytes__(self) -> bytes:
        return self.data


class Plane:
    """A frame's one buffer: packed s16 mono, which is one plane in PyAV too."""

    def __init__(self, size: int) -> None:
        self.data = bytes(size)

    def update(self, data: bytes) -> None:
        self.data = bytes(data)

    def __bytes__(self) -> bytes:
        return self.data


class Frame:
    """A frame of s16 mono samples, built the way the module builds one."""

    def __init__(self, *, format: str = "s16", layout: str = "mono", samples: int = 0) -> None:
        self.format = format
        self.layout = layout
        self.sample_rate = 0
        self.pts: Optional[int] = None
        self.time_base: Any = None
        self.samples = samples
        self.planes = [Plane(samples * 2)]

    @classmethod
    def holding(cls, pcm: bytes) -> "Frame":
        frame = cls(samples=len(pcm) // 2)
        frame.planes[0].update(pcm)
        return frame

    def __bytes__(self) -> bytes:
        return bytes(self.planes[0])


class Resampler:
    """Takes the module's ask, and answers each frame already in it."""

    def __init__(self, *, format: str, layout: str, rate: int) -> None:
        self.asked = (format, layout, rate)

    def resample(self, frame: Optional[Frame] = None) -> List[Frame]:
        return [] if frame is None else [frame]


def stub_av() -> Tuple[types.ModuleType, types.SimpleNamespace]:
    """``av`` as far as this module uses it, and what the module asked each part for.

    A packet is one 20 ms frame, zlib-compressed: a handful of bytes for a frame, the shape an Opus
    packet has, and lossless, so a round trip proves the framing rather than the codec. ``made``
    holds the encoder and the resampler, because their settings are part of the wire's contract.
    """
    made = types.SimpleNamespace(encoders=[], resamplers=[])

    class Encoder:
        def __init__(self) -> None:
            self.sample_rate = 0
            self.format: Optional[str] = None
            self.layout: Optional[str] = None
            self.bit_rate = 0
            made.encoders.append(self)

        def encode(self, frame: Optional[Frame] = None) -> List[Packet]:
            return [] if frame is None else [Packet(zlib.compress(bytes(frame)))]

    class Decoder:
        def decode(self, packet: Any) -> List[Frame]:
            return [Frame.holding(zlib.decompress(bytes(packet)))]

    def create(name: str, mode: str = "r") -> Any:
        assert name == charm_audio.CODEC, f"{name} is not the codec the wire names"
        return Encoder() if mode == "w" else Decoder()

    def resampler(*, format: str, layout: str, rate: int) -> Resampler:
        made.resamplers.append(Resampler(format=format, layout=layout, rate=rate))
        return made.resamplers[-1]

    av = types.ModuleType("av")
    av.CodecContext = types.SimpleNamespace(create=create)
    av.AudioFrame = Frame
    av.AudioResampler = resampler
    av.Packet = Packet
    return av, made


def tone(samples: int = 16000, frequency: float = 440.0) -> bytes:
    """A sine at 16 kHz mono s16: a second of sound a codec keeps, so a round trip has something
    to hear."""
    return b"".join(
        struct.pack(
            "<h",
            int(12000 * math.sin(2 * math.pi * frequency * index / charm_audio.SAMPLE_RATE)),
        )
        for index in range(samples)
    )


def wire(stream: bytes) -> List[bytes]:
    """The packets in a stream, read the way the charm reads them: two bytes of length, then them."""
    packets: List[bytes] = []
    at = 0
    while at < len(stream):
        size = struct.unpack_from("<H", stream, at)[0]
        at += 2
        packets.append(stream[at : at + size])
        at += size
    return packets


class RoundTrip(unittest.TestCase):
    def test_packets_round_trip_a_tone(self) -> None:
        av, made = stub_av()
        pcm = tone(charm_audio.FRAME_SAMPLES * 50)
        with mock.patch.dict(sys.modules, {"av": av}):
            stream = charm_audio.encode(pcm)
            heard = charm_audio.decode(stream)
        self.assertEqual(heard, pcm, "the audio the charm sent is the audio the host heard")
        packets = wire(stream)
        self.assertEqual(len(packets), 50, "one packet a 20 ms frame")
        self.assertTrue(all(len(packet) <= charm_audio.MAX_PACKET for packet in packets))
        encoder = made.encoders[0]
        self.assertEqual(
            (encoder.sample_rate, encoder.format, encoder.layout, encoder.bit_rate),
            (16000, "s16", "mono", 24000),
            "a voice the wire's size: 16 kHz mono at about 24 kbps",
        )
        self.assertEqual(made.resamplers[0].asked, ("s16", "mono", 16000))

    def test_a_tone_that_ends_mid_frame_comes_back_padded(self) -> None:
        av, _ = stub_av()
        pcm = tone(charm_audio.FRAME_SAMPLES + 1)
        frame_bytes = charm_audio.FRAME_SAMPLES * charm_audio.SAMPLE_BYTES
        with mock.patch.dict(sys.modules, {"av": av}):
            heard = charm_audio.decode(charm_audio.encode(pcm))
        self.assertEqual(len(heard), frame_bytes * 2, "two whole 20 ms frames")
        self.assertEqual(heard[: len(pcm)], pcm)
        self.assertEqual(heard[len(pcm) :], bytes(frame_bytes * 2 - len(pcm)), "the gap is silence")


class Refusals(unittest.TestCase):
    def test_a_truncated_stream_is_refused(self) -> None:
        av, _ = stub_av()
        with mock.patch.dict(sys.modules, {"av": av}):
            stream = charm_audio.encode(tone(charm_audio.FRAME_SAMPLES))
            for cut, why in (
                (len(stream) - 1, "the last packet is a byte short"),
                (len(stream) - 3, "the last packet is missing its tail"),
                (len(stream) - len(wire(stream)[-1]) - 1, "the length is there, the packet isn't"),
                (1, "half a length"),
            ):
                with self.subTest(why=why), self.assertRaises(charm_audio.Truncated):
                    charm_audio.decode(stream[:cut])
            with self.assertRaises(charm_audio.Truncated):
                charm_audio.decode(b"\x10")

    def test_a_packet_past_a_frame_is_refused(self) -> None:
        av, _ = stub_av()
        fat = struct.pack("<H", charm_audio.MAX_PACKET + 1) + b"\x00" * (charm_audio.MAX_PACKET + 1)
        with mock.patch.dict(sys.modules, {"av": av}):
            with self.assertRaises(charm_audio.Oversized):
                charm_audio.decode(fat)

    def test_a_stream_past_the_cap_is_too_long(self) -> None:
        av, _ = stub_av()
        # Payloads that aren't audio at all: the count must refuse the stream before a codec sees one.
        past = b"".join(struct.pack("<H", 1) + b"x" for _ in range(charm_audio.MAX_FRAMES + 1))
        minute = charm_audio.SAMPLE_RATE * charm_audio.SAMPLE_BYTES * charm_audio.MAX_SECONDS
        with mock.patch.dict(sys.modules, {"av": av}):
            with self.assertRaises(charm_audio.TooLong):
                charm_audio.decode(past)
            with self.assertRaises(charm_audio.TooLong):
                charm_audio.encode(bytes(minute + charm_audio.SAMPLE_BYTES))
            # The cap is "at most": a minute exactly is still an utterance.
            self.assertEqual(len(wire(charm_audio.encode(bytes(minute)))), charm_audio.MAX_FRAMES)

    def test_a_host_with_no_codec_imports_and_says_so(self) -> None:
        with mock.patch.dict(sys.modules, {"av": None}):
            try:
                # `av` is imported inside the calls, never at the top, so the module still loads.
                importlib.reload(charm_audio)
                with self.assertRaises(charm_audio.NoCodec) as refused:
                    charm_audio.encode(tone(charm_audio.FRAME_SAMPLES))
            finally:
                importlib.reload(charm_audio)
        self.assertIn("av", str(refused.exception))


class RealCodec(unittest.TestCase):
    @unittest.skipUnless(HAVE_AV, "av isn't installed on this host")
    def test_a_real_av_encodes_16k_mono(self) -> None:
        pcm = tone()
        stream = charm_audio.encode(pcm)
        packets = wire(stream)
        self.assertEqual(len(packets), 50, "a second of 20 ms frames")
        self.assertLessEqual(max(len(packet) for packet in packets), charm_audio.MAX_PACKET)
        heard = charm_audio.decode(stream)
        self.assertEqual(len(heard) % 2, 0)
        samples = struct.unpack(f"<{len(heard) // 2}h", heard)
        crosses = sum(1 for a, b in zip(samples, samples[1:]) if (a < 0) != (b < 0))
        self.assertAlmostEqual(crosses, 880, delta=40, msg="the 440 Hz tone came back a 440 Hz tone")
        self.assertGreater(max(samples) - min(samples), 8000, "and at the volume it was sent")
        self.assertLess(len(stream), 6000, "about 24 kbps, not a CD")
        self.assertGreater(len(stream), 1000)


if __name__ == "__main__":
    unittest.main()
