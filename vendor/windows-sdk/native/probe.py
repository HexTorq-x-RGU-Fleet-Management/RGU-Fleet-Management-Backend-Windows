"""Isolated Windows SDK receiver/probe. Credentials arrive through stdin only.

Uses the installed vendor DLLs without copying them. Emits fixed diagnostics and
numeric SDK results, never raw cloud responses, callback text, or credentials.
Stream mode emits decoded JPEG and PCM packets for the authenticated local app.
"""
import ctypes as C
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
import base64
import io
import queue
from media import MediaBuffer

output_lock = threading.Lock()


def emit(stage, **values):
    with output_lock:
        print(json.dumps({"stage": stage, **values}), flush=True)


def installed_app_id(directory):
    # Recover only the SDK application identity from its own initialization log.
    # This is not an account token and is never returned or saved by this probe.
    log = directory / "log/opensdk/opensdk.log"
    text = log.read_bytes()[-8_000_000:].decode("utf8", errors="ignore")
    ids = re.findall(r"\bszAppId\s*=\s*([a-fA-F0-9]{32})\b", text)
    if not ids:
        raise ValueError("SDK identity not available")
    return ids[-1]


def main():
    if sys.platform != "win32":
        emit("unavailable", reason="Windows is required")
        return 1
    config = json.loads(sys.stdin.readline())
    directory = Path(config.get("sdkDirectory") or os.environ.get("HIK_SDK_DIRECTORY") or r"C:\Program Files (x86)\iVMS-4200 Site\iVMS-4200 Client\Client").resolve()
    app_id = config.get("appId") or installed_app_id(directory)
    token = config.get("accessToken")
    serial = config.get("serial")
    if not isinstance(token, str) or not token or not isinstance(serial, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", serial):
        emit("invalid-input")
        return 1
    # SDK writes diagnostics relative to its working directory. Keep runtime
    # files isolated and remove them at exit; do not alter installed client logs.
    with tempfile.TemporaryDirectory(prefix="hik-sdk-probe-") as runtime:
        previous = os.getcwd()
        os.chdir(runtime)
        handles = [os.add_dll_directory(str(directory))]
        for sub in ["HCNetSDKCom", "PlayCtrl"]:
            if (directory / sub).is_dir():
                handles.append(os.add_dll_directory(str(directory / sub)))
        sdk = C.WinDLL(str(directory / "OpenNetStream.dll"))

        def bind(name, args, result=C.c_int):
            fn = getattr(sdk, name)
            fn.argtypes = args
            fn.restype = result
            return fn

        init = bind("OpenSDK_InitLib", [C.c_char_p, C.c_char_p, C.c_char_p])
        fini = bind("OpenSDK_FiniLib", [])
        set_token = bind("OpenSDK_SetAccessToken", [C.c_char_p])
        set_config = bind("OpenSDK_SetConfigInfo", [C.c_int, C.c_int], None)
        set_data_center = bind("OpenSDK_SetDataCenterConfig", [C.c_char_p, C.c_char_p])
        details = bind("OpenSDK_Data_GetDevDetailInfo", [C.c_char_p, C.c_int, C.c_bool, C.POINTER(C.c_void_p), C.POINTER(C.c_int)])
        free_data = bind("OpenSDK_Data_Free", [C.c_void_p])
        last_error = bind("OpenSDK_GetLastErrorCode", [])
        message_callback = C.WINFUNCTYPE(None, C.c_char_p, C.c_uint, C.c_uint, C.c_void_p, C.c_void_p)
        data_callback = C.WINFUNCTYPE(None, C.c_int, C.c_void_p, C.c_int, C.c_void_p)
        allocate = bind("OpenSDK_AllocSessionEx", [message_callback, C.c_void_p, C.POINTER(C.c_char_p), C.POINTER(C.c_int)])
        release = bind("OpenSDK_FreeSession", [C.c_char_p])
        set_callback = bind("OpenSDK_SetDataCallBack", [C.c_char_p, data_callback, C.c_void_p])
        start = bind("OpenSDK_StartRealPlayEx", [C.c_char_p, C.c_void_p, C.c_char_p, C.c_int, C.c_char_p])
        start_quality = bind("OpenSDK_StartPlayWithStreamType", [C.c_char_p, C.c_void_p, C.c_char_p, C.c_int, C.c_char_p, C.c_int])
        stop = bind("OpenSDK_StopRealPlayEx", [C.c_char_p])
        initialized = False
        try:
            result = init(b"https://iindiaopenauth.ezvizlife.com", b"https://iindiaopen.ezvizlife.com", app_id.encode())
            emit("initialize", result=result)
            if result:
                return 1
            initialized = True
            set_config(4, 5)  # Documented CONFIG_LOG_LEVEL / EZOPENSDK_ERROR.
            set_config(2, 1)  # Documented CONFIG_OPEN_STREAMTRANS.
            if config.get("dataCenter"):
                result = set_data_center(str(directory / 'DataCenterApi_EX.dll').encode(), b'https://apiiindia.hik-connect.com')
                emit("data-center", result=result)
            if config.get("login"):
                login = bind("OpenSDK_Mid_Login", [C.POINTER(C.c_char_p), C.POINTER(C.c_int)])
                login_params = bind("OpenSDK_SetLoginParams", [C.c_int, C.c_char_p], None)
                login_params(1, b'244')
                login_params(3, b'https://iindiaopenauth.ezvizlife.com')
                login_token, login_length = C.c_char_p(), C.c_int()
                emit("sdk-login-window")
                result = login(C.byref(login_token), C.byref(login_length))
                emit("sdk-login-result", result=result)
                if result or not login_token.value:
                    return 1
                token = login_token.value.decode()
            result = set_token(token.encode())
            emit("set-session", result=result)
            if config.get("dataCenter"):
                modern_token = bind("OpenSDK_SetNonDeviceTkToken", [C.c_char_p])
                emit("set-regional-session", result=modern_token(token.encode()))
            if result:
                return 1
            data, length = C.c_void_p(), C.c_int()
            result = details(serial.encode(), int(config.get("channel", 1)), True, C.byref(data), C.byref(length))
            emit("device-details", result=result, sdkError=last_error(), responseBytes=length.value)
            if data.value:
                try:
                    if 0 < length.value < 4_000_000:
                        raw = C.string_at(data, length.value).rstrip(b"\x00")
                        try:
                            value = json.loads(raw)
                            emit("response-shape", fields=list(value) if isinstance(value, dict) else [],
                                 cloudCode=value.get("result", {}).get("code") if isinstance(value, dict) and isinstance(value.get("result"), dict) else None)
                            if isinstance(value, dict):
                                emit("camera-capabilities", encrypted=bool(value.get("isEncrypt")), shared=bool(value.get("shared")),
                                     channel=value.get("channelNo"), status=value.get("status"),
                                     supportTalk=value.get("support_talk") in (1, True, "1"))
                        except (ValueError, UnicodeDecodeError):
                            emit("response-shape", structured=False)
                finally:
                    free_data(data)
            if result != 0 or not config.get("play"):
                return 0 if result == 0 else 1
            received = threading.Event()
            decoded = threading.Event()
            stopping = threading.Event()
            preview_requested = threading.Event()
            preview_requested.set()
            media = MediaBuffer()
            totals = {}
            hik_audio = None
            if config.get("decode") and config.get("stream") and not config.get("previewOnly"):
                from ps_audio import HikAudio
                hik_audio = HikAudio(emit)
            def decode_media():
                try:
                    import av
                    with av.open(media, format="mpeg", options={"probesize": "131072", "analyzeduration": "1000000"}) as container:
                        if not (hik_audio and hik_audio.active.is_set()):
                            emit("audio-stream", available=bool(container.streams.audio),
                                 codec=container.streams.audio[0].codec_context.name if container.streams.audio else None)
                        previous_frame = 0
                        previous_preview = 0
                        from smooth import SmoothEncoder
                        smooth = SmoothEncoder('hd' if config.get('streamType') == 1 else 'sd', container.streams.video[0].average_rate or 25) if config.get('delivery') == 'smooth' else None
                        stats_at = time.monotonic()
                        source_frames = output_frames = output_bytes = 0
                        from audio import PCMEncoder, decoded_frames
                        audio_encoder = PCMEncoder()
                        audio_error_reported = False
                        def report_audio_error(error, phase):
                            nonlocal audio_error_reported
                            if not audio_error_reported and not (hik_audio and hik_audio.available.is_set()):
                                emit("audio-error", phase=phase, kind=type(error).__name__,
                                     code=getattr(error, "errno", None))
                                audio_error_reported = True
                        for frame in decoded_frames(container, report_audio_error, lambda: bool(hik_audio and hik_audio.active.is_set())):
                            if stopping.is_set():
                                break
                            if isinstance(frame, av.AudioFrame):
                                if config.get("stream") and not config.get("previewOnly") and not (hik_audio and hik_audio.active.is_set()):
                                    try:
                                        for audio in audio_encoder.encode(frame):
                                            emit("audio", **audio)
                                    except Exception as error:
                                        report_audio_error(error, "resample")
                                continue
                            if not decoded.is_set():
                                emit("decoded-frame", width=frame.width, height=frame.height,
                                     codec=container.streams.video[0].codec_context.name)
                                decoded.set()
                            now = time.monotonic()
                            source_frames += 1
                            if preview_requested.is_set() or now - previous_preview >= 300:
                                preview_requested.clear()
                                previous_preview = now
                                aspect = container.streams.video[0].sample_aspect_ratio
                                display_width = round(frame.width * float(aspect)) if aspect and 0.25 <= float(aspect) <= 4 else frame.width
                                image = frame.to_image()
                                if display_width != frame.width:
                                    image = image.resize((display_width, frame.height))
                                image.thumbnail((320, 180))
                                preview = io.BytesIO()
                                image.save(preview, format="JPEG", quality=60)
                                emit("preview", jpeg=base64.b64encode(preview.getvalue()).decode("ascii"), width=image.width, height=image.height)
                            if config.get("previewOnly"):
                                continue
                            if smooth:
                                for packet in smooth.encode(frame):
                                    aspect = container.streams.video[0].sample_aspect_ratio
                                    display_width = round(frame.width * float(aspect)) if aspect and 0.25 <= float(aspect) <= 4 else frame.width
                                    emit('video', **packet, displayWidth=display_width)
                                    output_frames += 1
                                    output_bytes += len(packet['h264'])
                            elif config.get("stream") and now - previous_frame >= 0.125:
                                previous_frame = now
                                jpeg = io.BytesIO()
                                frame.to_image().save(jpeg, format="JPEG", quality=88)
                                aspect = container.streams.video[0].sample_aspect_ratio
                                display_width = round(frame.width * float(aspect)) if aspect and 0.25 <= float(aspect) <= 4 else frame.width
                                emit("frame", jpeg=base64.b64encode(jpeg.getvalue()).decode("ascii"), displayWidth=display_width,
                                     width=frame.width, height=frame.height,
                                     codec=container.streams.video[0].codec_context.name)
                                output_frames += 1
                                output_bytes += len(base64.b64encode(jpeg.getvalue()))
                            if now - stats_at >= 3:
                                elapsed = now - stats_at
                                emit('video-stats', decodedFps=round(source_frames / elapsed, 1),
                                     outputFps=round(output_frames / elapsed, 1), videoKBps=round(output_bytes / elapsed / 1000, 1))
                                stats_at = now
                                source_frames = output_frames = output_bytes = 0
                except Exception as error:
                    emit("decoder-ended", errorType=type(error).__name__)
            decoder = threading.Thread(target=decode_media, daemon=True) if config.get("decode") else None
            if decoder:
                decoder.start()
            @message_callback
            def on_message(_session, kind, code, _message, _user):
                emit("playback-event", event=int(kind), code=int(code))
                if kind == 0:
                    stopping.set()
            @data_callback
            def on_data(kind, pointer, size, _user):
                if pointer and 0 < size < 16_000_000:
                    info = totals.setdefault(int(kind), {"packets": 0, "bytes": 0})
                    info["packets"] += 1
                    info["bytes"] += size
                    if "prefix" not in info:
                        info["prefix"] = C.string_at(pointer, min(size, 16)).hex()
                    received.set()
                    if hik_audio and kind in (1, 2):
                        hik_audio.feed(int(kind), C.string_at(pointer, size))
                    if kind == 2 and decoder:
                        media.push(C.string_at(pointer, size))
            playback_session, session_length = C.c_char_p(), C.c_int()
            result = allocate(on_message, None, C.byref(playback_session), C.byref(session_length))
            emit("allocate-playback", result=result)
            if result:
                return 1
            started = False
            talking = False
            talk_ping = [0.0]
            talk_commands = queue.Queue(maxsize=16)
            talk_start = bind("OpenSDK_StartVoiceTalkEx", [C.c_char_p, C.c_char_p, C.c_int]) if hasattr(sdk, "OpenSDK_StartVoiceTalkEx") else None
            talk_stop = bind("OpenSDK_StopVoiceTalk", [C.c_char_p]) if hasattr(sdk, "OpenSDK_StopVoiceTalk") else None
            try:
                result = set_callback(playback_session, on_data, None)
                emit("set-video-callback", result=result)
                if result:
                    return 1
                if config.get("streamType") in (1, 2):
                    result = start_quality(playback_session, None, serial.encode(), int(config.get("channel", 1)), None, config["streamType"])
                else:
                    result = start(playback_session, None, serial.encode(), int(config.get("channel", 1)), None)
                emit("start-video", result=result, sdkError=last_error())
                started = result == 0
                stream_started = time.monotonic()
                if not started:
                    return 1
                if config.get("stream"):
                    def watch_input():
                        for line in sys.stdin:
                            if len(line) > 4096:
                                continue
                            try:
                                command = json.loads(line).get("command")
                            except (ValueError, AttributeError):
                                continue
                            if command == "preview":
                                preview_requested.set()
                            elif command == "talk-heartbeat":
                                talk_ping[0] = time.monotonic()
                            elif command in ("talk-start", "talk-stop"):
                                try:
                                    talk_commands.put_nowait(command)
                                except queue.Full:
                                    stopping.set()
                        stopping.set()
                    threading.Thread(target=watch_input, daemon=True).start()
                    while not stopping.wait(0.1):
                        try:
                            command = talk_commands.get_nowait()
                        except queue.Empty:
                            command = None
                        if command == "talk-start" and not talking:
                            if talk_start and talk_stop and time.monotonic() - talk_ping[0] < 1.5:
                                result = talk_start(playback_session, serial.encode(), int(config.get("channel", 1)))
                                talking = result == 0
                            else:
                                result = -1
                            emit("talk-result", action="start", result=result)
                        if talking and (command == "talk-stop" or time.monotonic() - talk_ping[0] > 1.5):
                            result = talk_stop(playback_session)
                            talking = False
                            emit("talk-result", action="stop", result=result)
                        if media.overflow:
                            emit("media-overflow")
                            break
                        if not decoded.is_set() and time.monotonic() - stream_started > 30:
                            emit("decode-timeout")
                            break
                    return 0
                received.wait(15)
                if decoder:
                    decoded.wait(15)
                elif received.is_set():
                    time.sleep(3)
                emit("media-result", received=received.is_set(), types=totals)
                return 0 if (decoded.is_set() if decoder else received.is_set()) else 1
            finally:
                if talking and talk_stop:
                    talk_stop(playback_session)
                if started:
                    stop(playback_session)
                stopping.set()
                media.finish()
                if hik_audio:
                    hik_audio.close()
                if decoder:
                    decoder.join(2)
                release(playback_session)
        finally:
            if initialized:
                fini()
            os.chdir(previous)
            for handle in handles:
                handle.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        # No exception details: a DLL or upstream error can embed credentials.
        emit("probe-failed", errorType=type(error).__name__)
        sys.exit(1)
