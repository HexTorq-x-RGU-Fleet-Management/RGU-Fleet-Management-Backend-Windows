"""Generate unmistakable synthetic frames for the isolated browser fixture."""
import base64
import io
import json
from PIL import Image, ImageDraw

frames = []
for position in (80, 220):
    image = Image.new('RGB', (640, 360), '#1c3049')
    draw = ImageDraw.Draw(image)
    draw.rectangle((position, 110, position + 180, 230), fill='#c94b53')
    draw.text((30, 30), 'SYNTHETIC TEST FEED - NOT A CAMERA', fill='white')
    draw.text((30, 300), 'Windows v2 automated browser validation', fill='white')
    output = io.BytesIO()
    image.save(output, format='JPEG', quality=85)
    frames.append(base64.b64encode(output.getvalue()).decode('ascii'))
print(json.dumps(frames))
