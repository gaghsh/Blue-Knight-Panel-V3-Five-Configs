# Blue Knight Panel - Five VLESS WS TLS Configs

این نسخه پنج کانفیگ **VLESS / WS / TLS** با پنج UUID متمایز تولید می‌کند.

## اجرا

```bash
npm install
npm start
```

پورت پیش‌فرض `3000` است و متغیرهای زیر قابل تنظیم‌اند:

- `PORT` یا `SERVER_PORT`
- `DOMAIN`
- `FORCE_PORT` (پیش‌فرض برای HTTPS روی 443)
- `FORCE_HTTPS=true`
- `UUIDS=uuid1,uuid2,uuid3,uuid4,uuid5`
- `TLS_CERT`
- `TLS_KEY`
- `XRAY_PORT`

UUIDها هنگام اولین اجرا در `bk-data/uuids.json` ذخیره می‌شوند، بنابراین با راه‌اندازی مجدد تغییر نمی‌کنند. برای ساخت مجدد UUIDها، این فایل را حذف کنید.

## خروجی‌ها

- `/` صفحه و لیست لینک‌ها
- `/api/configs` خروجی JSON
- `/subscription` سابسکریپشن base64
- `/xray.json` قالب inbound برای Xray با پنج کلاینت

هر کانفیگ یک UUID و یک مسیر WebSocket متفاوت دارد:

```text
/vless-ws-tls/1
/vless-ws-tls/2
/vless-ws-tls/3
/vless-ws-tls/4
/vless-ws-tls/5
```

برای اتصال واقعی، `Xray-core` یا جایگزین سازگار باید روی پورت مشخص‌شده اجرا شود و گواهی TLS معتبر یا خودامضای موردنظر تنظیم گردد.
