# ۱. مرز سرویس‌ها و ماژول‌ها

سیستم به‌صورت **Modular Monolith** با NestJS، TypeScript و PostgreSQL پیاده‌سازی می‌شود.

ماژول‌ها:

1. **Wallet:** مدیریت کیف پول کاربران و موجودی‌های قابل استفاده و رزروشده.
2. **Ledger:** ثبت تمام رویدادهای مالی با ساختار Double-entry و Immutable.
3. **Deposit:** مدیریت درخواست‌های واریز و تأیید پرداخت از طریق PSP.
4. **Withdrawal:** مدیریت برداشت، رزرو موجودی، کنترل سقف روزانه و تسویه.
5. **Payment Integration:** ارتباط با سرویس‌های خارجی PSP و Payout از طریق Adapter.
6. **Idempotency:** جلوگیری از اجرای چندباره درخواست‌های مالی.
7. **Outbox:** ثبت رویدادها برای ارسال مطمئن و غیرهم‌زمان.

عملیات افزایش یا کاهش دستی موجودی از طریق API داخلی انجام می‌شود و ثبت مالی آن مستقیماً در Ledger صورت می‌گیرد؛ ماژول یا جدول جداگانه‌ای برای Adjustment نداریم.

Reconciliation در محدوده نسخه اولیه نیست.

# ۲. مدل داده

## ۱. wallets

نگهداری موجودی فعلی کاربران.

| ستون | نوع | توضیح |
|---|---|---|
| id | UUID | کلید اصلی |
| user_id | UUID | شناسه کاربر |
| currency | VARCHAR(10) | IRR یا USDT |
| available_balance | NUMERIC(20,6) | موجودی قابل استفاده |
| reserved_balance | NUMERIC(20,6) | موجودی رزروشده |
| created_at | TIMESTAMPTZ | زمان ایجاد |
| updated_at | TIMESTAMPTZ | زمان به‌روزرسانی |

**محدودیت‌ها:**
- UNIQUE(user_id, currency)
- available_balance و reserved_balance نباید منفی باشند.
- موجودی IRR باید عدد صحیح باشد.
- برای جلوگیری از برداشت هم‌زمان بیش از موجودی، از Row-Level Lock استفاده می‌شود.

**ایندکس‌ها:**
- Unique Index روی (user_id, currency) که با قید UNIQUE ایجاد می‌شود.

## ۲. ledger_entries

ثبت تاریخچه تمام رویدادهای مالی با ساختار Double-entry.

| ستون | نوع | توضیح |
|---|---|---|
| id | UUID | کلید اصلی |
| transaction_id | UUID | شناسه مشترک رکوردهای یک تراکنش مالی |
| account_code | VARCHAR(50) | کد حساب |
| related_user_id | UUID | کاربر مرتبط با عملیات |
| reference_type | VARCHAR(50) | نوع مرجع مانند DEPOSIT یا WITHDRAWAL |
| reference_id | VARCHAR(100) | شناسه عملیات مرتبط |
| amount | NUMERIC(20,6) | مبلغ |
| currency | VARCHAR(10) | واحد پول |
| entry_type | VARCHAR(10) | DEBIT یا CREDIT |
| created_by_type | VARCHAR(20) | SYSTEM یا MANAGER |
| created_by_id | UUID | شناسه ایجادکننده |
| description | TEXT | توضیحات |
| created_at | TIMESTAMPTZ | زمان ثبت |

**محدودیت‌ها:**
- amount باید بزرگ‌تر از صفر باشد.
- entry_type فقط DEBIT یا CREDIT باشد.
- مجموع DEBIT و CREDIT هر transaction_id در هر ارز باید برابر باشد.
- هر تراکنش حداقل دو Entry داشته باشد.
- رکوردهای Ledger قابل ویرایش یا حذف نیستند؛ اصلاح از طریق ثبت تراکنش معکوس انجام می‌شود.

**ایندکس‌ها:**
- transaction_id
- (account_code, currency)
- (reference_type, reference_id)
- (related_user_id, created_at)

**توضیح Account:**

Account یک مفهوم حسابداری است و جدول مستقلی ندارد. حساب‌ها با account_code مشخص می‌شوند.

کدهای حساب نمونه:
- USER_WALLET: موجودی کاربران
- PSP_CLEARING: حساب واسط واریز از درگاه
- PAYOUT_CLEARING: حساب واسط برداشت
- BANK_ACCOUNT: حساب بانکی
- ADJUSTMENT_EXPENSE: حساب تعدیلات دستی

برای حساب‌های کاربران، related_user_id مشخص می‌کند حساب متعلق به کدام کاربر است. حساب‌های سیستمی به کاربر خاصی تعلق ندارند.

رکوردهای مربوط به یک رویداد مالی با transaction_id مشترک گروه‌بندی می‌شوند. جدول جداگانه‌ای برای Journal نداریم.

## ۳. deposits

مدیریت درخواست‌های واریز.

| ستون | نوع | توضیح |
|---|---|---|
| id | UUID | کلید اصلی |
| user_id | UUID | شناسه کاربر |
| amount | NUMERIC(20,6) | مبلغ |
| currency | VARCHAR(10) | ارز |
| status | VARCHAR(20) | وضعیت واریز |
| psp_token | VARCHAR(255) | توکن درگاه |
| created_at | TIMESTAMPTZ | زمان ایجاد |
| updated_at | TIMESTAMPTZ | زمان به‌روزرسانی |

**محدودیت‌ها:**
- amount بزرگ‌تر از صفر باشد.
- psp_token در صورت وجود UNIQUE باشد.
- وضعیت‌های نهایی SUCCEEDED و FAILED هستند؛ وضعیت PENDING برای درخواست‌های در حال پردازش استفاده می‌شود.

**ایندکس‌ها:**
- (user_id, created_at)
- Unique Index روی psp_token در صورت وجود مقدار.

**چرخه واریز:**
- هنگام ایجاد درخواست، وضعیت PENDING است و موجودی Wallet تغییر نمی‌کند.
- پس از تأیید پرداخت PSP، موجودی Wallet افزایش پیدا می‌کند، Ledger ثبت می‌شود و وضعیت به SUCCEEDED تغییر می‌کند.
- در صورت شکست قطعی، وضعیت FAILED می‌شود و موجودی تغییر نمی‌کند.

## ۴. withdrawals

مدیریت درخواست‌های برداشت.

| ستون | نوع | توضیح |
|---|---|---|
| id | UUID | کلید اصلی |
| user_id | UUID | شناسه کاربر |
| amount | NUMERIC(20,6) | مبلغ |
| currency | VARCHAR(10) | ارز |
| destination | VARCHAR(255) | شماره شبا یا آدرس کیف پول |
| status | VARCHAR(20) | وضعیت برداشت |
| provider_request_id | VARCHAR(100) | شناسه درخواست ارسالی به Payout |
| created_at | TIMESTAMPTZ | زمان ایجاد |
| updated_at | TIMESTAMPTZ | زمان به‌روزرسانی |

**محدودیت‌ها:**
- amount بزرگ‌تر از صفر باشد.
- provider_request_id در صورت وجود UNIQUE باشد.
- وضعیت‌های نهایی SUCCEEDED و FAILED هستند. وضعیت‌های میانی مانند PENDING و UNKNOWN برای مدیریت چرخه برداشت استفاده می‌شوند.

**ایندکس‌ها:**
- (user_id, created_at)
- Unique Index روی provider_request_id در صورت وجود مقدار.

**چرخه برداشت:**

۱. هنگام ثبت درخواست، در یک تراکنش دیتابیس:
- موجودی Wallet قفل و بررسی می‌شود.
- سقف برداشت روزانه بررسی می‌شود.
- موجودی قابل استفاده کاهش و موجودی رزروشده افزایش پیدا می‌کند.
- رکورد Withdrawal با وضعیت PENDING ایجاد می‌شود.
- ثبت رزرو در Ledger انجام می‌شود.
- مقدار برداشت روزانه به‌روزرسانی می‌شود.

۲. پس از تأیید موفق Payout:
- موجودی رزروشده کاهش پیدا می‌کند.
- ثبت تسویه در Ledger انجام می‌شود.
- وضعیت Withdrawal به SUCCEEDED تغییر می‌کند.

۳. در صورت شکست قطعی Payout:
- مبلغ رزروشده به موجودی قابل استفاده برمی‌گردد.
- ثبت معکوس در Ledger انجام می‌شود.
- مقدار برداشت روزانه اصلاح می‌شود.
- وضعیت Withdrawal به FAILED تغییر می‌کند.

۴. در صورت Timeout یا نامشخص بودن نتیجه:
- مبلغ رزروشده باقی می‌ماند.
- وضعیت در حالت UNKNOWN یا انتظار بررسی باقی می‌ماند.
- تا مشخص شدن نتیجه، مبلغ در سقف برداشت روزانه محاسبه می‌شود.

## ۵. idempotency_keys

جلوگیری از اجرای چندباره درخواست‌های مالی.

| ستون | نوع | توضیح |
|---|---|---|
| id | UUID | کلید اصلی |
| scope | VARCHAR(100) | محدوده درخواست |
| key | VARCHAR(255) | کلید Idempotency |
| request_hash | VARCHAR(64) | هش محتوای درخواست |
| response | JSONB | پاسخ ذخیره‌شده |
| status | VARCHAR(20) | وضعیت پردازش |
| created_at | TIMESTAMPTZ | زمان ایجاد |

**محدودیت‌ها:**
- UNIQUE(scope, key)
- وضعیت‌ها: IN_PROGRESS، COMPLETED و FAILED.
- استفاده مجدد از کلید با محتوای متفاوت باید خطا برگرداند.
- درخواست تکراری نباید باعث اجرای دوباره عملیات مالی شود.

## ۶. daily_withdrawal_usage

نگهداری مجموع برداشت روزانه کاربران برای کنترل سقف برداشت.

| ستون | نوع | توضیح |
|---|---|---|
| user_id | UUID | شناسه کاربر |
| currency | VARCHAR(10) | واحد پول |
| usage_date | DATE | تاریخ |
| total_amount | NUMERIC(20,6) | مجموع برداشت‌های روزانه |

**محدودیت‌ها:**
- کلید اصلی ترکیبی (user_id, currency, usage_date).
- total_amount نباید منفی باشد.
- سقف ۲۰۰ میلیون تومان برای برداشت ریالی اعمال می‌شود.
- بررسی و به‌روزرسانی این جدول داخل همان Database Transaction مربوط به Withdrawal انجام می‌شود.
- برای جلوگیری از Race Condition، رکورد روزانه قفل می‌شود.
- در صورت شکست قطعی برداشت، مقدار مربوط به آن از مجموع برداشت روزانه کسر می‌شود.
- در صورت نامشخص بودن نتیجه Payout، مبلغ همچنان در سقف محاسبه می‌شود.

**ایندکس‌ها:**
- Primary Key روی (user_id, currency, usage_date).

این جدول ماژول یا سرویس مستقلی ندارد و مسئولیت آن با ماژول Withdrawal است.

## ۷. outbox_events

ثبت رویدادهایی که باید پس از Commit شدن تراکنش دیتابیس به سرویس‌های دیگر ارسال شوند.

| ستون | نوع | توضیح |
|---|---|---|
| id | UUID | کلید اصلی |
| event_type | VARCHAR(100) | نوع رویداد |
| aggregate_id | UUID | شناسه موجودیت مرتبط |
| payload | JSONB | اطلاعات رویداد |
| status | VARCHAR(20) | وضعیت ارسال |
| retry_count | INTEGER | تعداد تلاش مجدد |
| created_at | TIMESTAMPTZ | زمان ایجاد |
| processed_at | TIMESTAMPTZ | زمان پردازش |

**محدودیت‌ها:**
- رویداد در همان تراکنش دیتابیس عملیات مالی ثبت می‌شود.
- ارسال رویداد پس از Commit انجام می‌شود.
- پردازش مجدد رویداد نباید اثر مالی تکراری ایجاد کند.

**ایندکس‌ها:**
- (status, created_at)

# ۳. قواعد یکپارچگی دیتابیس

1. تغییر موجودی Wallet و ثبت Ledger باید در یک تراکنش دیتابیس انجام شوند.
2. تمام Entryهای متعلق به یک رویداد مالی باید با transaction_id مشترک ثبت شوند.
3. مجموع DEBIT و CREDIT هر تراکنش در هر ارز باید برابر باشد.
4. Ledger غیرقابل تغییر است.
5. موجودی قابل استفاده و رزروشده نباید منفی شوند.
6. عملیات برداشت با Row-Level Lock انجام می‌شود.
7. کنترل و به‌روزرسانی سقف برداشت روزانه در همان تراکنش Withdrawal انجام می‌شود.
8. تمام درخواست‌های مالی باید Idempotent باشند.
9. شناسه درخواست Payout قبل از فراخوانی سرویس خارجی تولید و ذخیره می‌شود و در تلاش‌های مجدد ثابت می‌ماند.
10. هیچ فراخوانی سرویس خارجی درون تراکنش باز دیتابیس انجام نمی‌شود.
11. PostgreSQL منبع اصلی و معتبر اطلاعات مالی سیستم است.
12. ثبت Entryهای Ledger باید اتمیک باشد و توازن آن‌ها پیش از Commit بررسی شود.