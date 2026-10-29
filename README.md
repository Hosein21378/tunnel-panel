# 🚇 Tunnel Panel v2 — پنل مدیریت تونل (تک‌باینری، بدون وابستگی)

نسخه بازنویسی‌شده پنل تونل به زبان Go: **یک فایل باینری استاتیک** برای پنل و ایجنت.
نه پایتون می‌خواهد، نه pip، نه هیچ پکیجی — مشکل خطاهای نصب نسخه قبلی (DNS/PyPI) در این نسخه وجود ندارد.

| | |
|---|---|
| **نصب پنل و ایجنت** | با یک لینک + منوی تعاملی (به سبک Kariz) |
| **Forward Tunnel** | فوروارد مستقیم پورت، TCP و UDP |
| **Reverse Tunnel** | دسترسی به سرور پشت NAT از طریق سرور عمومی (TCP) |
| **پنل وب فارسی** | داشبورد، سرورها، تونل‌ها، کاربران، مانیتورینگ ترافیک |
| **دیتا** | فایل JSON کنار باینری — بدون دیتابیس خارجی |

## 🚀 نصب پنل (یک لینک)

روی سرور (به‌صورت root) اجرا کنید:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Hosein21378/tunnel-panel/main/scripts/tpanel.sh)
```

بدون آرگومان، **منوی تعاملی** باز می‌شود: نصب پنل، اتصال ایجنت، وضعیت، لاگ‌ها، تغییر رمز، حذف.

بعد از نصب پنل، دفعات بعد فقط کافی است تایپ کنید: `tpanel-manager`

در پایان نصب، آدرس پنل و رمز ادمین نمایش داده می‌شود (رمز در `/etc/tpanel/panel.env` هم ذخیره می‌شود).

نصب مستقیم بدون منو:
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Hosein21378/tunnel-panel/main/scripts/tpanel.sh) panel install --port 8080
```

## 🖥️ اتصال سرورها (ایجنت)

۱. در پنل از تب «سرورها» یک سرور بسازید — پنل دستور نصب ایجنت را می‌دهد:

```bash
bash <(curl -fsSL http://PANEL:8080/manager.sh) agent --panel http://PANEL:8080 --token XXXX
```

باینری ایجنت از **خود پنل** دانلود می‌شود (نه از گیت‌هاب)، سرویس `tpanel-agent` ساخته می‌شود و سرور در پنل آنلاین می‌شود.

## ⌨️ دستورات منیجر

```bash
tpanel-manager                        # منو
tpanel-manager panel install          # نصب/آپدیت پنل
tpanel-manager panel password         # ریست رمز ادمین
tpanel-manager panel logs             # لاگ پنل
tpanel-manager agent logs             # لاگ ایجنت
tpanel-manager status                 # وضعیت سرور و سرویس‌ها
tpanel-manager panel uninstall        # حذف پنل (دیتا نگه داشته می‌شود)
tpanel-manager agent uninstall        # حذف ایجنت
```

## 🔀 ساخت تونل

از پنل وب: نوع Forward یا Reverse، سرور مبدا، پورت ورودی، مقصد (`Host:Port`)، پورت مقصد — و در صورت نیاز سقف ترافیک و تاریخ انقضا.

> پورت‌های لازم در فایروال: پورت پنل (پیش‌فرض 8080)، پورت ورودی هر تونل، و پورت Relay (پیش‌فرض 10000) روی سرور عمومی.

## 🛠️ توسعه

```bash
go build -o bin/tpanel-linux-amd64 .          # باینری amd64
GOARCH=arm64 go build -o bin/tpanel-linux-arm64 .
./bin/tpanel-linux-amd64 panel --port 8080 --data /tmp/data.json
./bin/tpanel-linux-amd64 agent --panel http://127.0.0.1:8080 --token TOKEN
```

ساختار: `main.go` (ورودی و دستورات)، `panel.go` (API و وب)، `agent.go` (تونل‌ها)، `store.go` (دیتا و امنیت)، `web/` (رابط وب)، `manager.sh` و `scripts/tpanel.sh` (نصب‌کننده)، `bin/` (باینری‌های آماده).
