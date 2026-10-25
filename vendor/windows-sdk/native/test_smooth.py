import base64
from fractions import Fraction
import unittest
import av
from smooth import SmoothEncoder


def picture(index, fps=25):
    frame = av.VideoFrame(352, 288, 'yuv420p')
    for number, plane in enumerate(frame.planes):
        plane.update(bytes([40 + index % 150 if number == 0 else 128]) * plane.buffer_size)
    frame.pts = index
    frame.time_base = Fraction(1, fps)
    return frame


class SmoothTests(unittest.TestCase):
    def test_25fps_round_trip_keeps_every_frame_and_source_timing(self):
        encoder = SmoothEncoder('sd', 25)
        packets = [p for n in range(50) for p in encoder.encode(picture(n))]
        self.assertEqual(len(packets), 50)
        self.assertTrue(packets[0]['key'])
        self.assertEqual(packets[-1]['timestamp'], 1960000)
        decoder = av.CodecContext.create('h264', 'r')
        frames = [f for p in packets for f in decoder.decode(av.Packet(base64.b64decode(p['h264'])))]
        self.assertEqual(len(frames), 50)
        self.assertEqual((frames[0].width, frames[0].height), (352, 288))

    def test_timestamp_restart_is_monotonic_and_missing_pts_still_encodes(self):
        encoder = SmoothEncoder()
        packets = []
        for index in [0, 1, 2, 0, 1]:
            packets.extend(encoder.encode(picture(index)))
        frame = picture(0); frame.pts = None
        packets.extend(encoder.encode(frame))
        times = [p['timestamp'] for p in packets]
        self.assertEqual(len(times), 6)
        self.assertTrue(all(a < b for a, b in zip(times, times[1:])))

    def test_60fps_input_is_bounded_to_30fps(self):
        encoder = SmoothEncoder(fps=60)
        packets = [p for n in range(60) for p in encoder.encode(picture(n, 60))]
        self.assertGreaterEqual(len(packets), 29)
        self.assertLessEqual(len(packets), 31)

    def test_camera_resolution_change_restarts_with_a_keyframe(self):
        encoder = SmoothEncoder()
        first = list(encoder.encode(picture(0)))
        frame = picture(1).reformat(width=640, height=360)
        second = list(encoder.encode(frame))
        self.assertTrue(first[0]['key']); self.assertTrue(second[0]['key'])
        self.assertEqual((second[0]['width'], second[0]['height']), (640, 360))


if __name__ == '__main__':
    unittest.main()
