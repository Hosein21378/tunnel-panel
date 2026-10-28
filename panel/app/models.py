from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, BigInteger, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from .database import Base


def utcnow():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(16), default="user")  # admin | user
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=utcnow)


class Node(Base):
    """یک سرور که ایجنت روش نصبه"""
    __tablename__ = "nodes"
    id = Column(Integer, primary_key=True)
    name = Column(String(128), nullable=False)
    # آدرس عمومی سرور (IP یا دامین) - برای ساخت تونل ریورس لازم است
    host = Column(String(255), default="")
    # آی‌پی که ایجنت خودش گزارش کرده
    reported_ip = Column(String(64), default="")
    token = Column(String(64), unique=True, nullable=False, index=True)
    description = Column(Text, default="")
    agent_version = Column(String(32), default="")
    os_info = Column(String(255), default="")
    relay_port = Column(Integer, default=10000)  # پورت کنترل ریورس روی همین نود
    last_seen = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow)


class Tunnel(Base):
    __tablename__ = "tunnels"
    id = Column(Integer, primary_key=True)
    name = Column(String(128), nullable=False)
    # forward: روی source_node گوش می‌ده و مستقیم به target_host:target_port وصل می‌شه
    # reverse: روی source_node گوش می‌ده، ترافیک از طریق dest_node به target_host:target_port می‌رسه (مناسب سرور پشت NAT)
    type = Column(String(16), default="forward")  # forward | reverse
    protocol = Column(String(8), default="tcp")  # tcp | udp | both (ریورس فقط tcp)
    source_node_id = Column(Integer, ForeignKey("nodes.id"), nullable=False)
    dest_node_id = Column(Integer, ForeignKey("nodes.id"), nullable=True)  # فقط برای reverse
    listen_port = Column(Integer, nullable=False)
    target_host = Column(String(255), default="127.0.0.1")
    target_port = Column(Integer, nullable=False)
    token = Column(String(64), default="")  # توکن احراز هویت لینک ریورس بین دو ایجنت
    enabled = Column(Boolean, default=True)
    bytes_in = Column(BigInteger, default=0)
    bytes_out = Column(BigInteger, default=0)
    connections = Column(BigInteger, default=0)
    traffic_limit_bytes = Column(BigInteger, nullable=True)  # None = نامحدود
    expires_at = Column(DateTime(timezone=True), nullable=True)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow)

    source_node = relationship("Node", foreign_keys=[source_node_id])
    dest_node = relationship("Node", foreign_keys=[dest_node_id])


class TrafficSnapshot(Base):
    """نقطه‌های نمودار ترافیک (دلتای گزارش‌شده توسط ایجنت)"""
    __tablename__ = "traffic_snapshots"
    id = Column(Integer, primary_key=True)
    tunnel_id = Column(Integer, ForeignKey("tunnels.id"), index=True)
    ts = Column(DateTime(timezone=True), default=utcnow, index=True)
    bytes_in = Column(BigInteger, default=0)
    bytes_out = Column(BigInteger, default=0)
    connections = Column(BigInteger, default=0)
