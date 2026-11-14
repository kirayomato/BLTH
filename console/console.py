#!/usr/bin/env python3
"""独立运行版的 Web 控制台。

控制台是常驻进程，为每个账号各拉起一个任务进程（每个进程 = 一个账号，独立的数据目录与
cookie，互不影响）。重启因此是一次进程替换：停止旧进程会连同在途请求一起结束，新进程从磁盘
重新读取配置和 cookie 并全量运行任务。配置页面由控制台提供，重启期间不会断线。

配置与点赞请求经由 stdin/stdout 上的单行 JSON 控制通道转发给任务进程；控制台自己不写
``storage.json``，文件的唯一写入方始终是任务进程，因此不存在两边并发覆盖。

定时重启由控制台自己调度并存进 ``data/console.json``：全局一份设置，作用于全部账号，
与任务进程的配置分开。

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
from itertools import islice
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
CONSOLE_DIR = Path(__file__).resolve().parent
MAX_RECORDS = 10000
# 日志保底保留时长：条数超限时，这段时间内的记录一条都不丢，避免密集日志把刚产生的行挤掉
MIN_KEEP_SECONDS = 3600
# 保底时长内仍持续增长时的兜底，防止突发日志吃光内存
HARD_MAX_RECORDS = 50000
MAX_BODY = 10 * 1024 * 1024

# 多账号：每个账号是 data/accounts/<别名>/ 下的一个子目录，含 cookie.txt 与 storage.json
ACCOUNTS_ROOT = ROOT / "data" / "accounts"
# 账号作用域接口的前缀，其后依次是账号名与子路径
ACCOUNT_PREFIX = "/api/accounts/"
# 旧版单账号数据在根目录，首启时复制成默认账号（原文件保留）
LEGACY_STORAGE = ROOT / "data" / "storage.json"
LEGACY_COOKIE = ROOT / "cookie.txt"
DEFAULT_ACCOUNT = "默认"

# 定时重启是控制台级的全局设置：一份配置作用于全部账号，由控制台自己落盘。
# 它不属于任务进程的 modules 配置，不能写进 storage.json（那里面只有任务进程能写）。
SCHEDULE_FILE = ROOT / "data" / "console.json"
SCHEDULE_MIN_HOURS = 0.5
SCHEDULE_MAX_HOURS = 168
SCHEDULE_DEFAULT_HOURS = 6
# 调度线程的轮询间隔：到点判断不需要更细的粒度
SCHEDULE_TICK_SECONDS = 5

# 没有 dist-web 时使用的精简页
FALLBACK_FILE = CONSOLE_DIR / "fallback.html"

# 账号名就是目录名，不允许夹带路径分隔符等会造成越界的字符
INVALID_NAME_CHARS = set('/\\:*?"<>|')

def valid_account_name(name: str) -> bool:
    return (
        bool(name)
        and not name.startswith(".")
        and name not in (".", "..")
        and not any(c in INVALID_NAME_CHARS for c in name)
    )

# 控制行前缀，必须与 standalone/control.ts 的 CONTROL_PREFIX 一致
CONTROL_PREFIX = "\x1eBLTHCTL"
# 日志行的等级标记，必须与 standalone/polyfill.ts 的 LOG_LEVEL_MARK 一致
LEVEL_MARK = re.compile(r"^\x1eBLTHLVL:(debug|info|warn|error)\x1e ?")
# Logger 的前缀形如 BLTH[2026/11/10 11:00:00][Standalone][DailyTask]:，冒号之后是正文
LOGGER_PREFIX = re.compile(r"^BLTH\[[^\]]*\]((?:\[[^\]]*\])*):")
# 未带标记的 stderr（崩溃栈、Node 自身的告警）只能按文本区分严重程度
ERROR_HINTS = ("出错", "失败", "错误", "error", "Error")

# 由控制台转发到任务进程的操作；其余接口（状态、日志、重启、页面）由控制台自己处理
# 键是 /api/accounts/<账号名>/ 之后的子路径（无前导斜杠），代理到对应账号的任务进程
PROXY_GET = {
    "tasks": "tasks.get",
    "modules": "modules.get",
    "params": "params.get",
    "like": "like.get",
    "medals": "medals.get",
    "watch": "watch.get",
}
PROXY_POST = {
    "tasks": "tasks.set",
    "modules": "modules.set",
    "params": "params.set",
    "like": "like.set",
    "medals": "medals.set",
}
# 需要逐个探测直播间的操作，耗时与房间数成正比
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


def format_when(timestamp: float) -> str:
    """把秒级时间戳格式化成控制台所在时区的可读时间。"""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(timestamp))


class LogBuffer:
    """控制台进程内的日志环形缓冲。

    seq 全局单调递增，重启任务进程不重置：页面按 seq 增量拉取，日志保持连续。
    session 只在控制台自身重启时变化，页面据此丢弃旧缓冲重取。

    淘汰按时间保底、条数兜底：条数超过上限时只丢已经超过保底时长的记录，
    保底时长内即使超过上限也保留，直到触到硬上限才不计年龄丢弃。
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.records: deque[dict] = deque()
        self.next_seq = 1
        self.session = uuid.uuid4().hex[:8]

    def append(self, level: str, line: str, title: str | None = None) -> dict:
        match = LOGGER_PREFIX.match(line)
        if title is None:
            title = match.group(1) if match else ""
        text = line[match.end() :].strip() if match else line.strip()
        now = int(time.time() * 1000)

        with self.lock:
            record = {
                "seq": self.next_seq,
                "time": now,
                "level": level,
                "title": title,
                "text": text,
            }
            self.records.append(record)
            self._trim(now)
            self.next_seq += 1

        print_line(level, title, text)
        return record

    def extend(self, record: dict, line: str) -> bool:
        """把多行输出的续行并回起始记录。

        一条 console 调用可能打出多行（对象展开、错误栈），等级标记只落在首行；
        续行并进同一条记录，等级、模块、关键词才能对整块生效。记录已被淘汰时
        返回 False，调用方按普通行另行入库。
        """
        with self.lock:
            if not self.records or record["seq"] < self.records[0]["seq"]:
                return False
            record["text"] = f'{record["text"]}\n{line.rstrip()}'
            return True

    def _trim(self, now: int) -> None:
        """丢弃旧记录；调用方必须持有 self.lock。

        记录按时间递增入队，队首一旦在保底期内即可停止按时间淘汰。
        """
        oldest_kept = now - MIN_KEEP_SECONDS * 1000
        while len(self.records) > MAX_RECORDS and self.records[0]["time"] <= oldest_kept:
            self.records.popleft()
        while len(self.records) > HARD_MAX_RECORDS:
            self.records.popleft()

    def since(
        self,
        after: int,
        limit: int = 0,
        *,
        levels: set[str] | None = None,
        title: str = "",
        keyword: str = "",
    ) -> dict:
        """按序号增量取日志，筛选在服务端完成。

        ``levels`` 为空表示不限等级；``title`` 是模块名，空表示不限；
        ``keyword`` 匹配「模块 + 正文」的小写子串，与页面原先的本地筛选同义。

        响应里的 ``modules`` 只在从头取（``after`` 为 0）时计算，供页面刷新下拉候选；
        ``lastSeq`` 是缓冲里最新的序号，没有记录命中筛选时页面也要靠它前移游标，
        否则每一轮都会重扫同一段。
        """
        needle = keyword.lower()

        with self.lock:
            # 缓冲内的序号连续，可以按序号差直接跳到未读位置，不必每轮扫全量
            starting = 0
            if after > 0 and self.records:
                starting = max(0, after - self.records[0]["seq"] + 1)

            # 模块候选按整段缓冲去重，只在从头取时算一次
            modules = (
                sorted({record["title"] for record in self.records if record["title"]})
                if after == 0
                else []
            )

            records = []
            for record in islice(self.records, starting, None):
                if levels and record["level"] not in levels:
                    continue
                if title and record["title"] != title:
                    continue
                if needle and needle not in f'{record["title"]} {record["text"]}'.lower():
                    continue
                records.append(record)

            if limit > 0:
                records = records[-limit:]

            return {
                "session": self.session,
                "records": records,
                "lastSeq": self.next_seq - 1,
                "modules": modules,
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
        # 等级标记只落在多行输出的首行，续行靠 record 定位并回同一条记录
        record = None
        try:
            for line in stream:
                line = line.rstrip("\r\n")
                if not line:
                    continue
                if stream_level == "info" and self.control.on_line(line):
                    continue

                marked = LEVEL_MARK.match(line)
                if marked:
                    record = self.logs.append(marked.group(1), line[marked.end() :])
                    continue

                if record is not None and self.logs.extend(record, line):
                    print_line("info", "", line)
                    continue

                level = "info"
                if stream_level == "stderr":
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


class Account:
    """一个账号：独立的日志缓冲、控制通道与任务进程。

    进程通过环境变量读写自己的数据目录与 cookie 文件，彼此完全隔离；
    任一账号出错或重启都不影响其它账号。
    """

    def __init__(self, name: str, directory: Path, command: list[str], cwd: Path) -> None:
        self.name = name
        self.directory = directory
        self.logs = LogBuffer()
        self.control = ControlChannel()
        self.supervisor = Supervisor(command, cwd, self.logs, self.control)
        self.supervisor.set_env("BLTH_DATA_DIR", str(directory))
        self.supervisor.set_env("BLTH_COOKIE_FILE", str(directory / "cookie.txt"))

    def start(self) -> bool:
        return self.supervisor.start()

    def stop(self) -> None:
        self.supervisor.stop()

    def restart(self) -> bool:
        return self.supervisor.try_restart()

    def status(self) -> dict:
        status = self.supervisor.status()
        status["name"] = self.name
        return status


class AccountManager:
    """扫描并管理 data/accounts/ 下的账号。"""

    def __init__(self, node: str, script: Path) -> None:
        self.command = [node, str(script)]
        self.accounts: OrderedDict[str, Account] = OrderedDict()

    def ensure_default(self) -> None:
        """首次启动时把旧的根目录单账号复制成默认账号，原文件保留不删。

        只有当账号目录还不存在任何账号、且旧根目录确有配置时才迁移，避免覆盖用户自建目录。
        """
        if not LEGACY_STORAGE.is_file():
            return
        if ACCOUNTS_ROOT.is_dir() and any(ACCOUNTS_ROOT.iterdir()):
            return

        target = ACCOUNTS_ROOT / DEFAULT_ACCOUNT
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy2(LEGACY_STORAGE, target / "storage.json")
        if LEGACY_COOKIE.is_file():
            shutil.copy2(LEGACY_COOKIE, target / "cookie.txt")
        else:
            (target / "cookie.txt").write_text("", encoding="utf-8")
        print_line(
            "info",
            "[Console]",
            f"已把旧版单账号配置复制为默认账号：{target}（原文件保留）",
        )

    def scan(self) -> None:
        """扫描账号目录，按名称建立账号；不启动进程，启动交给调用方统一处理。"""
        self.accounts.clear()
        if not ACCOUNTS_ROOT.is_dir():
            return
        for entry in sorted(ACCOUNTS_ROOT.iterdir(), key=lambda item: item.name):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            account = Account(entry.name, entry, self.command, ROOT)
            self.accounts[entry.name] = account

    def names(self) -> list[str]:
        return list(self.accounts)

    def get(self, name: str) -> Account | None:
        return self.accounts.get(name)

    def create(self, name: str, cookie: str = "") -> Account | None:
        """新建账号目录并登记；进程由调用方决定何时启动。"""
        if not valid_account_name(name) or name in self.accounts:
            return None
        directory = ACCOUNTS_ROOT / name
        if directory.exists():
            return None
        directory.mkdir(parents=True)
        (directory / "cookie.txt").write_text(cookie or "", encoding="utf-8")
        account = Account(name, directory, self.command, ROOT)
        self.accounts[name] = account
        return account

    def remove(self, name: str) -> bool:
        """停掉账号进程并从清单移除；账号目录保留，便于找回 cookie 等数据。"""
        account = self.accounts.pop(name, None)
        if account is None:
            return False
        account.stop()
        return True


class RestartSchedule:
    """全局定时重启设置：按固定间隔重启全部账号的任务进程。

    配置由控制台自己写进 ``data/console.json``，与任务进程独占的 ``storage.json`` 分开。
    下次重启时刻只在内存里维护：控制台自身重启后重新计时，避免残留的过期时间戳
    让页面一打开就立刻触发一轮重启。
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.enabled = False
        self.interval_hours: float = SCHEDULE_DEFAULT_HOURS
        self.next_at: float | None = None
        self._load()
        self._arm(time.time())

    def _load(self) -> None:
        """读取上次保存的设置；文件缺失或损坏时静默回退到默认关闭。"""
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            return
        if not isinstance(data, dict):
            return
        schedule = data.get("autoRestart")
        if not isinstance(schedule, dict):
            return

        enabled = schedule.get("enabled")
        interval = schedule.get("intervalHours")
        if isinstance(enabled, bool):
            self.enabled = enabled
        if (
            isinstance(interval, (int, float))
            and not isinstance(interval, bool)
            and SCHEDULE_MIN_HOURS <= interval <= SCHEDULE_MAX_HOURS
        ):
            self.interval_hours = float(interval)

    def _arm(self, now: float) -> None:
        """从 now 起重新计算下一次重启时刻；构造阶段之外调用方须持有 self.lock。"""
        self.next_at = now + self.interval_hours * 3600 if self.enabled else None

    def _save(self) -> None:
        """原子落盘：先写临时文件再改名，控制台中途退出也不会留下半截文件。"""
        payload = {
            "autoRestart": {
                "enabled": self.enabled,
                "intervalHours": self.interval_hours,
            }
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(str(self.path) + ".tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        os.replace(temporary, self.path)

    def view(self) -> dict:
        with self.lock:
            return {
                "enabled": self.enabled,
                "intervalHours": self.interval_hours,
                "nextRestartAt": (
                    int(self.next_at * 1000) if self.next_at is not None else None
                ),
            }

    def summary(self) -> str | None:
        """一行中文状态，写进各账号日志与终端；未启用时返回 None。"""
        with self.lock:
            if not self.enabled or self.next_at is None:
                return None
            return (
                f"定时重启已启用：每 {self.interval_hours:g} 小时，"
                f"下次 {format_when(self.next_at)}"
            )

    def update(self, enabled: bool, interval_hours: float) -> dict:
        """应用页面提交的设置并立即重新计时；落盘失败时回滚内存状态并向上抛出。"""
        with self.lock:
            previous = (self.enabled, self.interval_hours, self.next_at)
            self.enabled = enabled
            self.interval_hours = interval_hours
            self._arm(time.time())
            try:
                self._save()
            except OSError as error:
                self.enabled, self.interval_hours, self.next_at = previous
                raise RuntimeError(f"保存定时重启设置失败：{error}") from error
        return self.view()

    def take_due(self) -> float | None:
        """到点则把下次时刻顺延一个周期并返回间隔；未到点或未启用返回 None。"""
        with self.lock:
            if not self.enabled or self.next_at is None:
                return None
            now = time.time()
            if now < self.next_at:
                return None
            # 先顺延再返回：重启耗时再久也不会在同一轮里被重复触发
            self.next_at = now + self.interval_hours * 3600
            return self.interval_hours


def broadcast_log(accounts: AccountManager, text: str, level: str = "info") -> int:
    """给每个账号各写一条控制台日志，页面切到哪个账号都能看到；返回写入条数。"""
    try:
        targets = list(accounts.accounts.values())
    except RuntimeError:
        # 账号清单正在增删，跳过这一条提示即可
        return 0
    for account in targets:
        account.logs.append(level, text, title="[Console]")
    return len(targets)


def restart_scheduler(accounts: AccountManager, schedule: RestartSchedule) -> None:
    """后台轮询到点重启全部账号；复用 Supervisor 的重启锁，连点/撞车都不会叠加进程。"""
    while True:
        time.sleep(SCHEDULE_TICK_SECONDS)
        interval = schedule.take_due()
        if interval is None:
            continue

        broadcast_log(accounts, f"定时重启到点（每 {interval:g} 小时），正在重新启动任务进程")
        try:
            targets = list(accounts.accounts.values())
        except RuntimeError:
            continue

        for account in targets:
            if not account.restart():
                account.logs.append(
                    "warn", "定时重启跳过：该账号正在重新启动中", title="[Console]"
                )


class Handler(BaseHTTPRequestHandler):
    accounts: AccountManager
    web_page: Path
    schedule: RestartSchedule

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

    def _proxy(self, account: Account, action: str, body: bytes | None) -> None:
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
        status, data = account.control.request(action, payload, timeout)
        self._send_json(status, data)

    @staticmethod
    def _split_account_rest(path: str) -> tuple[str | None, str]:
        """从 /api/accounts/<账号名>/<子路径> 拆出账号名与子路径。"""
        if not path.startswith(ACCOUNT_PREFIX):
            return None, ""
        head, _, rest = path[len(ACCOUNT_PREFIX) :].partition("/")
        return unquote(head), rest

    def _parse_log_query(self, query: dict[str, list[str]]) -> dict:
        def first(name: str, default: str = "") -> str:
            values = query.get(name, [])
            return values[0].strip() if values else default

        try:
            after = int(first("after", "0"))
        except ValueError:
            after = 0
        try:
            limit = int(first("limit", "0"))
        except ValueError:
            limit = 0
        levels = {level.strip() for level in first("level").split(",") if level.strip()}
        return {
            "after": after,
            "limit": limit,
            "levels": levels or None,
            "title": first("title"),
            "keyword": first("keyword"),
        }

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

        if path == "/api/schedule":
            self._send_json(200, self.schedule.view())
            return

        if path == "/api/accounts":
            self._send_json(
                200,
                {"accounts": [account.status() for account in self.accounts.accounts.values()]},
            )
            return

        if path == "/api/avatar":
            self._serve_avatar(parse_qs(url.query).get("url", [""])[0])
            return

        if path.startswith(ACCOUNT_PREFIX):
            name, rest = self._split_account_rest(path)
            account = self.accounts.get(name)
            if account is None:
                self._send_json(404, {"error": f"账号不存在：{name}"})
                return

            if rest == "status":
                self._send_json(200, account.status())
                return

            if rest == "logs":
                query = self._parse_log_query(parse_qs(url.query))
                self._send_json(
                    200,
                    account.logs.since(
                        query["after"],
                        query["limit"],
                        levels=query["levels"],
                        title=query["title"],
                        keyword=query["keyword"],
                    ),
                )
                return

            if rest in PROXY_GET:
                self._proxy(account, PROXY_GET[rest], None)
                return

        self._send_json(404, {"error": "Not Found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path

        if path == "/api/schedule":
            body = self._read_body()
            if body is None:
                self._send_json(400, {"error": "请求体长度不合法"})
                return
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except (ValueError, UnicodeDecodeError):
                self._send_json(400, {"error": "请求体不是合法的 JSON"})
                return
            if not isinstance(payload, dict):
                self._send_json(400, {"error": "请求体必须是 JSON 对象"})
                return

            enabled = payload.get("enabled")
            hours = payload.get("intervalHours")
            if not isinstance(enabled, bool):
                self._send_json(400, {"error": "enabled 必须是布尔值"})
                return
            if (
                not isinstance(hours, (int, float))
                or isinstance(hours, bool)
                or not (SCHEDULE_MIN_HOURS <= hours <= SCHEDULE_MAX_HOURS)
            ):
                self._send_json(
                    400,
                    {
                        "error": f"intervalHours 须在 "
                        f"{SCHEDULE_MIN_HOURS}~{SCHEDULE_MAX_HOURS} 之间"
                    },
                )
                return

            try:
                data = self.schedule.update(enabled, float(hours))
            except RuntimeError as error:
                self._send_json(500, {"error": str(error)})
                return

            text = self.schedule.summary() or "定时重启已关闭"
            broadcast_log(self.accounts, f"定时重启设置已更新：{text}")
            self._send_json(200, data)
            return

        if path == "/api/accounts":
            body = self._read_body()
            if body is None:
                self._send_json(400, {"error": "请求体长度不合法"})
                return
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except (ValueError, UnicodeDecodeError):
                self._send_json(400, {"error": "请求体不是合法的 JSON"})
                return
            if not isinstance(payload, dict):
                self._send_json(400, {"error": "请求体必须是 JSON 对象"})
                return

            name = payload.get("name")
            if not isinstance(name, str) or not name.strip():
                self._send_json(400, {"error": "缺少账号名"})
                return
            cookie = payload.get("cookie")
            account = self.accounts.create(name.strip(), cookie if isinstance(cookie, str) else "")
            if account is None:
                self._send_json(400, {"error": "账号名非法或已存在，或目录已被占用"})
                return
            account.start()
            self._send_json(201, account.status())
            return

        if path.startswith(ACCOUNT_PREFIX):
            name, rest = self._split_account_rest(path)
            account = self.accounts.get(name)
            if account is None:
                self._send_json(404, {"error": f"账号不存在：{name}"})
                return

            if rest == "restart":
                if account.restart():
                    self._send_json(202, {"accepted": True})
                else:
                    self._send_json(409, {"error": "正在重新启动"})
                return

            if rest in PROXY_POST:
                body = self._read_body()
                if body is None:
                    self._send_json(400, {"error": "请求体长度不合法"})
                    return
                self._proxy(account, PROXY_POST[rest], body)
                return

        self._send_json(404, {"error": "Not Found"})

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path

        if path.startswith(ACCOUNT_PREFIX):
            name, rest = self._split_account_rest(path)
            if rest != "":
                self._send_json(404, {"error": "Not Found"})
                return
            if not self.accounts.remove(name):
                self._send_json(404, {"error": f"账号不存在：{name}"})
                return
            self._send_json(200, {"removed": name})
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

    accounts = AccountManager(args.node, script)
    accounts.ensure_default()
    accounts.scan()
    schedule = RestartSchedule(SCHEDULE_FILE)
    Handler.accounts = accounts
    Handler.web_page = web_page
    Handler.schedule = schedule
    for account in accounts.accounts.values():
        account.start()

    summary = schedule.summary()
    if summary and broadcast_log(accounts, summary) == 0:
        # 一个账号都没有时也要让终端看到设置已生效
        print_line("info", "[Console]", summary)
    threading.Thread(
        target=restart_scheduler, args=(accounts, schedule), daemon=True
    ).start()

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    server.daemon_threads = True
    print(f"控制台：http://0.0.0.0:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        for account in accounts.accounts.values():
            account.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
