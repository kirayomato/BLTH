#!/usr/bin/env python3
"""独立运行版的 Web 控制台。

控制台是常驻进程，任务进程是它拉起的子进程。重启因此是一次进程替换：
停止旧进程会连同在途请求一起结束，新进程从磁盘重新读取配置和 cookie 并全量运行任务。
配置页面由控制台提供，重启期间不会断线。

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
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
MAX_RECORDS = 1000

# Logger 的前缀形如 BLTH[2026/11/10 11:00:00][Standalone][DailyTask]:，冒号之后是正文
LOGGER_PREFIX = re.compile(r"^BLTH\[[^\]]*\]((?:\[[^\]]*\])*):")
# Node 的 console.warn / console.error 都走 stderr，只能按文本区分严重程度
ERROR_HINTS = ("出错", "失败", "错误", "error", "Error")


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
        text = line[match.end():].strip() if match else line.strip()

        with self.lock:
            self.records.append({
                "seq": self.next_seq,
                "time": int(time.time() * 1000),
                "level": level,
                "title": title,
                "text": text,
            })
            self.next_seq += 1

    def since(self, after: int) -> dict:
        with self.lock:
            return {
                "session": self.session,
                "records": [record for record in self.records if record["seq"] > after],
            }


class Supervisor:
    """管理任务进程的生命周期，并把它的输出汇进日志缓冲。"""

    def __init__(self, command: list[str], cwd: Path, logs: LogBuffer) -> None:
        self.command = command
        self.cwd = cwd
        self.logs = logs
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
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    **kwargs,
                )
            except OSError as error:
                self.logs.append("error", f"任务进程启动失败：{error}", title="[Console]")
                return False

            self.process = process
            self.started_at = time.time()
            self.exit_code = None
            self.readers = [
                threading.Thread(target=self._reader, args=(stream, level), daemon=True)
                for stream, level in ((process.stdout, "info"), (process.stderr, "stderr"))
            ]
            self.waiter = threading.Thread(target=self._waiter, args=(process,), daemon=True)

        self.logs.append("info", f"任务进程已启动（PID {process.pid}）", title="[Console]")
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
                level = "info"
                if stream_level == "stderr":
                    level = "error" if any(hint in line for hint in ERROR_HINTS) else "warn"
                self.logs.append(level, line)
        finally:
            stream.close()

    def _waiter(self, process: subprocess.Popen) -> None:
        code = process.wait()
        with self.lock:
            # 新进程已经接替时，旧进程的退出不该改掉当前状态
            if self.process is process:
                self.exit_code = code
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

        if not process or process.poll() is not None:
            return

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

    def log_message(self, _format: str, *_args: object) -> None:
        # 访问日志会混进终端输出，这里保持安静
        pass

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, data: object) -> None:
        self._send(
            status,
            json.dumps(data, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def do_GET(self) -> None:
        url = urlparse(self.path)

        if url.path in ("/", "/index.html"):
            self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")
            return

        if url.path == "/api/logs":
            try:
                after = int(parse_qs(url.query).get("after", ["0"])[0])
            except ValueError:
                after = 0
            self._send_json(200, self.logs.since(after))
            return

        if url.path == "/api/status":
            self._send_json(200, self.supervisor.status())
            return

        self._send_json(404, {"error": "Not Found"})

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/restart":
            self._send_json(404, {"error": "Not Found"})
            return

        if self.supervisor.try_restart():
            self._send_json(202, {"accepted": True})
        else:
            self._send_json(409, {"error": "正在重新启动"})


PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BLTH 控制台</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 24px; background: #f6f7f9; color: #1f2328;
         font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .sub { color: #656d76; margin-bottom: 20px; }
  .card { background: #fff; border: 1px solid #d8dee4; border-radius: 8px;
          padding: 16px; margin-bottom: 16px; }
  .row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .status { font-weight: 600; }
  .status.ok { color: #1a7f37; }
  .status.bad { color: #cf222e; }
  button { padding: 8px 16px; border: 1px solid #cf222e; border-radius: 6px;
           background: #fff; color: #cf222e; cursor: pointer; font-size: 14px; }
  button:hover { background: #fff5f5; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  #logs { background: #fff; border: 1px solid #d8dee4; border-radius: 8px;
          height: 60vh; overflow: auto; padding: 12px;
          font: 12px/1.7 Consolas, "Cascadia Mono", monospace; white-space: pre-wrap; }
  .line { border-bottom: 1px solid #f0f1f3; padding: 1px 0; }
  .line.warn { color: #9a6700; }
  .line.error { color: #cf222e; }
</style>
</head>
<body>
<h1>BLTH 控制台</h1>
<div class="sub">任务进程由控制台拉起；重新启动会停止当前进程、重读配置与 cookie 后全量重跑。</div>
<div class="card">
  <div class="row">
    <span id="status" class="status">连接中…</span>
    <button id="restart">重新启动任务进程</button>
  </div>
</div>
<div id="logs"></div>
<script>
let lastSeq = 0;
let session = '';
const view = document.getElementById('logs');
const statusEl = document.getElementById('status');
const btn = document.getElementById('restart');

function render(records) {
  for (const rec of records) {
    const div = document.createElement('div');
    div.className = 'line ' + rec.level;
    const clock = new Date(rec.time).toLocaleTimeString('zh-CN', { hour12: false });
    div.textContent = '[' + clock + '] ' + (rec.title || '[Console]') + ' ' + rec.text;
    view.appendChild(div);
    lastSeq = Math.max(lastSeq, rec.seq);
  }
  while (view.childElementCount > 1000) view.removeChild(view.firstChild);
  view.scrollTop = view.scrollHeight;
}

async function pollLogs() {
  try {
    const response = await fetch('/api/logs?after=' + lastSeq, { cache: 'no-store' });
    if (response.ok) {
      const data = await response.json();
      if (data.session !== session) {
        session = data.session;
        view.innerHTML = '';
        lastSeq = 0;
      }
      render(data.records);
    }
  } catch (error) { /* 控制台重启期间保留序号，下一轮再试 */ }
  setTimeout(pollLogs, 1000);
}

async function pollStatus() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    const data = await response.json();
    if (data.running) {
      const since = new Date(data.startedAt).toLocaleTimeString('zh-CN', { hour12: false });
      statusEl.textContent = '运行中 · PID ' + data.pid + ' · 启动于 ' + since;
      statusEl.className = 'status ok';
    } else {
      statusEl.textContent = '已停止 · 退出码 ' + data.exitCode;
      statusEl.className = 'status bad';
    }
  } catch (error) {
    statusEl.textContent = '控制台不可用';
    statusEl.className = 'status bad';
  }
  setTimeout(pollStatus, 2000);
}

btn.onclick = async () => {
  if (!confirm('停止当前任务进程并重新启动：重新读取配置与 cookie，全部任务重新运行。')) return;
  btn.disabled = true;
  try {
    const response = await fetch('/api/restart', { method: 'POST' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      alert(data.error || ('HTTP ' + response.status));
    }
  } catch (error) {
    alert('请求失败：' + error.message);
  }
  setTimeout(() => { btn.disabled = false; }, 1500);
};

pollLogs();
pollStatus();
</script>
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="BLTH 独立运行版 Web 控制台")
    parser.add_argument("--node", default=shutil.which("node") or "node", help="Node 可执行文件")
    parser.add_argument(
        "--script",
        default=str(ROOT / "dist-standalone" / "blth-standalone.mjs"),
        help="任务进程入口",
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
        print(f"找不到任务进程产物：{script}\n请先执行 npm run build-standalone", file=sys.stderr)
        return 1

    logs = LogBuffer()
    supervisor = Supervisor([args.node, str(script)], ROOT, logs)
    Handler.supervisor = supervisor
    Handler.logs = logs
    supervisor.start()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"控制台：http://127.0.0.1:{args.port}", flush=True)
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
