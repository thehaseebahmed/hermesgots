"""A charm's voice on the wire: raw Opus packets, each behind its length, both ways.

A turn is one request in each direction, so its body is the audio and nothing else:
``[len u16 little-endian][Opus packet]``, again and again. Ogg would need a muxer on both ends and
buys nothing for a stream that is always 20 ms frames; a length is what lets the charm's C walk a
body without a parser, and what lets this side refuse a packet before a codec sees it.

Both directions are the same format — 16 kHz mono, about 24 kbps — because one format is what lets
the host's speech model hear what the charm captured, and lets the charm play what the host spoke.
A stream is at most a minute of it, the cap the plan made, and a packet at most the 1275 bytes one
Opus frame can be (RFC 6716 §3.2.5), so neither direction can be handed something that makes it
allocate or decode for ever. What is inside a packet is the codec's to judge: a payload it cannot
decode raises ``Undecodable``, which a route names like any other failure.

A reply does not arrive in that shape, though: the host's voice answers a file in whatever format
its provider gave — an MP3, an Ogg, a WAV at 24 kHz stereo — so ``pcm`` reads one of those as the
16 kHz mono samples ``encode`` frames. Reading a file and reading a charm's stream are one path,
because a reply and an utterance must land on the wire in the same format.

``CONTENT_TYPE`` is that wire's name, which the turn route answers its stream under.

``av`` is imported inside the functions, never at the top: a host without it must still load the
plugin, and the refusal is then a sentence of ours rather than an ImportError in the routes. PyAV
hands back bare packets, which is the one dependency assumption this wire rests on — the plan's
fallback is Ogg on both sides, and ``test_charm_audio`` is where that would show.
"""

from __future__ import annotations

import io
import logging
import struct
from fractions import Fraction
from pathlib import Path
from typing import Any, List, Union

logger = logging.getLogger(__name__)

CODEC = "libopus"
SAMPLE_RATE = 16000
# 20 ms frames: the size a packet is, both directions, and what the charm's microphone opens for.
FRAME_SAMPLES = 320
SAMPLE_BYTES = 2
BIT_RATE = 24000
MAX_SECONDS = 60
FRAME_MS = 1000 * FRAME_SAMPLES // SAMPLE_RATE
MAX_FRAMES = MAX_SECONDS * 1000 // FRAME_MS
# One Opus frame is at most this many bytes, whatever its duration (RFC 6716 §3.2.5).
MAX_PACKET = 1275
# What a turn's answer is: the framed stream, under a type of its own, so a caller never has to
# guess whether a body is audio and which audio it is.
CONTENT_TYPE = "audio/x-gots-opus"
# What a body past the cap says, whichever direction carried it — a request the server itself
# refused is too much for the same reason, so one sentence is answered for all of it.
TOO_LONG = f"A turn's audio is at most {MAX_SECONDS} seconds."

HEAD = struct.Struct("<H")


class CharmAudioError(Exception):
    """Audio this wire won't carry, in a sentence a route can answer the charm with.

    ``status`` and ``code`` are how a route answers it: the HTTP status, and the word the charm's
    band switches on rather than reading the sentence. A caller's own mistake is its 4xx; a host
    that can't do the work is not. Both live beside the reason so a reason cannot be worded one way
    here and another in a route that carries it.
    """

    status = 500
    code = "audio_failed"


class NoCodec(CharmAudioError):
    """``av`` isn't on this host, so nothing here can encode or decode a packet."""

    status = 503
    code = "no_codec"


class Truncated(CharmAudioError):
    """A stream that ends inside a packet's length, or inside the packet it named."""

    status = 400
    code = "truncated"


class Oversized(CharmAudioError):
    """A length past what one Opus frame can be: not audio, whatever follows it."""

    status = 400
    code = "oversized"


class TooLong(CharmAudioError):
    """A stream past the minute a turn may carry, in either direction."""

    status = 413
    code = "too_long"


class Undecodable(CharmAudioError):
    """Audio the codec can't read: a payload that isn't Opus, or a file nothing here can open."""

    status = 422
    code = "undecodable"


class OddPcm(CharmAudioError):
    """PCM that ends inside a sample: not the 16 kHz mono s16 this wire carries.

    A programmer's mistake rather than a caller's — nothing here decodes to an odd length — but a
    refusal like the rest, rather than a bare ``ValueError`` a route carrying it would miss.
    """

    status = 422
    code = "odd_pcm"


def _av() -> Any:
    try:
        import av
    except ImportError as missing:
        raise NoCodec("This host has no Opus codec to speak with: install av.") from missing
    return av


def encode(pcm: bytes) -> bytes:
    """A take of 16 kHz mono s16 PCM as the stream a charm decodes.

    A tail shorter than a frame is padded with silence, so every packet on the wire is 20 ms long
    and a decoder never has to hold a short one. The encoder is not flushed afterwards: a libopus
    flush answers one more packet of padding, and a stream that is one packet a frame is what the
    cap counts and what the charm's buffer is sized from.
    """
    if len(pcm) % SAMPLE_BYTES:
        raise OddPcm("16 kHz mono s16 PCM is two bytes a sample.")
    if len(pcm) // SAMPLE_BYTES > SAMPLE_RATE * MAX_SECONDS:
        raise TooLong(TOO_LONG)
    av = _av()
    encoder = av.CodecContext.create(CODEC, "w")
    encoder.sample_rate = SAMPLE_RATE
    encoder.format = "s16"
    encoder.layout = "mono"
    encoder.bit_rate = BIT_RATE
    # Constant rather than variable: a reply of a given length is then a body of a known size, and
    # a minute of it is the 180 KB the plan's memory budget was written from.
    encoder.options = {"vbr": "off"}
    stream = bytearray()
    span = FRAME_SAMPLES * SAMPLE_BYTES
    for index, at in enumerate(range(0, len(pcm), span)):
        frame = av.AudioFrame(format="s16", layout="mono", samples=FRAME_SAMPLES)
        frame.sample_rate = SAMPLE_RATE
        frame.pts = index * FRAME_SAMPLES
        frame.time_base = Fraction(1, SAMPLE_RATE)
        frame.planes[0].update(pcm[at : at + span].ljust(span, b"\x00"))
        for packet in encoder.encode(frame):
            stream += _framed(packet)
    return bytes(stream)


def decode(stream: bytes) -> bytes:
    """The PCM a charm spoke: 16 kHz mono s16, the form the host's hearing takes.

    Every packet is counted before the first is decoded, so a body past the cap costs a walk of its
    lengths rather than a minute of work. The resampler is asked for its own tail at the end, since
    it holds a little of the last frame back until it is. A payload the codec can't read is
    ``Undecodable`` rather than ``av``'s own error, so a route names it like the rest of the wire's.
    """
    packets = _packets(stream)
    av = _av()
    try:
        decoder = av.CodecContext.create(CODEC, "r")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        pcm = bytearray()
        for payload in packets:
            for frame in decoder.decode(av.Packet(payload)):
                for piece in _resampled(resampler, frame):
                    pcm += _samples(piece)
        for piece in _resampled(resampler, None):
            pcm += _samples(piece)
    except Exception as error:
        # The codec's refusal and a defect of ours both land here, and only the first is a sentence
        # for the charm: logged with its traceback so our own mistake is visible in the log rather
        # than passing, for ever, as audio nothing could read.
        logger.debug("gots: a charm's stream couldn't be decoded", exc_info=True)
        raise Undecodable(f"This audio couldn't be decoded: {error}") from error
    return bytes(pcm)


def pcm(source: Union[bytes, bytearray, str, Path]) -> bytes:
    """A file of any audio the host can open, as 16 kHz mono s16 PCM — ``source``'s bytes or path.

    The host's voice answers a file in whatever its provider gave, so nothing here assumes one:
    the container is opened, its first audio stream decoded, and every frame resampled to the rate
    and layout the wire carries. One path with ``encode``'s, since a reply and an utterance that
    disagreed about the format would be a charm that hears one and plays the other at pitch.
    """
    av = _av()
    opened = io.BytesIO(bytes(source)) if isinstance(source, (bytes, bytearray)) else str(source)
    try:
        container = av.open(opened)
    except Exception as error:
        logger.debug("gots: %r couldn't be opened as audio", opened, exc_info=True)
        raise Undecodable(f"This audio couldn't be read: {error}") from error
    try:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        heard = bytearray()
        for frame in container.decode(audio=0):
            for piece in _resampled(resampler, frame):
                heard += _samples(piece)
        for piece in _resampled(resampler, None):
            heard += _samples(piece)
    except Exception as error:
        # As ``decode``: the codec's failure is the charm's sentence, ours is logged first so a
        # defect here can't hide behind a refusal that blames the file.
        logger.debug("gots: %r couldn't be read as audio", opened, exc_info=True)
        raise Undecodable(f"This audio couldn't be read: {error}") from error
    finally:
        container.close()
    return bytes(heard)


def _framed(packet: Any) -> bytes:
    payload = bytes(packet)
    if len(payload) > MAX_PACKET:
        raise Oversized(f"A packet is at most {MAX_PACKET} bytes, and one is {len(payload)}.")
    return HEAD.pack(len(payload)) + payload


def _packets(stream: bytes) -> List[bytes]:
    packets: List[bytes] = []
    at = 0
    while at < len(stream):
        if at + HEAD.size > len(stream):
            raise Truncated("The stream ends in the middle of a packet's length.")
        size = HEAD.unpack_from(stream, at)[0]
        at += HEAD.size
        if size > MAX_PACKET:
            raise Oversized(f"A packet is at most {MAX_PACKET} bytes, and one says {size}.")
        if at + size > len(stream):
            raise Truncated("The stream ends in the middle of a packet.")
        packets.append(stream[at : at + size])
        at += size
        if len(packets) > MAX_FRAMES:
            raise TooLong(TOO_LONG)
    return packets


def _resampled(resampler: Any, frame: Any) -> List[Any]:
    """What the resampler gave back for a frame, or for ``None`` its own held-back tail."""
    done = resampler.resample(frame)
    if isinstance(done, (list, tuple)):
        return [piece for piece in done if piece is not None]
    return [] if done is None else [done]


def _samples(frame: Any) -> bytes:
    """A frame's samples, and only them: PyAV pads a plane out to its alignment."""
    return bytes(frame.planes[0])[: frame.samples * SAMPLE_BYTES]
