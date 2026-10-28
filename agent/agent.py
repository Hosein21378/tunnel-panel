#!/usr/bin/env python3
"""
Tunnel Agent - ایجنت سبک تونل
فقط با کتابخانه استاندارد پایتون کار می‌کند (بدون نیاز به pip install).

وظایف:
  - ثبت و heartbeat به پنل و گرفتن کانفیگ تونل‌ها
  - Forward TCP/UDP: گوش دادن روی پورت و فوروارد مستقیم به مقصد
  - Reverse: اگر این سرور پشت NAT است، به سرور عمومی وصل می‌شود و ترافیک را به سرویس لوکال می‌رساند
           اگر این سرور عمومی است، پورت ورودی و پورت رله (Relay) را باز می‌کند

اجرا:
  python3 agent.py --panel http://PANEL:8080 --token NODE_TOKEN [--relay-port 10000]
یا با متغیر محیطی: PANEL_URL, NODE_TOKEN, RELAY_PORT
"""
import argparse
import asyncio
import json
import os
import platform
import socket
import sys
import urllib.request
import urllib.error

VERSION = "1.0.0"
POOL_SIZE = 5  # تعداد کانکشن آماده برای هر تونل ریورس


# ---------------- HTTP ساده به پنل (در ترد جدا تا loop بلاک نشود) ----------------
class PanelClient:
    def __init__(self, base, token):
        self.base = base.rstrip("/")
        self.token = token

    def _request(self, method, path, body=None):
        url = self.base + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("X-Node-Token", self.token)
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode() or "{}")

    async def call(self, method, path, body=None):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, lambda: self._request(method, path, body))


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return ""


# ---------------- آمار ترافیک ----------------
class Stats:
    def __init__(self):
        self.data = {}  # tunnel_id -> {in,out,conn}

    def add(self, tid, direction, n):
        d = self.data.setdefault(tid, {"in": 0, "out": 0, "conn": 0})
        d[direction] += n

    def connection(self, tid):
        self.add(tid, "conn", 1)

    def drain(self):
        """برگرداندن دلتا و صفر کردن شمارنده‌ها"""
        out = [{"tunnel_id": tid, "bytes_in": v["in"], "bytes_out": v["out"],
                "connections": v["conn"], "running": True}
               for tid, v in self.data.items() if v["in"] or v["out"] or v["conn"]]
        self.data = {}
        return out


stats = Stats()


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, tid=None, direction=None):
    total = 0
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            total += len(chunk)
            writer.write(chunk)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.CancelledError):
        pass
    finally:
        if tid and direction and total:
            stats.add(tid, direction, total)
        try:
            writer.close()
        except Exception:
            pass


# ---------------- Forward TCP ----------------
async def handle_forward_tcp(tunnel, reader, writer):
    tid = tunnel["id"]
    try:
        up_r, up_w = await asyncio.open_connection(tunnel["target_host"], tunnel["target_port"])
    except Exception as e:
        print(f"[t{tid}] connect to target failed: {e}", flush=True)
        writer.close()
        return
    stats.connection(tid)
    await asyncio.gather(
        pipe(reader, up_w, tid, "in"),
        pipe(up_r, writer, tid, "out"),
    )


# ---------------- Forward UDP ----------------
class UDPUpstream(asyncio.DatagramProtocol):
    def __init__(self, main, client_addr):
        self.main = main
        self.client_addr = client_addr
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        stats.add(self.main.tunnel["id"], "out", len(data))
        if self.main.transport:
            self.main.transport.sendto(data, self.client_addr)

    def error_received(self, exc):
        pass


class UDPListener(asyncio.DatagramProtocol):
    def __init__(self, tunnel):
        self.tunnel = tunnel
        self.transport = None
        self.sessions = {}  # client_addr -> (transport, last_seen_task)

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        tid = self.tunnel["id"]
        stats.add(tid, "in", len(data))
        session = self.sessions.get(addr)
        if session is None or session[0].is_closing():
            loop = asyncio.get_running_loop()
            coro = loop.create_datagram_endpoint(
                lambda: UDPUpstream(self, addr),
                remote_addr=(self.tunnel["target_host"], self.tunnel["target_port"]))
            task = asyncio.ensure_future(self._open_session(addr, coro, data))
            self.sessions[addr] = (None, task)
            stats.connection(tid)
        else:
            session[0].sendto(data)

    async def _open_session(self, addr, coro, first_data):
        try:
            transport, proto = await coro
            self.sessions[addr] = (transport, None)
            transport.sendto(first_data)
        except Exception as e:
            print(f"[udp t{self.tunnel['id']}] upstream failed: {e}", flush=True)
            self.sessions.pop(addr, None)


# ---------------- Reverse: سمت سرور عمومی (Source) ----------------
class RelayHub:
    """روی relay_port گوش می‌دهد؛ ایجنت‌های پشت NAT اینجا وصل می‌شوند"""
    def __init__(self):
        self.pools = {}   # tunnel_id -> asyncio.Queue[(reader, writer)]
        self.tokens = {}  # tunnel_id -> token (از کانفیگ listenها پر می‌شود)

    def pool(self, tid):
        if tid not in self.pools:
            self.pools[tid] = asyncio.Queue()
        return self.pools[tid]

    async def handle_agent(self, reader, writer):
        peer = writer.get_extra_info("peername")
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=10)
            info = json.loads(line.decode())
            tid = int(info.get("tunnel_id", 0))
            if self.tokens.get(tid) != info.get("token") or not tid:
                print(f"[relay] auth failed from {peer}", flush=True)
                writer.close()
                return
            await self.pool(tid).put((reader, writer))
        except Exception:
            try:
                writer.close()
            except Exception:
                pass

    async def get_connection(self, tid, timeout=6):
        q = self.pool(tid)
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return None
            try:
                reader, writer = await asyncio.wait_for(q.get(), timeout=remaining)
            except asyncio.TimeoutError:
                return None
            if not writer.is_closing():
                return reader, writer


relay_hub = RelayHub()


async def handle_reverse_client(tunnel, reader, writer):
    tid = tunnel["id"]
    conn = await relay_hub.get_connection(tid)
    if not conn:
        print(f"[t{tid}] no idle agent connection (is destination agent online?)", flush=True)
        writer.close()
        return
    up_r, up_w = conn
    try:
        hello = {"type": "connect", "target_host": tunnel["target_host"],
                 "target_port": tunnel["target_port"]}
        up_w.write((json.dumps(hello) + "\n").encode())
        await up_w.drain()
    except Exception:
        writer.close(); up_w.close()
        return
    stats.connection(tid)
    await asyncio.gather(
        pipe(reader, up_w, tid, "in"),
        pipe(up_r, writer, tid, "out"),
    )


# ---------------- Reverse: سمت سرور پشت NAT (Destination) ----------------
async def reverse_worker(tunnel):
    """یک کانکشن آماده نگه می‌دارد؛ وقتی دستور connect آمد به سرویس لوکال وصل می‌شود"""
    tid = tunnel["id"]
    while True:
        try:
            r, w = await asyncio.open_connection(tunnel["relay_host"], tunnel["relay_port"])
            reg = {"type": "register", "tunnel_id": tid, "token": tunnel["token"]}
            w.write((json.dumps(reg) + "\n").encode())
            await w.drain()
            line = await r.readline()  # منتظر دستور connect می‌ماند
            if not line:
                w.close()
                await asyncio.sleep(3)  # رله هنوز آماده نیست (کانفیگ نگرفته) - کمی صبر و تلاش مجدد
                continue
            cmd = json.loads(line.decode())
            if cmd.get("type") != "connect":
                w.close()
                continue
            try:
                local_r, local_w = await asyncio.open_connection(
                    cmd["target_host"], int(cmd["target_port"]))
            except Exception as e:
                print(f"[reverse t{tid}] local connect failed: {e}", flush=True)
                w.close()
                continue
            await asyncio.gather(pipe(r, local_w), pipe(local_r, w))
        except asyncio.CancelledError:
            raise
        except Exception:
            await asyncio.sleep(5)  # بک‌آف و تلاش مجدد


# ---------------- مدیریت سرویس‌ها بر اساس کانفیگ پنل ----------------
class ServiceManager:
    def __init__(self):
        self.running = {}  # key -> (signature, [tasks/servers])

    @staticmethod
    def _sig(obj):
        return json.dumps(obj, sort_keys=True)

    async def _stop(self, key):
        sig, handles = self.running.pop(key, (None, []))
        for h in handles:
            if isinstance(h, asyncio.Server):
                h.close()
            elif isinstance(h, asyncio.Task):
                h.cancel()
            elif hasattr(h, "close"):  # transport UDP
                h.close()

    async def apply(self, config):
        desired = {}

        for t in config.get("listen", []):
            desired[f"listen-{t['id']}"] = t
        for t in config.get("reverse_connect", []):
            desired[f"rev-{t['id']}"] = t

        # حذف/تغییرکرده‌ها
        for key in list(self.running.keys()):
            if key not in desired or self.running[key][0] != self._sig(desired[key]):
                await self._stop(key)

        # به‌روزرسانی توکن‌های رله از روی listenهای ریورس
        relay_hub.tokens = {t["id"]: t["token"] for t in config.get("listen", []) if t["type"] == "reverse"}

        for key, t in desired.items():
            if key in self.running:
                continue
            handles = []
            try:
                if key.startswith("listen-"):
                    if t["type"] == "reverse":
                        srv = await asyncio.start_server(
                            lambda r, w, tt=t: handle_reverse_client(tt, r, w),
                            "0.0.0.0", t["listen_port"])
                        handles.append(srv)
                        if t["protocol"] in ("tcp",):
                            pass
                    else:
                        if t["protocol"] in ("tcp", "both"):
                            srv = await asyncio.start_server(
                                lambda r, w, tt=t: handle_forward_tcp(tt, r, w),
                                "0.0.0.0", t["listen_port"])
                            handles.append(srv)
                        if t["protocol"] in ("udp", "both"):
                            loop = asyncio.get_running_loop()
                            transport, _ = await loop.create_datagram_endpoint(
                                lambda tt=t: UDPListener(tt), local_addr=("0.0.0.0", t["listen_port"]))
                            handles.append(transport)
                    print(f"[+] tunnel {t['id']} '{t.get('type')}' listening on :{t['listen_port']} -> {t['target_host']}:{t['target_port']}", flush=True)
                else:
                    for _ in range(POOL_SIZE):
                        handles.append(asyncio.ensure_future(reverse_worker(t)))
                    print(f"[+] reverse tunnel {t['id']}: connecting to relay {t['relay_host']}:{t['relay_port']}", flush=True)
                self.running[key] = (self._sig(t), handles)
            except Exception as e:
                print(f"[!] failed to start {key}: {e}", flush=True)
                for h in handles:
                    try:
                        h.close() if hasattr(h, "close") else h.cancel()
                    except Exception:
                        pass


async def main():
    ap = argparse.ArgumentParser(description="Tunnel Agent")
    ap.add_argument("--panel", default=os.getenv("PANEL_URL", ""))
    ap.add_argument("--token", default=os.getenv("NODE_TOKEN", ""))
    ap.add_argument("--relay-port", type=int, default=int(os.getenv("RELAY_PORT", "10000")))
    ap.add_argument("--poll", type=int, default=int(os.getenv("POLL_INTERVAL", "10")))
    args = ap.parse_args()
    if not args.panel or not args.token:
        print("Usage: agent.py --panel http://PANEL:8080 --token TOKEN", file=sys.stderr)
        sys.exit(2)

    client = PanelClient(args.panel, args.token)
    manager = ServiceManager()

    # سرور رله (برای وقتی این نود سرور عمومی یک تونل ریورس است)
    relay_server = await asyncio.start_server(relay_hub.handle_agent, "0.0.0.0", args.relay_port)
    print(f"[*] Tunnel Agent v{VERSION} | panel={args.panel} | relay :{args.relay_port}", flush=True)

    info = {"hostname": socket.gethostname(), "ip": local_ip(), "version": VERSION,
            "os_info": f"{platform.system()} {platform.release()} / {socket.gethostname()}",
            "relay_port": args.relay_port}
    while True:
        try:
            await client.call("POST", "/api/agent/register", info)
            break
        except Exception as e:
            print(f"[!] register failed ({e}); retry in 5s ...", flush=True)
            await asyncio.sleep(5)

    while True:
        try:
            config = await client.call("GET", "/api/agent/config")
            await manager.apply(config)
            await client.call("POST", "/api/agent/heartbeat", {**info, "stats": stats.drain()})
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[!] sync error: {e}", flush=True)
        await asyncio.sleep(max(3, args.poll))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
