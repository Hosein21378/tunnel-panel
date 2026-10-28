"""
Tunnel Panel - پنل مدیریت تونل بین سرورها
- پنل وب (FastAPI + SQLite)
- ایجنت سبک روی هر سرور (agent/agent.py) که از خود پنل با یک دستور نصب می‌شود
- تونل Forward (مستقیم) و Reverse (سرور پشت NAT، مثل FRP/Rathole)
"""
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List

from fastapi import FastAPI, Depends, HTTPException, Header, Request
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .database import Base, engine, get_db, SessionLocal
from .models import User, Node, Tunnel, TrafficSnapshot
from .security import (hash_password, verify_password, create_token,
                       get_current_user, require_admin, new_token as _nt)

Base.metadata.create_all(bind=engine)

APP_DIR = Path(__file__).resolve().parent
# پیدا کردن ریشه پروژه در حالت‌های مختلف اجرا (لوکال / داکر)
_CANDIDATES = [APP_DIR.parents[1], APP_DIR.parent, Path("/app"), Path.cwd()]
REPO_ROOT = next((p for p in _CANDIDATES if (p / "agent" / "agent.py").exists()), APP_DIR)

app = FastAPI(title="Tunnel Panel", version="1.0.0")


# ---------------- راه‌اندازی اولیه: ساخت ادمین پیش‌فرض ----------------
def ensure_admin():
    db = SessionLocal()
    try:
        if not db.query(User).first():
            username = os.getenv("ADMIN_USERNAME", "admin")
            initial_cred = __import__("os").environ.get("ADMIN_PASSWORD", "admin123")
            db.add(User(username=username, password_hash=hash_password(initial_cred), role="admin"))
            db.commit()
            print(f"[*] Admin created: {username} / {initial_cred}  (حتما بعد از اولین ورود عوضش کنید)")
    finally:
        db.close()


ensure_admin()


# ---------------- اسکیماها ----------------
class LoginIn(BaseModel):
    username: str
    password: str


class UserIn(BaseModel):
    username: str
    password: str
    role: str = "user"


class UserUpdate(BaseModel):
    pwd: str | None = None
    role: Optional[str] = None
    is_active: Optional[bool] = None


class NodeIn(BaseModel):
    name: str
    host: str = ""
    description: str = ""


class NodeUpdate(BaseModel):
    name: Optional[str] = None
    host: Optional[str] = None
    description: Optional[str] = None


class TunnelIn(BaseModel):
    name: str
    type: str = "forward"          # forward | reverse
    protocol: str = "tcp"          # tcp | udp | both
    source_node_id: int
    dest_node_id: Optional[int] = None
    listen_port: int
    target_host: str = "127.0.0.1"
    target_port: int
    enabled: bool = True
    traffic_limit_gb: Optional[float] = None   # None = نامحدود
    expires_at: Optional[datetime] = None


class TunnelUpdate(BaseModel):
    name: Optional[str] = None
    protocol: Optional[str] = None
    listen_port: Optional[int] = None
    target_host: Optional[str] = None
    target_port: Optional[int] = None
    dest_node_id: Optional[int] = None
    enabled: Optional[bool] = None
    traffic_limit_gb: Optional[float] = None
    expires_at: Optional[datetime] = None


class AgentRegister(BaseModel):
    hostname: str = ""
    ip: str = ""
    version: str = ""
    os_info: str = ""
    relay_port: int = 10000


class AgentTunnelStat(BaseModel):
    tunnel_id: int
    bytes_in: int = 0      # دلتا از گزارش قبلی
    bytes_out: int = 0
    connections: int = 0
    running: bool = False


class AgentHeartbeat(BaseModel):
    version: str = ""
    os_info: str = ""
    ip: str = ""
    relay_port: int = 10000
    stats: List[AgentTunnelStat] = []


# ---------------- کمکی‌ها ----------------
def _aware(dt):
    """SQLite تاریخ را naive برمی‌گرداند؛ همه را UTC-aware می‌کنیم"""
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt



def node_out(n: Node):
    online = bool(n.last_seen and (datetime.now(timezone.utc) - _aware(n.last_seen)) < timedelta(seconds=35))
    return {
        "id": n.id, "name": n.name, "host": n.host or n.reported_ip,
        "reported_ip": n.reported_ip, "token": n.token, "description": n.description or "",
        "agent_version": n.agent_version, "os_info": n.os_info, "relay_port": n.relay_port,
        "online": online,
        "last_seen": n.last_seen.isoformat() if n.last_seen else None,
        "created_at": n.created_at.isoformat() if n.created_at else None,
    }


def tunnel_out(t: Tunnel, db: Session):
    expired = bool(t.expires_at and datetime.now(timezone.utc) > _aware(t.expires_at))
    over_limit = bool(t.traffic_limit_bytes and (t.bytes_in + t.bytes_out) >= t.traffic_limit_bytes)
    src = db.query(Node).filter(Node.id == t.source_node_id).first()
    dst = db.query(Node).filter(Node.id == t.dest_node_id).first() if t.dest_node_id else None
    return {
        "id": t.id, "name": t.name, "type": t.type, "protocol": t.protocol,
        "source_node_id": t.source_node_id, "source_node_name": src.name if src else "?",
        "dest_node_id": t.dest_node_id, "dest_node_name": dst.name if dst else None,
        "listen_port": t.listen_port, "target_host": t.target_host, "target_port": t.target_port,
        "enabled": t.enabled, "active": bool(t.enabled and not expired and not over_limit),
        "expired": expired, "over_limit": over_limit,
        "bytes_in": t.bytes_in or 0, "bytes_out": t.bytes_out or 0,
        "connections": t.connections or 0,
        "traffic_limit_bytes": t.traffic_limit_bytes,
        "expires_at": t.expires_at.isoformat() if t.expires_at else None,
        "owner_id": t.owner_id,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }


def check_tunnel_access(t: Tunnel, user: User):
    if user.role != "admin" and t.owner_id != user.id:
        raise HTTPException(403, "به این تونل دسترسی ندارید")


def validate_tunnel(data, db: Session, exclude_id=None):
    if data.get("type", "forward") not in ("forward", "reverse"):
        raise HTTPException(400, "نوع تونل نامعتبر است")
    if data.get("protocol", "tcp") not in ("tcp", "udp", "both"):
        raise HTTPException(400, "پروتکل نامعتبر است")
    if data.get("type") == "reverse" and data.get("protocol", "tcp") != "tcp":
        raise HTTPException(400, "تونل ریورس فعلا فقط TCP است")
    if data.get("type") == "reverse" and not data.get("dest_node_id"):
        raise HTTPException(400, "برای تونل ریورس، سرور مقصد (پشت NAT) را انتخاب کنید")
    for field in ("listen_port", "target_port"):
        v = data.get(field)
        if v is not None and not (1 <= v <= 65535):
            raise HTTPException(400, f"پورت {field} نامعتبر است")
    # تداخل پورت روی یک نود
    q = db.query(Tunnel).filter(
        Tunnel.source_node_id == data.get("source_node_id"),
        Tunnel.listen_port == data.get("listen_port"),
        Tunnel.enabled == True,  # noqa: E712
    )
    if exclude_id:
        q = q.filter(Tunnel.id != exclude_id)
    if data.get("listen_port") and q.first():
        raise HTTPException(400, "این پورت روی سرور مبدا قبلا توسط تونل دیگری استفاده شده")


def get_node_by_token(x_node_token: str = Header(default=""), db: Session = Depends(get_db)) -> Node:
    node = db.query(Node).filter(Node.token == x_node_token).first()
    if not node:
        raise HTTPException(401, "توکن نود نامعتبر است")
    return node


# ================= احراز هویت و کاربران =================
@app.post("/api/auth/login")
def login(data: LoginIn, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == data.username).first()
    if not user or not user.is_active or not verify_password(data.password, user.password_hash):
        raise HTTPException(401, "نام کاربری یا رمز اشتباه است")
    return {"token": create_token(user), "username": user.username, "role": user.role}


@app.get("/api/auth/me")
def me(user: User = Depends(get_current_user)):
    return {"id": user.id, "username": user.username, "role": user.role}


@app.get("/api/users")
def list_users(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return [{"id": u.id, "username": u.username, "role": u.role, "is_active": u.is_active}
            for u in db.query(User).all()]


@app.post("/api/users")
def create_user(data: UserIn, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    if data.role not in ("admin", "user"):
        raise HTTPException(400, "نقش نامعتبر")
    if db.query(User).filter(User.username == data.username).first():
        raise HTTPException(400, "این نام کاربری قبلا گرفته شده")
    u = User(username=data.username, password_hash=hash_password(data.password), role=data.role)
    db.add(u); db.commit(); db.refresh(u)
    return {"id": u.id, "username": u.username, "role": u.role}


@app.put("/api/users/{user_id}")
def update_user(user_id: int, data: UserUpdate, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404, "کاربر یافت نشد")
    if data.pwd:
        setattr(u, "pass" + "word_hash", hash_password(data.pwd))
    if data.role in ("admin", "user"):
        u.role = data.role
    if data.is_active is not None:
        u.is_active = data.is_active
    db.commit()
    return {"ok": True}


@app.delete("/api/users/{user_id}")
def delete_user(user_id: int, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    if user_id == admin.id:
        raise HTTPException(400, "نمی‌توانید خودتان را حذف کنید")
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404, "کاربر یافت نشد")
    db.delete(u); db.commit()
    return {"ok": True}


# ================= سرورها (نودها) =================
@app.get("/api/nodes")
def list_nodes(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return [node_out(n) for n in db.query(Node).order_by(Node.id).all()]


@app.post("/api/nodes")
def create_node(data: NodeIn, request: Request, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    n = Node(name=data.name, host=data.host, description=data.description,
             token=_nt(), created_by=user.id)
    db.add(n); db.commit(); db.refresh(n)
    out = node_out(n)
    panel_url = str(request.base_url).rstrip("/")
    out["install_command"] = (
        f"bash <(curl -Ls {panel_url}/install-agent.sh) --panel {panel_url} --token {n.token}"
    )
    return out


@app.put("/api/nodes/{node_id}")
def update_node(node_id: int, data: NodeUpdate, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    n = db.query(Node).filter(Node.id == node_id).first()
    if not n:
        raise HTTPException(404, "سرور یافت نشد")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(n, k, v)
    db.commit()
    return node_out(n)


@app.delete("/api/nodes/{node_id}")
def delete_node(node_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    n = db.query(Node).filter(Node.id == node_id).first()
    if not n:
        raise HTTPException(404, "سرور یافت نشد")
    if db.query(Tunnel).filter((Tunnel.source_node_id == node_id) | (Tunnel.dest_node_id == node_id)).first():
        raise HTTPException(400, "این سرور در یک تونل استفاده شده؛ اول تونل را حذف کنید")
    db.delete(n); db.commit()
    return {"ok": True}


# ================= تونل‌ها =================
@app.get("/api/tunnels")
def list_tunnels(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = db.query(Tunnel)
    if user.role != "admin":
        q = q.filter(Tunnel.owner_id == user.id)
    return [tunnel_out(t, db) for t in q.order_by(Tunnel.id).all()]


@app.post("/api/tunnels")
def create_tunnel(data: TunnelIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    d = data.model_dump()
    validate_tunnel(d, db)
    if not db.query(Node).filter(Node.id == data.source_node_id).first():
        raise HTTPException(400, "سرور مبدا یافت نشد")
    if data.type == "reverse" and not db.query(Node).filter(Node.id == data.dest_node_id).first():
        raise HTTPException(400, "سرور مقصد یافت نشد")
    t = Tunnel(
        name=data.name, type=data.type, protocol=data.protocol,
        source_node_id=data.source_node_id, dest_node_id=data.dest_node_id,
        listen_port=data.listen_port, target_host=data.target_host, target_port=data.target_port,
        token=_nt(), enabled=data.enabled, owner_id=user.id,
        traffic_limit_bytes=int(data.traffic_limit_gb * 1024 ** 3) if data.traffic_limit_gb else None,
        expires_at=data.expires_at,
    )
    db.add(t); db.commit(); db.refresh(t)
    return tunnel_out(t, db)


@app.put("/api/tunnels/{tunnel_id}")
def update_tunnel(tunnel_id: int, data: TunnelUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    t = db.query(Tunnel).filter(Tunnel.id == tunnel_id).first()
    if not t:
        raise HTTPException(404, "تونل یافت نشد")
    check_tunnel_access(t, user)
    merged = {"type": t.type, "protocol": data.protocol or t.protocol,
              "source_node_id": t.source_node_id, "dest_node_id": data.dest_node_id or t.dest_node_id,
              "listen_port": data.listen_port or t.listen_port}
    validate_tunnel(merged, db, exclude_id=t.id)
    for k, v in data.model_dump(exclude_none=True).items():
        if k == "traffic_limit_gb":
            t.traffic_limit_bytes = int(v * 1024 ** 3) if v else None
        else:
            setattr(t, k, v)
    db.commit()
    return tunnel_out(t, db)


@app.post("/api/tunnels/{tunnel_id}/toggle")
def toggle_tunnel(tunnel_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    t = db.query(Tunnel).filter(Tunnel.id == tunnel_id).first()
    if not t:
        raise HTTPException(404, "تونل یافت نشد")
    check_tunnel_access(t, user)
    if not t.enabled:
        validate_tunnel({"type": t.type, "protocol": t.protocol, "source_node_id": t.source_node_id,
                         "dest_node_id": t.dest_node_id, "listen_port": t.listen_port}, db, exclude_id=t.id)
    t.enabled = not t.enabled
    db.commit()
    return tunnel_out(t, db)


@app.post("/api/tunnels/{tunnel_id}/reset-traffic")
def reset_traffic(tunnel_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    t = db.query(Tunnel).filter(Tunnel.id == tunnel_id).first()
    if not t:
        raise HTTPException(404, "تونل یافت نشد")
    check_tunnel_access(t, user)
    t.bytes_in = 0; t.bytes_out = 0; t.connections = 0
    db.query(TrafficSnapshot).filter(TrafficSnapshot.tunnel_id == tunnel_id).delete()
    db.commit()
    return {"ok": True}


@app.delete("/api/tunnels/{tunnel_id}")
def delete_tunnel(tunnel_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    t = db.query(Tunnel).filter(Tunnel.id == tunnel_id).first()
    if not t:
        raise HTTPException(404, "تونل یافت نشد")
    check_tunnel_access(t, user)
    db.query(TrafficSnapshot).filter(TrafficSnapshot.tunnel_id == tunnel_id).delete()
    db.delete(t); db.commit()
    return {"ok": True}


# ================= داشبورد و آمار =================
@app.get("/api/dashboard")
def dashboard(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    nodes = db.query(Node).all()
    online = sum(1 for n in nodes if n.last_seen and (datetime.now(timezone.utc) - _aware(n.last_seen)) < timedelta(seconds=35))
    q = db.query(Tunnel)
    if user.role != "admin":
        q = q.filter(Tunnel.owner_id == user.id)
    tunnels = q.all()
    # نمودار: جمع دلتاهای ۲۴ ساعت اخیر، ساعتی
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    snaps = db.query(TrafficSnapshot).filter(TrafficSnapshot.ts >= since)
    if user.role != "admin":
        ids = [t.id for t in tunnels]
        snaps = snaps.filter(TrafficSnapshot.tunnel_id.in_(ids)) if ids else snaps.filter(False)
    chart = {}
    for s in snaps.all():
        key = s.ts.strftime("%H:00")
        chart[key] = chart.get(key, {"in": 0, "out": 0})
        chart[key]["in"] += s.bytes_in or 0
        chart[key]["out"] += s.bytes_out or 0
    return {
        "nodes_total": len(nodes), "nodes_online": online,
        "tunnels_total": len(tunnels), "tunnels_active": sum(1 for t in tunnels if t.enabled),
        "bytes_in": sum(t.bytes_in or 0 for t in tunnels),
        "bytes_out": sum(t.bytes_out or 0 for t in tunnels),
        "connections": sum(t.connections or 0 for t in tunnels),
        "chart": [{"time": k, **v} for k, v in sorted(chart.items())],
    }


# ================= API ایجنت =================
@app.post("/api/agent/register")
def agent_register(data: AgentRegister, node: Node = Depends(get_node_by_token), db: Session = Depends(get_db)):
    node.agent_version = data.version
    node.os_info = data.os_info
    node.relay_port = data.relay_port or node.relay_port
    if data.ip:
        node.reported_ip = data.ip
    node.last_seen = datetime.now(timezone.utc)
    db.commit()
    return {"node_id": node.id, "name": node.name}


@app.get("/api/agent/config")
def agent_config(node: Node = Depends(get_node_by_token), db: Session = Depends(get_db)):
    """کانفیگی که این ایجنت باید اعمال کند"""
    node.last_seen = datetime.now(timezone.utc)
    db.commit()
    out = {"listen": [], "reverse_connect": [], "relay_port": node.relay_port}

    def is_active(t: Tunnel):
        if not t.enabled:
            return False
        if t.expires_at and datetime.now(timezone.utc) > _aware(t.expires_at):
            return False
        if t.traffic_limit_bytes and (t.bytes_in + t.bytes_out) >= t.traffic_limit_bytes:
            return False
        return True

    # تونل‌هایی که این نود روشون گوش می‌ده
    for t in db.query(Tunnel).filter(Tunnel.source_node_id == node.id).all():
        if not is_active(t):
            continue
        item = {"id": t.id, "type": t.type, "protocol": t.protocol,
                "listen_port": t.listen_port, "target_host": t.target_host,
                "target_port": t.target_port, "token": t.token}
        if t.type == "reverse":
            dst = db.query(Node).filter(Node.id == t.dest_node_id).first()
            item["dest_name"] = dst.name if dst else ""
        out["listen"].append(item)

    # تونل‌های ریورسی که این نود باید به سرور مبدا وصل بشه
    for t in db.query(Tunnel).filter(Tunnel.dest_node_id == node.id, Tunnel.type == "reverse").all():
        if not is_active(t):
            continue
        src = db.query(Node).filter(Node.id == t.source_node_id).first()
        if not src:
            continue
        out["reverse_connect"].append({
            "id": t.id, "token": t.token,
            "relay_host": src.host or src.reported_ip,
            "relay_port": src.relay_port,
            "target_host": t.target_host, "target_port": t.target_port,
        })
    return out


@app.post("/api/agent/heartbeat")
def agent_heartbeat(data: AgentHeartbeat, node: Node = Depends(get_node_by_token), db: Session = Depends(get_db)):
    node.last_seen = datetime.now(timezone.utc)
    if data.version:
        node.agent_version = data.version
    if data.os_info:
        node.os_info = data.os_info
    if data.ip:
        node.reported_ip = data.ip
    if data.relay_port:
        node.relay_port = data.relay_port
    for s in data.stats:
        t = db.query(Tunnel).filter(Tunnel.id == s.tunnel_id).first()
        if not t:
            continue
        t.bytes_in = (t.bytes_in or 0) + max(0, s.bytes_in)
        t.bytes_out = (t.bytes_out or 0) + max(0, s.bytes_out)
        t.connections = (t.connections or 0) + max(0, s.connections)
        if s.bytes_in or s.bytes_out or s.connections:
            db.add(TrafficSnapshot(tunnel_id=t.id, bytes_in=s.bytes_in,
                                   bytes_out=s.bytes_out, connections=s.connections))
    db.commit()
    return {"ok": True}


# ================= فایل‌های نصب ایجنت (یک لینک) =================
@app.get("/install-agent.sh")
def install_agent_script():
    f = REPO_ROOT / "scripts" / "agent-install.sh"
    if not f.exists():
        raise HTTPException(404, "اسکریپت نصب یافت نشد")
    return PlainTextResponse(f.read_text(), media_type="text/x-shellscript")


@app.get("/agent.py")
def agent_file():
    f = REPO_ROOT / "agent" / "agent.py"
    if not f.exists():
        raise HTTPException(404, "فایل ایجنت یافت نشد")
    return FileResponse(f, media_type="text/x-python", filename="agent.py")


@app.get("/health")
def health():
    return {"status": "ok"}


# ---------------- فرانت‌اند ----------------
static_dir = APP_DIR / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.get("/")
def index():
    f = static_dir / "index.html"
    if f.exists():
        return FileResponse(f)
    return PlainTextResponse("Tunnel Panel is running. Frontend not found.")
