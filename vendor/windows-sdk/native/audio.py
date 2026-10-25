"""Decode/resample audio in memory; never writes recordings."""
import base64
import av


class PCMEncoder:
    def __init__(self):
        self.resampler = av.AudioResampler(format="s16", layout="mono", rate=16000, frame_size=1600)

    def encode(self, frame):
        for output in self.resampler.resample(frame):
            # AV planes can contain padding beyond the valid sample count.
            pcm = bytes(output.planes[0])[:output.samples * 2]
            yield {"pcm": base64.b64encode(pcm).decode("ascii"), "sampleRate": 16000, "samples": output.samples}


def decoded_frames(container, on_audio_error, skip_audio=lambda: False):
    for packet in container.demux():
        if packet.stream.type not in ("video", "audio"):
            continue
        if packet.stream.type == 'audio' and skip_audio():
            continue
        try:
            frames = packet.decode()
        except av.FFmpegError as error:
            if packet.stream.type == "audio":
                on_audio_error(error, "decode")
                continue
            raise
        yield from frames
