"""Low-delay H.264 for browser decoding, keeping the source timeline."""
import base64
from fractions import Fraction
import av


class SmoothEncoder:
    def __init__(self, quality='sd', fps=25):
        self.quality = quality
        self.fps = min(30, max(1, float(fps or 25)))
        self.encoder = None
        self.origin = None
        self.last_pts = -1
        self.frames = 0

    def encode(self, frame):
        if self.encoder is not None and (frame.width != self.encoder.width or frame.height != self.encoder.height):
            self.encoder = None
        if self.encoder is None:
            encoder = self.encoder = av.CodecContext.create('libx264', 'w')
            encoder.width, encoder.height = frame.width, frame.height
            encoder.pix_fmt = 'yuv420p'
            encoder.time_base = Fraction(1, 90000)
            encoder.framerate = Fraction(self.fps).limit_denominator(1001)
            bitrate = 1200000 if self.quality == 'hd' else 320000
            encoder.bit_rate = bitrate
            encoder.gop_size = max(1, round(self.fps))
            encoder.max_b_frames = 0
            encoder.thread_count = 2
            encoder.options = {'preset': 'veryfast', 'tune': 'zerolatency', 'profile': 'baseline', 'level': '4.0',
                               'x264-params': f'repeat-headers=1:annexb=1:scenecut=0:vbv-maxrate={bitrate // 1000}:vbv-bufsize={bitrate // 1000}'}
            encoder.open()
        if frame.pts is not None and frame.time_base:
            seconds = float(frame.pts * frame.time_base)
            if self.origin is None:
                self.origin = seconds
            pts = round((seconds - self.origin) * 90000)
        else:
            pts = self.last_pts + round(90000 / self.fps)
        if self.last_pts >= 0 and pts > self.last_pts and pts - self.last_pts < 3000:
            return
        if pts <= self.last_pts:
            pts = self.last_pts + round(90000 / self.fps)
        picture = frame.reformat(format='yuv420p')
        picture.pts, picture.time_base = pts, Fraction(1, 90000)
        self.last_pts = pts
        self.frames += 1
        for packet in self.encoder.encode(picture):
            data = bytes(packet)
            yield {'h264': base64.b64encode(data).decode('ascii'), 'key': packet.is_keyframe,
                   'timestamp': round(packet.pts * float(packet.time_base) * 1000000),
                   'width': self.encoder.width, 'height': self.encoder.height,
                   'codec': 'avc1.42C028'}
