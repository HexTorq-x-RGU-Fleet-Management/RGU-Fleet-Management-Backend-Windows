"""Synthetic media for the isolated API acceptance server, never production."""
import av, base64, io, json, math, struct
from fractions import Fraction
from PIL import Image, ImageDraw
image = Image.new("RGB", (320, 180), "#145e47")
ImageDraw.Draw(image).text((25, 75), "API ACCEPTANCE FIXTURE", fill="white")
out = io.BytesIO()
image.save(out, format="JPEG")
codec = av.CodecContext.create("libx264", "w")
codec.width, codec.height = 320, 180
codec.pix_fmt = "yuv420p"
codec.time_base = Fraction(1, 10)
codec.framerate = Fraction(10, 1)
codec.options = {"preset": "ultrafast", "tune": "zerolatency", "profile": "baseline", "level": "4.0", "g": "10", "bf": "0"}
frames = []
for index in range(20):
    frame = av.VideoFrame(320, 180, "yuv420p")
    for plane_index, plane in enumerate(frame.planes):
        plane.update(bytes([40 + index * 5 if plane_index == 0 else 128]) * plane.buffer_size)
    frame.pts = index
    for packet in codec.encode(frame):
        frames.append({"h264": base64.b64encode(bytes(packet)).decode(), "key": packet.is_keyframe, "width": 320, "height": 180, "displayWidth": 320, "codec": "avc1.42C028", "fps": 10})
pcm = b"".join(struct.pack("<h", int(math.sin(i * 2 * math.pi * 440 / 16000) * 1000)) for i in range(1600))
print(json.dumps({"jpeg": base64.b64encode(out.getvalue()).decode(), "frames": frames, "pcm": base64.b64encode(pcm).decode()}))
