#!/usr/bin/env python3
"""独立运行版的 Web 控制台。

控制台是常驻进程，任务进程是它拉起的子进程。重启因此是一次进程替换：
停止旧进程会连同在途请求一起结束，新进程从磁盘重新读取配置和 cookie 并全量运行任务。
配置页面由控制台提供，重启期间不会断线。

配置与点赞请求经由 stdin/stdout 上的单行 JSON 控制通道转发给任务进程；控制台自己不写
``storage.json``，文件的唯一写入方始终是任务进程，因此不存在两边并发覆盖。

任务进程的日志汇进内存缓冲供页面增量拉取，同时原样打印到控制台终端，便于脱离浏览器观察。

只依赖标准库，入口为 ``python console/console.py``。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections import OrderedDict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
CONSOLE_DIR = Path(__file__).resolve().parent
MAX_RECORDS = 1000
MAX_BODY = 4 * 1024 * 1024

# 没有 dist-web 时使用的精简页
FALLBACK_FILE = CONSOLE_DIR / "fallback.html"

# 控制行前缀，必须与 standalone/control.ts 的 CONTROL_PREFIX 一致
CONTROL_PREFIX = "\x1eBLTHCTL"
# 日志行的等级标记，必须与 standalone/polyfill.ts 的 LOG_LEVEL_MARK 一致
LEVEL_MARK = re.compile(r"^\x1eBLTHLVL:(debug|info|warn|error)\x1e ?")
# Logger 的前缀形如 BLTH[2026/11/10 11:00:00][Standalone][DailyTask]:，冒号之后是正文
LOGGER_PREFIX = re.compile(r"^BLTH\[[^\]]*\]((?:\[[^\]]*\])*):")
# 未带标记的 stderr（崩溃栈、Node 自身的告警）只能按文本区分严重程度
ERROR_HINTS = ("出错", "失败", "错误", "error", "Error")

# 由控制台转发到任务进程的操作；其余接口（状态、日志、重启、页面）由控制台自己处理
PROXY_GET = {
    "/api/tasks": "tasks.get",
    "/api/modules": "modules.get",
    "/api/like": "like.get",
    "/api/medals": "medals.get",
}
PROXY_POST = {
    "/api/tasks": "tasks.set",
    "/api/modules": "modules.set",
    "/api/like": "like.set",
    "/api/medals": "medals.set",
}
# 收集点赞候选要逐个探测直播间，耗时与房间数成正比
LONG_ACTIONS = {"like.get"}

# 头像代理：B 站图床对来自本机页面的 Referer 返回 403，也不带 CORS 头，
# 浏览器直连必然失败。改由控制台带上正常站点 Referer 取回，页面只访问同源地址。
AVATAR_HOSTS = ("hdslb.com", "bilibili.com")
AVATAR_REFERER = "https://www.bilibili.com/"
AVATAR_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)
AVATAR_MAX_BYTES = 2 * 1024 * 1024
AVATAR_CACHE_LIMIT = 300
AVATAR_CACHE_SECONDS = 86400


class AvatarCache:
    """头像按 URL 缓存在内存。

    名单每次展开都会重取一遍数据，头像 URL 不变时不必重复下载；
    浏览器侧另有 ``max-age``，正常情况下连控制台都不会再来问。
    """

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.items: OrderedDict[str, tuple[bytes, str]] = OrderedDict()
        self.lock = threading.Lock()

    def get(self, url: str) -> tuple[bytes, str] | None:
        with self.lock:
            item = self.items.get(url)
            if item is not None:
                self.items.move_to_end(url)
            return item

    def put(self, url: str, item: tuple[bytes, str]) -> None:
        with self.lock:
            self.items[url] = item
            self.items.move_to_end(url)
            while len(self.items) > self.limit:
                self.items.popitem(last=False)


AVATAR_CACHE = AvatarCache(AVATAR_CACHE_LIMIT)


def avatar_allowed(url: str) -> bool:
    """只代理 B 站的图床，避免控制台被当成任意地址的取数跳板"""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    return any(host == base or host.endswith(f".{base}") for base in AVATAR_HOSTS)


def fetch_avatar(url: str) -> tuple[bytes, str]:
    request = Request(
        url,
        headers={
            "Referer": AVATAR_REFERER,
            "User-Agent": AVATAR_UA,
            "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
        },
    )

    with urlopen(request, timeout=8) as response:
        # 只在最终地址仍属于白名单时接受内容，防止被 302 带到别处
        if not avatar_allowed(response.geturl()):
            raise ValueError("重定向到不受信任的地址")

        content_type = (
            (response.headers.get("Content-Type") or "").split(";")[0].strip()
        )
        if not content_type.startswith("image/"):
            raise ValueError(f"返回的不是图片（{content_type or '无类型'}）")

        data = response.read(AVATAR_MAX_BYTES + 1)

    if len(data) > AVATAR_MAX_BYTES:
        raise ValueError("图片超过大小上限")
    return data, content_type


# 终端输出锁：stdout/stderr 两个读取线程与请求线程都会打印，整行加锁避免交错
PRINT_LOCK = threading.Lock()


def print_line(level: str, title: str, text: str) -> None:
    """把一行日志同时送到控制台终端。

    终端只是观察窗口：编码表达不了的字符（emoji、生僻字）按替换输出，整行不能丢；
    stdout 被关闭或指向不可写的管道时直接放弃，不能让打印失败打断读取线程、
    连带丢掉后续日志。等级只在非 info 时标注，日常日志保持原样。
    """
    stream = sys.stdout
    if stream is None:
        return

    body = f"{title} {text}".strip() if title else text
    line = body if level == "info" else f"[{level.upper()}] {body}"

    with PRINT_LOCK:
        try:
            try:
                stream.write(line + "\n")
            except UnicodeEncodeError:
                codec = getattr(stream, "encoding", None) or "utf-8"
                stream.write(
                    line.encode(codec, "replace").decode(codec, "replace") + "\n"
                )
            stream.flush()
        except (OSError, ValueError):
            pass


class LogBuffer:
    """控制台进程内的日志环形缓冲。

    seq 全局单调递增，重启任务进程不重置：页面按 seq 增量拉取，日志保持连续。
    session 只在控制台自身重启时变化，页面据此丢弃旧缓冲重取。
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.records: deque[dict] = deque(maxlen=MAX_RECORDS)
        self.next_seq = 1
        self.session = uuid.uuid4().hex[:8]

    def append(self, level: str, line: str, title: str | None = None) -> None:
        match = LOGGER_PREFIX.match(line)
        if title is None:
            title = match.group(1) if match else ""
        text = line[match.end() :].strip() if match else line.strip()

        with self.lock:
            self.records.append(
                {
                    "seq": self.next_seq,
                    "time": int(time.time() * 1000),
                    "level": level,
                    "title": title,
                    "text": text,
                }
            )
            self.next_seq += 1

        print_line(level, title, text)

    def since(self, after: int) -> dict:
        with self.lock:
            return {
                "session": self.session,
                "records": [record for record in self.records if record["seq"] > after],
            }


class ControlChannel:
    """把 HTTP 请求转发到任务进程的 stdin，并按 id 匹配 stdout 上的响应。

    一次只存在一个任务进程：换进程时挂起的请求全部立即失败，不会把旧进程的响应
    交给新进程的请求。
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.write_lock = threading.Lock()
        self.pending: dict[int, list] = {}
        self.next_id = 1
        self.stdin = None
        self.owner: subprocess.Popen | None = None

    @property
    def connected(self) -> bool:
        with self.lock:
            return self.stdin is not None

    def attach(self, process: subprocess.Popen) -> None:
        with self.lock:
            self._fail_all(503, "任务进程已重启，请重试")
            self.stdin = process.stdin
            self.owner = process

    def detach(self, process: subprocess.Popen) -> None:
        """只作废指定进程；新进程已经接替时晚到的旧通知不能切断它。"""
        with self.lock:
            if self.owner is not process:
                return
            self._fail_all(503, "任务进程未运行")
            self.stdin = None
            self.owner = None

    def _fail_all(self, status: int, message: str) -> None:
        # 调用方必须持有 self.lock；保留槽位，由等待方自行取走结果
        for slot in self.pending.values():
            slot[1] = (status, {"error": message})
            slot[0].set()

    def on_line(self, line: str) -> bool:
        """处理 stdout 上的一行；返回 True 表示这是控制行，不该记进日志。"""
        if not line.startswith(CONTROL_PREFIX):
            return False

        try:
            message = json.loads(line[len(CONTROL_PREFIX) :])
            request_id = message["id"]
        except (ValueError, KeyError, TypeError):
            return True

        with self.lock:
            slot = self.pending.get(request_id)
            if slot is None:
                return True
            slot[1] = (int(message.get("status", 500)), message.get("data") or {})
            slot[0].set()
        return True

    def request(
        self, action: str, payload: dict, timeout: float = 30.0
    ) -> tuple[int, object]:
        with self.lock:
            stream = self.stdin
            if stream is None:
                return 503, {"error": "任务进程未运行"}
            request_id = self.next_id
            self.next_id += 1
            event = threading.Event()
            self.pending[request_id] = [event, None]

        line = (
            json.dumps(
                {"id": request_id, "action": action, "payload": payload},
                ensure_ascii=False,
            )
            + "\n"
        )

        try:
            with self.write_lock:
                stream.write(line)
                stream.flush()
        except (OSError, ValueError):
            with self.lock:
                self.pending.pop(request_id, None)
            return 503, {"error": "控制通道已断开"}

        if not event.wait(timeout):
            with self.lock:
                self.pending.pop(request_id, None)
            return 504, {"error": "任务进程响应超时"}

        with self.lock:
            slot = self.pending.pop(request_id, None)
            return slot[1] if slot else (503, {"error": "控制通道已重启"})


class Supervisor:
    """管理任务进程的生命周期，并把它的输出汇进日志缓冲。"""

    def __init__(
        self,
        command: list[str],
        cwd: Path,
        logs: LogBuffer,
        control: ControlChannel,
    ) -> None:
        self.command = command
        self.cwd = cwd
        self.logs = logs
        self.control = control
        self.env = os.environ.copy()
        self.lock = threading.Lock()
        self.restart_lock = threading.Lock()
        self.process: subprocess.Popen | None = None
        self.started_at: float | None = None
        self.exit_code: int | None = None
        self.readers: list[threading.Thread] = []
        self.waiter: threading.Thread | None = None

    def status(self) -> dict:
        with self.lock:
            process = self.process
            running = bool(process and process.poll() is None)
            return {
                "running": running,
                "pid": process.pid if running else None,
                "session": self.logs.session,
                "startedAt": int(self.started_at * 1000) if self.started_at else None,
                "exitCode": self.exit_code,
                "control": self.control.connected,
            }

    def set_env(self, key: str, value: str) -> None:
        """设置子进程环境变量，下次启动生效。"""
        with self.lock:
            self.env[key] = value

    def start(self) -> bool:
        with self.lock:
            if self.process and self.process.poll() is None:
                return False

            kwargs: dict = {}
            if os.name == "nt":
                # Ctrl+Break 只能发给独立进程组，否则控制台自己也会收到
                kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP

            try:
                process = subprocess.Popen(
                    self.command,
                    cwd=str(self.cwd),
                    env=dict(self.env),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    **kwargs,
                )
            except OSError as error:
                self.logs.append(
                    "error", f"任务进程启动失败：{error}", title="[Console]"
                )
                return False

            self.process = process
            self.started_at = time.time()
            self.exit_code = None
            self.control.attach(process)
            self.readers = [
                threading.Thread(target=self._reader, args=(stream, level), daemon=True)
                for stream, level in (
                    (process.stdout, "info"),
                    (process.stderr, "stderr"),
                )
            ]
            self.waiter = threading.Thread(
                target=self._waiter, args=(process,), daemon=True
            )

        self.logs.append(
            "info", f"任务进程已启动（PID {process.pid}）", title="[Console]"
        )
        for reader in self.readers:
            reader.start()
        self.waiter.start()
        return True

    def _reader(self, stream, stream_level: str) -> None:
        try:
            for line in stream:
                line = line.rstrip("\r\n")
                if not line:
                    continue
                if stream_level == "info" and self.control.on_line(line):
                    continue
                level = "info"
                marked = LEVEL_MARK.match(line)
                if marked:
                    level = marked.group(1)
                    line = line[marked.end() :]
                elif stream_level == "stderr":
                    level = (
                        "error" if any(hint in line for hint in ERROR_HINTS) else "warn"
                    )
                self.logs.append(level, line)
        finally:
            stream.close()

    def _waiter(self, process: subprocess.Popen) -> None:
        code = process.wait()
        with self.lock:
            # 新进程已经接替时，旧进程的退出不该改掉当前状态
            if self.process is process:
                self.exit_code = code
        self.control.detach(process)
        self.logs.append(
            "warn" if code else "info",
            f"任务进程已退出（code {code}）",
            title="[Console]",
        )

    def stop(self, timeout: float = 3.0) -> None:
        with self.lock:
            process = self.process
            readers = list(self.readers)
            waiter = self.waiter

        if not process:
            return

        if process.poll() is None:
            try:
                if os.name == "nt":
                    break_event = getattr(signal, "CTRL_BREAK_EVENT", None)
                    if break_event is None:
                        process.kill()
                    else:
                        process.send_signal(break_event)
                else:
                    process.terminate()
            except OSError:
                # 进程可能刚好退出，交给下面的等待处理
                pass

            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

        # 排空管道，保证旧进程的最后几行日志排在新进程日志之前
        for reader in readers:
            reader.join(timeout=1.0)
        if waiter:
            waiter.join(timeout=1.0)

        self.control.detach(process)
        if process.stdin and not process.stdin.closed:
            try:
                process.stdin.close()
            except OSError:
                pass

    def try_restart(self) -> bool:
        """发起一次重启；已在重启中时拒绝，避免连点叠加多份进程。"""
        if not self.restart_lock.acquire(blocking=False):
            return False
        threading.Thread(target=self._restart_worker, daemon=True).start()
        return True

    def _restart_worker(self) -> None:
        try:
            self.stop()
            self.start()
        finally:
            self.restart_lock.release()


class Handler(BaseHTTPRequestHandler):
    supervisor: Supervisor
    logs: LogBuffer
    control: ControlChannel
    web_page: Path

    def log_message(self, _format: str, *_args: object) -> None:
        # 访问日志会混进终端输出，这里保持安静
        pass

    def _send(
        self, status: int, body: bytes, content_type: str, cache_seconds: int = 0
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if cache_seconds > 0:
            self.send_header("Cache-Control", f"public, max-age={cache_seconds}")
        else:
            self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # 长请求期间页面被关闭，响应无人接收，不影响控制台继续服务
            pass

    def _send_json(self, status: int, data: object) -> None:
        self._send(
            status,
            json.dumps(data, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def _read_body(self) -> bytes | None:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            return None
        if length < 0 or length > MAX_BODY:
            return None
        return self.rfile.read(length)

    def _proxy(self, action: str, body: bytes | None) -> None:
        payload: dict = {}
        if body is not None:
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except (ValueError, UnicodeDecodeError):
                self._send_json(400, {"error": "请求体不是合法的 JSON"})
                return
            if not isinstance(payload, dict):
                self._send_json(400, {"error": "请求体必须是 JSON 对象"})
                return

        timeout = 900.0 if action in LONG_ACTIONS else 30.0
        status, data = self.control.request(action, payload, timeout)
        self._send_json(status, data)

    def _serve_page(self) -> None:
        if self.web_page.is_file():
            self._send(200, self.web_page.read_bytes(), "text/html; charset=utf-8")
            return

        # 精简页缺失时至少给一句可读的提示，而不是空白页
        if FALLBACK_FILE.is_file():
            self._send(200, FALLBACK_FILE.read_bytes(), "text/html; charset=utf-8")
        else:
            self._send(
                500,
                f"缺少 {FALLBACK_FILE}：先执行 npm run build-web，或恢复控制台的精简页".encode(
                    "utf-8"
                ),
                "text/plain; charset=utf-8",
            )

    def _serve_avatar(self, url: str) -> None:
        if not url or not avatar_allowed(url):
            self._send_json(400, {"error": "只代理 B 站图床地址"})
            return

        cached = AVATAR_CACHE.get(url)
        if cached is not None:
            self._send(200, cached[0], cached[1], AVATAR_CACHE_SECONDS)
            return

        try:
            data, content_type = fetch_avatar(url)
        except Exception as err:  # 头像取不到只是显示成默认头像，不该影响页面其它功能
            self._send_json(502, {"error": f"取头像失败：{err}"})
            return

        AVATAR_CACHE.put(url, (data, content_type))
        self._send(200, data, content_type, AVATAR_CACHE_SECONDS)

    def do_GET(self) -> None:
        url = urlparse(self.path)
        path = url.path

        if path in ("/", "/index.html"):
            self._serve_page()
            return

        if path == "/favicon.ico":
            self._send(204, b"", "image/x-icon")
            return

        if path == "/api/logs":
            try:
                after = int(parse_qs(url.query).get("after", ["0"])[0])
            except ValueError:
                after = 0
            self._send_json(200, self.logs.since(after))
            return

        if path == "/api/status":
            self._send_json(200, self.supervisor.status())
            return

        if path == "/api/avatar":
            self._serve_avatar(parse_qs(url.query).get("url", [""])[0])
            return

        if path in PROXY_GET:
            self._proxy(PROXY_GET[path], None)
            return

        self._send_json(404, {"error": "Not Found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path

        if path == "/api/restart":
            if self.supervisor.try_restart():
                self._send_json(202, {"accepted": True})
            else:
                self._send_json(409, {"error": "正在重新启动"})
            return

        if path in PROXY_POST:
            body = self._read_body()
            if body is None:
                self._send_json(400, {"error": "请求体长度不合法"})
                return
            self._proxy(PROXY_POST[path], body)
            return

        self._send_json(404, {"error": "Not Found"})


def main() -> int:
    parser = argparse.ArgumentParser(description="BLTH 独立运行版 Web 控制台")
    parser.add_argument(
        "--node", default=shutil.which("node") or "node", help="Node 可执行文件"
    )
    parser.add_argument(
        "--script",
        default=str(ROOT / "dist-standalone" / "blth-standalone.mjs"),
        help="任务进程入口",
    )
    parser.add_argument(
        "--web",
        default=str(ROOT / "dist-web" / "index.html"),
        help="配置页面产物",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("BLTH_CONFIG_PORT", "8787")),
        help="控制台监听端口",
    )
    args = parser.parse_args()

    script = Path(args.script).resolve()
    if not script.is_file():
        print(
            f"找不到任务进程产物：{script}\n请先执行 npm run build-standalone",
            file=sys.stderr,
        )
        return 1

    web_page = Path(args.web).resolve()
    if not web_page.is_file():
        print(
            f"找不到配置页面产物：{web_page}\n请先执行 npm run build-web（当前使用精简页）",
            file=sys.stderr,
        )

    logs = LogBuffer()
    control = ControlChannel()
    supervisor = Supervisor([args.node, str(script)], ROOT, logs, control)
    Handler.supervisor = supervisor
    Handler.logs = logs
    Handler.control = control
    Handler.web_page = web_page
    supervisor.start()

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    server.daemon_threads = True
    print(f"控制台：http://0.0.0.0:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        supervisor.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
