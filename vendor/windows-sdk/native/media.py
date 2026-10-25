"""Bounded SDK byte stream for FFmpeg/PyAV; no files or credentials."""
from collections import deque
import io
import threading


class MediaBuffer(io.RawIOBase):
    def __init__(self, limit=8 * 1024 * 1024):
        super().__init__()
        self.limit = limit
        self.chunks = deque()
        self.size = 0
        self.done = False
        self.overflow = False
        self.condition = threading.Condition()

    def readable(self):
        return True

    def seekable(self):
        return False

    def push(self, data):
        with self.condition:
            if self.done:
                return
            if self.size + len(data) > self.limit:
                self.overflow = self.done = True
                self.condition.notify_all()
                return
            self.chunks.append(data)
            self.size += len(data)
            self.condition.notify()

    def read(self, size=-1):
        with self.condition:
            while not self.chunks and not self.done:
                self.condition.wait()
            if not self.chunks:
                return b""
            data = self.chunks.popleft()
            if size > 0 and len(data) > size:
                self.chunks.appendleft(data[size:])
                data = data[:size]
            self.size -= len(data)
            return data

    def finish(self):
        with self.condition:
            self.done = True
            self.condition.notify_all()
