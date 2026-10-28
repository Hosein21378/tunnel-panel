import os
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

SECRET_KEY = os.getenv("SECRET_KEY", "")
if not SECRET_KEY or SECRET_KEY == "change-me":
    # در پروداکشن حتما SECRET_KEY را در .env ست کنید
    SECRET_KEY = "dev-insecure-secret-" + secrets.token_hex(8)
    print("[!] WARNING: SECRET_KEY is not set in env; using a random one. Sessions will reset on restart.")

ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = int(os.getenv("TOKEN_EXPIRE_HOURS", "24"))
bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except Exception:
        return False


def create_token(user) -> str:
    payload = {
        "sub": str(user.id),
        "username": user.username,
        "role": user.role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=TOKEN_EXPIRE_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(bearer)):
    if not credentials:
        raise HTTPException(401, "لاگین لازم است")
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        raise HTTPException(401, "توکن نامعتبر یا منقضی شده")
    # import دیرهنگام برای جلوگیری از حلقه
    from .database import SessionLocal
    from .models import User
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.id == int(payload["sub"])).first()
        if not user or not user.is_active:
            raise HTTPException(401, "کاربر یافت نشد یا غیرفعال است")
        db.expunge(user)
        return user
    finally:
        db.close()


def require_admin(user=Depends(get_current_user)):
    if user.role != "admin":
        raise HTTPException(403, "فقط ادمین دسترسی دارد")
    return user


def new_token() -> str:
    return secrets.token_urlsafe(32)
