"""Decode header-identified G.711 from Hikvision MPEG program streams.

The SDK's 40-byte HIK_MEDIAINFO header identifies the codec. FFmpeg's MPEG
demuxer can label these private audio tracks as MP2. Keep video on its existing
decoder and extract audio PES payloads separately, without guessing a codec.
"""
import struct
import threading
import av
from audio import PCMEncoder
from media import MediaBuffer


def header_audio(header):
    if len(header) < 24 or header[:4] != b'IMKH':
        return None
    codec, channels, bits, rate = struct.unpack_from('<HBBI', header, 12)
    name = {0x7110: 'pcm_mulaw', 0x7111: 'pcm_alaw'}.get(codec)
    if not name or channels not in (1, 2) or not 8000 <= rate <= 48000:
        return None
    return name, channels, rate


class AudioPES:
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, data):
        self.buffer.extend(data)
        if len(self.buffer) > 2 * 1024 * 1024:
            raise ValueError('program-stream buffer limit')
        while True:
            start = self.buffer.find(b'\0\0\1')
            if start < 0:
                self.buffer[:] = self.buffer[-2:]
                return
            if start:
                del self.buffer[:start]
            if len(self.buffer) < 6:
                return
            code = self.buffer[3]
            if code == 0xBA:
                if len(self.buffer) < 14:
                    return
                length = 14 + (self.buffer[13] & 7)
            elif code == 0xB9:
                length = 4
            else:
                length = 6 + int.from_bytes(self.buffer[4:6], 'big')
                if length == 6:
                    # Unbounded video PES: find the next PS-level start code.
                    end = 6
                    while True:
                        end = self.buffer.find(b'\0\0\1', end)
                        if end < 0:
                            return
                        if len(self.buffer) < end + 4:
                            return
                        if self.buffer[end + 3] >= 0xB9:
                            break
                        end += 3
                    length = end
            if len(self.buffer) < length:
                return
            packet = bytes(self.buffer[:length])
            del self.buffer[:length]
            if 0xC0 <= code <= 0xDF and len(packet) >= 9 and packet[6] & 0xC0 == 0x80:
                offset = 9 + packet[8]
                if offset <= len(packet):
                    yield packet[offset:]


class HikAudio:
    def __init__(self, emit):
        self.emit = emit
        self.active = threading.Event()
        self.available = threading.Event()
        self.media = MediaBuffer(limit=2 * 1024 * 1024)
        self.format = None
        self.thread = None

    def feed(self, kind, data):
        if kind == 1 and self.thread is None:
            self.format = header_audio(data)
            if self.format:
                self.active.set()
                self.thread = threading.Thread(target=self.run, daemon=True)
                self.thread.start()
        elif kind == 2 and self.active.is_set():
            self.media.push(data)

    def run(self):
        codec, channels, rate = self.format
        decoder = av.CodecContext.create(codec, 'r')
        decoder.sample_rate = rate
        decoder.layout = 'mono' if channels == 1 else 'stereo'
        parser, encoder = AudioPES(), PCMEncoder()
        self.emit('audio-stream', available=True, codec=codec)
        try:
            while data := self.media.read(65536):
                for payload in parser.feed(data):
                    if not payload:
                        continue
                    for frame in decoder.decode(av.Packet(payload)):
                        for packet in encoder.encode(frame):
                            self.available.set()
                            self.emit('audio', **packet, decoder='hik-g711')
            if self.media.overflow:
                raise ValueError('audio buffer limit')
        except Exception as error:
            self.emit('audio-error', phase='decode', kind=type(error).__name__, code=getattr(error, 'errno', None))

    def close(self):
        self.media.finish()
        if self.thread:
            self.thread.join(2)
