"""
Vosk WebSocket server for SPX Voice Input v2.
Listens on ws://localhost:2700, restricted to digit/letter grammar for accuracy.

Browser side:
  - Opens WS, sends raw 16kHz mono Int16 PCM as binary frames
  - Receives JSON: {"partial": "..."} for interim, {"text": "..."} for final
  - Sends text command {"command": "reset"} between AWBs to clear recognizer state
"""
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

# Hide errors from terminal but log to file
SCRIPT_DIR = Path(__file__).resolve().parent
LOG_FILE   = SCRIPT_DIR / "vosk_server.log"
MODEL_DIR  = SCRIPT_DIR / "vosk-model-small-vn-0.4"

logging.basicConfig(
    filename=str(LOG_FILE),
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("vosk_server")

try:
    from vosk import Model, KaldiRecognizer, SetLogLevel
    import websockets
except ImportError as e:
    log.error("Missing dependency: %s. Run setup_vosk.bat to install.", e)
    sys.exit(1)

SetLogLevel(-1)  # silence Kaldi C++ logs

SAMPLE_RATE = 16000
HOST        = "127.0.0.1"
PORT        = 2700

# Grammar: only allow digit/letter words (boost recognition accuracy x2-3)
# Vosk lowercases input, so keep entries lowercase. Cover Vietnamese + variants.
GRAMMAR = json.dumps([
    # Digits
    "không", "khong", "zero", "ô",
    "một", "mot", "mốt",
    "hai",
    "ba",
    "bốn", "bon", "tư", "tu",
    "năm", "nam", "lăm", "lam",
    "sáu", "sau", "xấu", "xau",
    "bảy", "bay",
    "tám", "tam",
    "chín", "chin", "chính", "chinh",
    # Letters A B C
    "a", "bê", "be", "cê", "ce",
    # Letters S P X V N (full AWB prefix)
    "ét", "et", "pê", "pe", "ích", "ich", "ít", "it", "vi", "vê", "ve", "en", "nờ",
    # Completion commands
    "chốt", "chot", "kết", "ket", "thúc", "thuc", "phiên", "phien",
    "xong", "rồi", "roi", "hết", "het", "đã", "da", "đóng", "dong",
    "[unk]",   # allow unknown for robustness
])


async def handle(ws):
    log.info("client connected: %s", ws.remote_address)
    rec = KaldiRecognizer(MODEL, SAMPLE_RATE, GRAMMAR)
    rec.SetWords(False)
    try:
        async for message in ws:
            if isinstance(message, bytes):
                # Audio chunk
                if rec.AcceptWaveform(message):
                    await ws.send(rec.Result())   # final
                else:
                    await ws.send(rec.PartialResult())  # interim
            else:
                # Control command (str)
                try:
                    cmd = json.loads(message)
                except Exception:
                    continue
                if cmd.get("command") == "reset":
                    rec = KaldiRecognizer(MODEL, SAMPLE_RATE, GRAMMAR)
                    rec.SetWords(False)
                elif cmd.get("command") == "eof":
                    await ws.send(rec.FinalResult())
    except websockets.ConnectionClosed:
        pass
    except Exception as e:
        log.exception("handler error: %s", e)
    finally:
        log.info("client disconnected")


async def main():
    if not MODEL_DIR.exists():
        log.error("Model dir not found: %s", MODEL_DIR)
        sys.exit(2)
    log.info("Loading model from %s ...", MODEL_DIR)
    global MODEL
    MODEL = Model(str(MODEL_DIR))
    log.info("Model loaded. Listening on ws://%s:%d", HOST, PORT)
    async with websockets.serve(handle, HOST, PORT, max_size=2**20):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("shutdown")
    except Exception as e:
        log.exception("fatal: %s", e)
        sys.exit(1)
