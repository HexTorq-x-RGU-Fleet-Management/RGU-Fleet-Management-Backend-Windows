import base64
import math
import unittest
import struct
import threading
from array import array
from fractions import Fraction
import av
from audio import PCMEncoder
from ps_audio import AudioPES, HikAudio, header_audio


def hik_header(codec=0x7110, channels=1, rate=8000):
    return b'IMKH' + bytes(8) + struct.pack('<HBBII', codec, channels, 16, rate, 64000) + bytes(16)


def pes(code, payload, optional=b''):
    body = bytes([0x80, 0x80 if optional else 0, len(optional)]) + optional + payload
    return b'\0\0\1' + bytes([code]) + len(body).to_bytes(2, 'big') + body


class AudioTests(unittest.TestCase):
    def test_codec_comes_from_validated_hikvision_header(self):
        self.assertEqual(header_audio(hik_header()), ('pcm_mulaw', 1, 8000))
        self.assertEqual(header_audio(hik_header(0x7111)), ('pcm_alaw', 1, 8000))
        for header in (b'', b'wrong' * 8, hik_header(0), hik_header(channels=0), hik_header(rate=0)):
            self.assertIsNone(header_audio(header))

    def test_fragmented_program_stream_keeps_audio_payload_and_skips_video(self):
        payloads = [bytes(range(160)), b'\xff' * 160]
        pack = b'\0\0\1\xba' + bytes(9) + b'\x03' + b'\xff' * 3
        stream = pack + pes(0xe0, b'video' + pes(0xc0, b'not audio')) + pes(0xc0, payloads[0], b'12345') + pes(0xc0, payloads[1])
        parser, actual = AudioPES(), []
        for value in stream:
            actual.extend(parser.feed(bytes([value])))
        self.assertEqual(actual, payloads)

    def test_unbounded_video_and_partial_start_codes_do_not_leak_into_audio(self):
        parser = AudioPES()
        self.assertEqual(list(parser.feed(b'\0\0\1\xe0\0\0\x80\0\0\0\0\1\x26video\0\0')), [])
        self.assertEqual(list(parser.feed(pes(0xc0, b'audio'))), [b'audio'])

    def test_live_g711_path_emits_nonzero_valid_pcm_and_stops_without_recording(self):
        events, ready = [], threading.Event()
        def emit(stage, **values):
            events.append((stage, values))
            if stage == 'audio':
                ready.set()
        audio = HikAudio(emit)
        audio.feed(1, hik_header())
        audio.feed(2, b''.join(pes(0xc0, bytes([0x00, 0x80]) * 80) for _ in range(20)))
        self.assertTrue(ready.wait(2))
        audio.close()
        self.assertFalse(audio.thread.is_alive())
        self.assertFalse(any(stage == 'audio-error' for stage, _ in events))
        packets = [value for stage, value in events if stage == 'audio']
        self.assertGreater(len(packets), 0)
        for packet in packets:
            self.assertEqual(packet['sampleRate'], 16000)
            self.assertEqual(packet['decoder'], 'hik-g711')
            pcm = base64.b64decode(packet['pcm'])
            self.assertEqual(len(pcm), packet['samples'] * 2)
            samples = array('h'); samples.frombytes(pcm)
            self.assertGreater(max(samples), 1000)
            self.assertLess(min(samples), -1000)

    def test_mono_8khz_becomes_valid_16khz_pcm_without_plane_padding(self):
        frame = av.AudioFrame(format='s16', layout='mono', samples=8000)
        source = array('h', [round(10000 * math.sin(2 * math.pi * 440 * n / 8000)) for n in range(8000)])
        frame.planes[0].update(source.tobytes())
        frame.sample_rate = 8000; frame.time_base = Fraction(1, 8000); frame.pts = 0
        packets = list(PCMEncoder().encode(frame))
        self.assertGreater(len(packets), 5)
        for packet in packets:
            self.assertEqual(packet['sampleRate'], 16000)
            self.assertEqual(len(base64.b64decode(packet['pcm'])), packet['samples'] * 2)
        samples = array('h'); samples.frombytes(base64.b64decode(packets[0]['pcm']))
        self.assertGreater(max(samples), 8000); self.assertLess(min(samples), -8000)

    def test_stereo_48khz_is_downmixed_to_mono(self):
        frame = av.AudioFrame(format='s16', layout='stereo', samples=48000)
        frame.planes[0].update(array('h', [4000, 0] * 48000).tobytes())
        frame.sample_rate = 48000; frame.time_base = Fraction(1, 48000); frame.pts = 0
        packets = list(PCMEncoder().encode(frame))
        self.assertGreater(len(packets), 5)
        samples = array('h'); samples.frombytes(base64.b64decode(packets[-1]['pcm']))
        self.assertGreater(sum(samples) / len(samples), 1000)
        self.assertEqual(len(samples), packets[-1]['samples'])


if __name__ == '__main__':
    unittest.main()
